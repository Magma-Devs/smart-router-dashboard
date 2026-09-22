/**
 * Amazon Bedrock client — the one place the dashboard calls a model.
 *
 * **No credential passes through this code.** The AWS SDK signs each request
 * with SigV4 using the default provider chain, so the identity comes from
 * wherever the process already has one:
 *
 *   env vars → shared config (`~/.aws/credentials`, what `aws configure`
 *   writes) → SSO → container credentials → EC2/EKS instance or pod role.
 *
 * One code path serves both deployments, which is the point:
 *
 *  - **Local dev** — nothing to configure. Whatever `aws configure` left in
 *    `~/.aws/credentials` is what `aws sts get-caller-identity` reports, and
 *    the SDK finds it.
 *  - **A customer's dedicated server** — `BEDROCK_ROLE_ARN` names a role to
 *    assume on top of that. The box proves who it is once (a Roles Anywhere
 *    certificate, an instance profile, a key), and the role is what it acts
 *    as. Credentials from `AssumeRole` are short-lived and the SDK refreshes
 *    them on its own; `BEDROCK_ROLE_EXTERNAL_ID` carries the confused-deputy
 *    guard when the role lives in the customer's account.
 *
 * Either way nothing here reads, stores, logs or returns a credential,
 * because nothing here ever holds one — which is what MAG-3702's bearer key
 * would have required. See `docs/BEDROCK-IAM.md`.
 *
 * Uses **Converse**, not InvokeModel: one request shape for every model, so
 * swapping the model is a config change rather than a rewrite of the body.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { config } from "../config.js";

/** Why AI is not available, in the order the checks run. */
export type BedrockUnavailable =
  /** `BEDROCK_ENABLED` is not `true`. Off by default — model calls cost money. */
  | "disabled"
  /** `AUTH_MODE=disabled`: nobody is identified, so nobody may spend the account's budget. */
  | "auth_required"
  /** Enabled and gated, but the AWS credential chain resolved nothing. */
  | "no_credentials";

export type BedrockAvailability = { ok: true } | { ok: false; reason: BedrockUnavailable };

/** A model call that failed. Carries a 502: our hop broke, not the caller's request. */
export class BedrockError extends Error {
  readonly statusCode = 502;
  constructor(
    readonly reason: string,
    /** The SDK's exception name (`ThrottlingException`, `AccessDeniedException`, …). */
    readonly awsErrorName: string | null = null,
  ) {
    super(`bedrock call failed: ${reason}`);
    this.name = "BedrockError";
  }
}

export interface BedrockAnswer {
  text: string;
  /** `end_turn`, `max_tokens`, … — `max_tokens` means the answer was cut off. */
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The slice of a pino logger this service uses. */
export interface BedrockLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The cheap half of the availability check: flags only, no network, no
 * credential resolution. Safe to call on every request.
 *
 * `authMode` is passed in rather than read from `config` so the check follows
 * the live env the auth plugin registered against, as the auth gate does.
 */
export function bedrockGate(
  authMode: string = config.auth.mode,
  enabled: boolean = config.bedrock.enabled,
): BedrockAvailability {
  if (!enabled) return { ok: false, reason: "disabled" };
  // Refused rather than trusting the /api/* gate, which AUTH_MODE=disabled
  // does not install at all. An open api would let anyone spend the account's
  // Bedrock budget under our IAM identity.
  if (authMode !== "enabled") return { ok: false, reason: "auth_required" };
  return { ok: true };
}

export class BedrockService {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly region: string = config.bedrock.region,
    private readonly model: string = config.bedrock.model,
    private readonly logger?: BedrockLogger,
    client?: BedrockRuntimeClient,
  ) {
    this.client =
      client ??
      new BedrockRuntimeClient({
        region,
        // Adaptive retry adds client-side rate limiting, which is what makes
        // a ThrottlingException back off instead of hammering.
        maxAttempts: 5,
        retryMode: "adaptive",
        requestHandler: { requestTimeout: config.bedrock.timeoutMs },
        // Omitted entirely when no role is named, so the SDK falls through to
        // its own default chain rather than being handed a wrapper around it.
        ...(config.bedrock.roleArn
          ? {
              credentials: fromTemporaryCredentials({
                params: {
                  RoleArn: config.bedrock.roleArn,
                  RoleSessionName: config.bedrock.roleSessionName,
                  ...(config.bedrock.roleExternalId
                    ? { ExternalId: config.bedrock.roleExternalId }
                    : {}),
                },
                // The base identity comes from the default chain; this only
                // says which region to reach STS in.
                clientConfig: { region },
              }),
            }
          : {}),
      });
  }

  /**
   * Does the credential chain resolve to anything? The expensive half of the
   * availability check — it can touch IMDS or the SSO cache, so it is not for
   * every request. Never returns or logs what it resolved, only whether it did.
   */
  async hasCredentials(): Promise<boolean> {
    try {
      // With BEDROCK_ROLE_ARN set this performs the AssumeRole, so a role the
      // base identity may not assume fails HERE rather than on the first real
      // call — which is what makes /api/ai/health worth asking.
      const resolved = await this.client.config.credentials();
      return Boolean(resolved?.accessKeyId);
    } catch {
      return false;
    }
  }

  /**
   * One completion. Throws `BedrockError` on any failure — callers that must
   * not half-answer let it propagate; callers that can degrade catch it.
   *
   * `maxTokens` is ALWAYS sent. Left unset it defaults to the model's maximum
   * and silently reserves far more quota than the call needs, which is the
   * usual cause of a ThrottlingException nobody can explain.
   */
  async complete(opts: {
    messages: { role: "user" | "assistant"; content: string }[];
    system?: string;
    maxTokens?: number;
  }): Promise<BedrockAnswer> {
    if (opts.messages.length === 0) throw new BedrockError("no_messages");

    const messages: Message[] = opts.messages.map((m) => ({
      role: m.role,
      content: [{ text: m.content }],
    }));

    try {
      const res = await this.client.send(
        new ConverseCommand({
          modelId: this.model,
          messages,
          ...(opts.system ? { system: [{ text: opts.system }] } : {}),
          inferenceConfig: { maxTokens: opts.maxTokens ?? config.bedrock.maxTokens },
        }),
      );

      // Concatenate every text block. A reply made only of non-text blocks
      // yields "", which the caller sees as an empty answer, not a crash.
      const text = (res.output?.message?.content ?? [])
        .map((b) => b.text)
        .filter((t): t is string => typeof t === "string")
        .join("");

      return {
        text,
        stopReason: res.stopReason ?? null,
        inputTokens: res.usage?.inputTokens ?? null,
        outputTokens: res.usage?.outputTokens ?? null,
      };
    } catch (err) {
      // The SDK's exception name is the actionable part — AccessDeniedException
      // means the IAM identity lacks bedrock:InvokeModel or the model is not
      // enabled in the region, which is a very different fix from a throttle.
      const name = err instanceof Error ? err.name : null;
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ error: message, awsErrorName: name, model: this.model, region: this.region }, "bedrock call failed");
      throw new BedrockError(message, name);
    }
  }
}
