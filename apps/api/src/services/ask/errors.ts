import type { AskErrorCode } from "@sr/shared";

/** Fixed public messages: provider exceptions and tool text can contain secrets. */
const messages: Record<AskErrorCode, string> = {
  ASK_DISABLED: "Ask your data is unavailable on this deployment.",
  ASK_TURNED_OFF:
    "An admin turned Ask your data off for this dashboard. You can still read your chats.",
  ASK_UNAVAILABLE: "Ask your data is temporarily unavailable.",
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

/**
 * Which check refused an answer, for the run's log line: fixed names, never the
 * answer's text, a tool input or an evidence id. The table in
 * docs/ASK-YOUR-DATA.md says what each one means.
 */
export type AskRejectReason =
  | "bad_usage"
  | "malformed_response"
  | "unexpected_stop"
  | "answer_tool_unavailable"
  | "unknown_content"
  | "history_mismatch"
  | "too_many_tool_calls"
  | "closing_call_not_alone"
  | "invalid_closing_call"
  | "conversation_with_sources"
  | "data_without_reads"
  | "unknown_evidence"
  | "empty_answer"
  | "answer_too_long"
  | "answer_contract"
  | "stored_contract";

export class AskFailure extends Error {
  constructor(
    public readonly code: AskErrorCode,
    public readonly statusCode = 503,
    public readonly reason?: AskRejectReason,
  ) {
    super(messages[code]);
    this.name = "AskFailure";
  }
}

export function abortFailure(signal?: AbortSignal): AskFailure {
  if (signal?.reason instanceof AskFailure) return signal.reason;
  return new AskFailure(
    signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "ASK_TIMEOUT"
      : "ASK_CANCELLED",
    409,
  );
}
