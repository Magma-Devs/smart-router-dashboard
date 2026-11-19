import type { AskErrorCode } from "@sr/shared";

/** Fixed public messages: provider exceptions and tool text can contain secrets. */
const messages: Record<AskErrorCode, string> = {
  ASK_DISABLED: "AI investigation is unavailable on this deployment.",
  ASK_TURNED_OFF:
    "An admin turned AI investigation off for this dashboard. You can still read your chats.",
  ASK_UNAVAILABLE: "AI investigation is temporarily unavailable.",
  ASK_NOT_FOUND: "This chat or question could not be found.",
  ASK_INVALID_REQUEST: "The question or page context is invalid.",
  ASK_CONFLICT: "This retry does not match the original question.",
  ASK_ACTIVE_RUN: "A question is already processing. Wait or stop it first.",
  ASK_BUDGET_LIMIT: "Your customer's question limit has been reached. Please try again next month.",
  ASK_BUDGET_BUSY: "Other questions are using the available capacity. Please try again shortly.",
  ASK_MCP_UNAVAILABLE: "Your data sources are temporarily unavailable.",
  ASK_IDENTITY_MISMATCH: "Your data connection could not be verified.",
  ASK_TOOL_DENIED: "The requested data operation is unavailable.",
  ASK_BEDROCK_UNAVAILABLE: "The answer service is temporarily unavailable.",
  ASK_INVALID_ANSWER: "The answer could not be validated. Please try a narrower question.",
  ASK_TRUNCATED: "The answer exceeded its limit. Please try a narrower question.",
  ASK_CANCELLED: "The question was stopped.",
  ASK_INTERRUPTED: "Processing was interrupted. You can ask again.",
  ASK_TIMEOUT: "The question took too long. Please try a narrower question.",
  ASK_LIMIT_REACHED: "The question exceeded its processing limit. Please try a narrower question.",
};

export class AskFailure extends Error {
  constructor(
    public readonly code: AskErrorCode,
    public readonly statusCode = 503,
  ) {
    super(messages[code]);
    this.name = "AskFailure";
  }
}

export function abortFailure(signal?: AbortSignal): AskFailure {
  return new AskFailure(
    signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "ASK_TIMEOUT"
      : "ASK_CANCELLED",
    409,
  );
}
