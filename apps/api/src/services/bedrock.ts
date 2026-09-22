/**
 * Amazon Bedrock client — the one place the dashboard calls a model.
 *
 * **No credential passes through this code.** The AWS SDK signs each request
 * with SigV4 from the default provider chain, so the identity comes from
 * wherever the process already has one — env, `~/.aws/credentials`, SSO, a
 * container or instance role, or an IAM Roles Anywhere certificate. One code
 * path therefore serves both deployments:
 *
 *  - **Local dev** — nothing to configure beyond `aws configure`.
 *  - **A customer's dedicated server** — `BEDROCK_ROLE_ARN` names a role to
 *    assume on top of whatever the box proved itself with. Credentials from
 *    `AssumeRole` are short-lived and the SDK refreshes them by itself.
 *
 * See `docs/BEDROCK-IAM.md`.
 */
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { config } from "../config.js";

/** Why AI is unavailable. Both are flag checks — no network, no credentials. */
export type BedrockUnavailable =
  /** `BEDROCK_ENABLED` is not `true`. Off by default — model calls cost money. */
  | "disabled"
  /** `AUTH_MODE=disabled`: nobody is identified, so nobody may spend the budget. */
  | "auth_required";

export type BedrockAvailability = { ok: true } | { ok: false; reason: BedrockUnavailable };

/** A model call that failed. Carries a 502: our hop broke, not the caller's request. */
export class BedrockError extends Error {
  readonly statusCode = 502;
  constructor(
    message: string,
    /** The SDK's exception name (`ThrottlingException`, `AccessDeniedException`, …). */
    readonly awsErrorName: string | null = null,
  ) {
    super(message);
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
 * Is AI configured and allowed? Flags only, so this is genuinely instant and
 * safe on every request — it deliberately does NOT resolve credentials, which
 * blocks for seconds on IMDS when there are none.
 *
 * `authMode` is passed in rather than read from `config` so the check follows
 * the live env the auth plugin registered against, as the auth gate does.
 */
export function bedrockGate(
  authMode: string = config.auth.mode,
  enabled: boolean = config.bedrock.enabled,
  allowUnauthenticated: boolean = config.bedrock.allowUnauthenticated,
): BedrockAvailability {
  if (!enabled) return { ok: false, reason: "disabled" };
  // AUTH_MODE=disabled installs no /api/* gate at all, so anyone who can reach
  // the api could spend the model budget. Refused unless the deployment says
  // otherwise — which a laptop legitimately does, and an exposed one must not.
  if (authMode !== "enabled" && !allowUnauthenticated) {
    return { ok: false, reason: "auth_required" };
  }
  return { ok: true };
}

export class BedrockService {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly model: string = config.bedrock.model,
    private readonly logger?: BedrockLogger,
    client?: BedrockRuntimeClient,
  ) {
    this.client =
      client ??
      new BedrockRuntimeClient({
        region: config.bedrock.region,
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
                  RoleSessionName: "smart-router-dashboard",
                  ...(config.bedrock.roleExternalId
                    ? { ExternalId: config.bedrock.roleExternalId }
                    : {}),
                },
                clientConfig: { region: config.bedrock.region },
              }),
            }
          : {}),
      });
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
    if (opts.messages.length === 0) throw new BedrockError("no messages");

    try {
      const res = await this.client.send(
        new ConverseCommand({
          modelId: this.model,
          messages: opts.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
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
      // The SDK's exception name is the actionable part: AccessDeniedException
      // (policy, or the role could not be assumed), ThrottlingException (quota)
      // and an unreachable endpoint need three different fixes.
      const name = err instanceof Error ? err.name : null;
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ error: message, awsErrorName: name, model: this.model }, "bedrock call failed");
      throw new BedrockError(message, name);
    }
  }
}
