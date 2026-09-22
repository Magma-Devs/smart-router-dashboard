/**
 * Amazon Bedrock client — the one place the dashboard calls a model.
 *
 * Authenticated with a Bedrock API key (MAG-3702): a long-lived bearer token
 * minted for an IAM user, sent as `Authorization: Bearer <token>`. That is why
 * there is no AWS SDK here — SigV4 is not involved, and a 40-line fetch is the
 * whole protocol.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **The key never leaves the server, and is never spendable anonymously.**
 *     `availability()` refuses while `AUTH_MODE=disabled`, because an open api
 *     hands the credential to anyone who can reach it — and this one's IAM
 *     policy is `bedrock:InvokeModel` on `Resource: "*"`, so the blast radius
 *     is every model in the account. Same reasoning as `UPSTREAM_RELAY_ENABLED`.
 *  2. **Failure is never silent.** Each way this can be unavailable has its own
 *     reason string, so a caller can say which one happened instead of
 *     collapsing them into "AI is off".
 */
import { config } from "../config.js";

/** Why AI is not available, in the order the checks run. */
export type BedrockUnavailable =
  /** No `AWS_BEARER_TOKEN_BEDROCK` in the environment. */
  | "not_configured"
  /** Configured, but `AUTH_MODE=disabled` — nobody is identified, so nobody may spend it. */
  | "auth_required";

export type BedrockAvailability = { ok: true } | { ok: false; reason: BedrockUnavailable };

/** A model call that failed. Carries a 502: our hop broke, not the caller's request. */
export class BedrockError extends Error {
  readonly statusCode = 502;
  constructor(
    readonly reason: string,
    /** Upstream HTTP status, when the call reached Bedrock at all. */
    readonly upstreamStatus: number | null = null,
  ) {
    super(`bedrock call failed: ${reason}`);
    this.name = "BedrockError";
  }
}

export interface BedrockMessage {
  role: "user" | "assistant";
  content: string;
}

export interface BedrockAnswer {
  text: string;
  /** `end_turn`, `max_tokens`, … — `max_tokens` means the answer was cut off. */
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** The slice of a pino logger this service uses. Never receives the key. */
export interface BedrockLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Bedrock's own versioning header for Anthropic models — not the model version. */
const ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * Is AI available at all? Pure, cheap, and safe to call on every request —
 * it makes no network call and reads no secret beyond "is one present".
 *
 * `authMode` is passed in rather than read from `config` so the check follows
 * the live env the auth plugin registered against, the same way the auth gate
 * itself does.
 */
export function bedrockAvailability(
  authMode: string = config.auth.mode,
  apiKey: string | undefined = config.bedrock.apiKey,
): BedrockAvailability {
  if (!apiKey) return { ok: false, reason: "not_configured" };
  if (authMode !== "enabled") return { ok: false, reason: "auth_required" };
  return { ok: true };
}

export class BedrockService {
  constructor(
    private readonly apiKey: string | undefined = config.bedrock.apiKey,
    private readonly region: string = config.bedrock.region,
    private readonly model: string = config.bedrock.model,
    private readonly timeoutMs: number = config.bedrock.timeoutMs,
    private readonly logger?: BedrockLogger,
  ) {}

  /** The InvokeModel URL for this region and inference profile. */
  private get endpoint(): string {
    return `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(this.model)}/invoke`;
  }

  /**
   * One completion. Throws `BedrockError` on any failure — callers that must
   * not half-answer let it propagate; callers that can degrade catch it.
   *
   * `temperature` is deliberately NOT sent: Claude Sonnet 5 rejects it with a
   * 400, which is what MAG-3702's provisioning run hit before the parameter
   * was dropped.
   */
  async complete(opts: {
    messages: BedrockMessage[];
    system?: string;
    maxTokens?: number;
  }): Promise<BedrockAnswer> {
    if (!this.apiKey) throw new BedrockError("not_configured");
    if (opts.messages.length === 0) throw new BedrockError("no_messages");

    const body = {
      anthropic_version: ANTHROPIC_VERSION,
      max_tokens: opts.maxTokens ?? config.bedrock.maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: [{ type: "text", text: m.content }],
      })),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          // The only place the key is used. Never logged, never returned.
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        // Bedrock puts the cause in the body; keep enough to act on it. It
        // echoes the request, never the credential, so this is safe to log.
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        this.logger?.warn(
          { status: res.status, detail, model: this.model, region: this.region },
          "bedrock call failed",
        );
        throw new BedrockError(detail || `http ${res.status}`, res.status);
      }

      const parsed = (await res.json()) as {
        content?: { type?: string; text?: string }[];
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      // Concatenate every text block. A model that answered only with
      // non-text blocks yields "", which the caller sees as an empty answer
      // rather than as a crash.
      const text = (parsed.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");

      return {
        text,
        stopReason: parsed.stop_reason ?? null,
        inputTokens: parsed.usage?.input_tokens ?? null,
        outputTokens: parsed.usage?.output_tokens ?? null,
      };
    } catch (err) {
      if (err instanceof BedrockError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.warn({ error: message, model: this.model, region: this.region }, "bedrock unreachable");
      throw new BedrockError(message);
    } finally {
      clearTimeout(timer);
    }
  }
}
