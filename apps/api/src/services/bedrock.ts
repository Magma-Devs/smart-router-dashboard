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

export type BedrockAvailability = { ok: true } | { ok: false; reason: BedrockUnavailable; detail?: string };

/** A bind address nothing but this machine can reach. */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

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
  host: string = config.server.host,
): BedrockAvailability {
  if (!enabled) return { ok: false, reason: "disabled" };
  if (authMode === "enabled") return { ok: true };
  // AUTH_MODE=disabled installs no /api/* gate at all, so anyone who can reach
  // the api could spend the model budget under this identity. The opt-out is
  // for a laptop, and it is honoured only while the api listens on loopback.
  // Bound anywhere else — the 0.0.0.0 default, and every container, which has
  // to bind 0.0.0.0 for its port to be published — "anyone who can reach port
  // 8000" is a real set of people, so the flag is refused whatever it says.
  if (allowUnauthenticated && isLoopback(host)) return { ok: true };
  return allowUnauthenticated
    ? {
        ok: false,
        reason: "auth_required",
        detail: `BEDROCK_ALLOW_UNAUTHENTICATED is only honoured with API_HOST=127.0.0.1; this api listens on ${host}. Set AUTH_MODE=enabled.`,
      }
    : { ok: false, reason: "auth_required" };
}

/**
 * The answer was cut off at the token ceiling, so its JSON ends mid-object.
 *
 * Its own type because the fix is a ceiling, not a prompt. Reported as "the
 * model did not return JSON" — which is what happens if you only log it and
 * fall through to the parser — it sends whoever reads it to the wrong file.
 * Three services made exactly that mistake before this existed.
 */
export class ModelAnswerTruncated extends Error {
  constructor(
    readonly what: string,
    readonly outputTokens: number | null,
  ) {
    super(`the ${what} was cut off at the token ceiling`);
    this.name = "ModelAnswerTruncated";
  }
}

/** The model replied, but not with JSON — a refusal, or prose around nothing. */
export class ModelAnswerUnparseable extends Error {
  constructor(readonly what: string) {
    super(`the model did not return JSON for the ${what}`);
    this.name = "ModelAnswerUnparseable";
  }
}

/**
 * Turn one answer into an object, or throw the RIGHT error.
 *
 * Every caller that asks for JSON wants the same three things: truncation
 * distinguished from a refusal, a stray markdown fence tolerated even though
 * the prompt forbids it, and a parse failure that says which surface it came
 * from. Written once here rather than a fourth time.
 */
export function parseModelJson(
  answer: BedrockAnswer,
  what: string,
  logger?: BedrockLogger,
): Record<string, unknown> {
  if (answer.stopReason === "max_tokens") {
    // The opening of the answer says why it ran long — a preamble before the
    // JSON, or a JSON that never stopped — which the count alone cannot.
    logger?.warn(
      { what, outputTokens: answer.outputTokens, opening: answer.text.slice(0, 240) },
      "model answer hit the token ceiling",
    );
    throw new ModelAnswerTruncated(what, answer.outputTokens);
  }
  // Slice between the outermost braces: tolerates a fence, or a sentence the
  // model put in front of the object despite being told not to.
  const start = answer.text.indexOf("{");
  const end = answer.text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    logger?.warn({ what, text: answer.text.slice(0, 300) }, "model answer was not JSON");
    throw new ModelAnswerUnparseable(what);
  }
  try {
    return JSON.parse(answer.text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    logger?.warn({ what, text: answer.text.slice(0, 300) }, "model answer was not JSON");
    throw new ModelAnswerUnparseable(what);
  }
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
