import { ASK_LIMITS } from "@sr/shared";
import { redactAskText } from "./redact.js";

/**
 * What the reader sees of an answer still being written: at most the answer's
 * own limit, without a word still being written, credential-redacted as the
 * stored answer is. Redaction runs over the whole text each time, so a value
 * split across chunks is caught once it is whole and is never shown in part.
 */
export function draftText(
  answer: { text: string; complete: boolean },
  secrets: readonly string[],
): string {
  let text = answer.text;
  let complete = answer.complete;
  if (text.length > ASK_LIMITS.markdown) {
    text = text.slice(0, ASK_LIMITS.markdown);
    complete = false;
  }
  if (!complete) {
    const lastSpace = text.search(/\s\S*$/);
    text = lastSpace >= 0 ? text.slice(0, lastSpace) : "";
  }
  return redactAskText(text, secrets).trim();
}
