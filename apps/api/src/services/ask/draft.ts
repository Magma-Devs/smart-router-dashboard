import { ASK_LIMITS } from "@sr/shared";
import { redactAskText } from "./redact.js";

/**
 * The top-level `summary` string of a tool input the model is still writing,
 * decoded as far as it has arrived. `complete` is true once its closing quote
 * has arrived. Null while no summary value has started, or when the text so
 * far is not a JSON object prefix this reader can follow.
 */
export function summaryPrefix(json: string): { text: string; complete: boolean } | null {
  let depth = 0;
  let at = 0;
  // At depth 1: "key" reads a key next, "colon" its colon, "value" its value.
  let expect: "key" | "colon" | "value" = "key";
  let key: string | null = null;
  while (at < json.length) {
    const c = json[at]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t") {
      at++;
      continue;
    }
    if (c === '"') {
      const string = readString(json, at);
      if (depth === 1 && expect === "value" && key === "summary")
        return string ? { text: string.value, complete: string.complete } : null;
      if (!string?.complete) return null;
      if (depth === 1 && expect === "key") {
        key = string.value;
        expect = "colon";
      } else if (depth === 1 && expect === "value") expect = "key";
      at = string.end;
      continue;
    }
    if (c === "{" || c === "[") {
      if (depth === 1 && expect === "value") expect = "key";
      depth++;
      at++;
      continue;
    }
    if (c === "}" || c === "]") {
      depth--;
      if (depth < 0) return null;
      at++;
      continue;
    }
    if (depth === 1 && c === ":" && expect === "colon") expect = "value";
    else if (depth === 1 && c === ",") expect = "key";
    else if (depth === 1 && expect === "value") expect = "key";
    else if (depth === 0) return null;
    at++;
  }
  return null;
}

/** A JSON string starting at `start`: its decoded text so far, whether it
 * closed, and the index after it. An escape cut off at the end is left out. */
function readString(
  json: string,
  start: number,
): { value: string; complete: boolean; end: number } | null {
  let at = start + 1;
  let lastWhole = at;
  while (at < json.length) {
    const c = json[at]!;
    if (c === '"') return decode(json.slice(start + 1, at), true, at + 1);
    if (c === "\\") {
      const kind = json[at + 1];
      if (kind === undefined) break;
      const width = kind === "u" ? 6 : 2;
      if (at + width > json.length) break;
      at += width;
    } else at++;
    lastWhole = at;
  }
  return decode(json.slice(start + 1, lastWhole), false, json.length);
}

function decode(raw: string, complete: boolean, end: number) {
  try {
    return { value: JSON.parse(`"${raw}"`) as string, complete, end };
  } catch {
    return null;
  }
}

/**
 * What the reader sees of a summary still being written: at most the summary's
 * own limit, without a word still being written, credential-redacted as the
 * stored answer is. Redaction runs over the whole text each time, so a value
 * split across chunks is caught once it is whole and is never shown in part.
 */
export function draftText(
  summary: { text: string; complete: boolean },
  secrets: readonly string[],
): string {
  let text = summary.text;
  let complete = summary.complete;
  if (text.length > ASK_LIMITS.summary) {
    text = text.slice(0, ASK_LIMITS.summary);
    complete = false;
  }
  if (!complete) {
    const lastSpace = text.search(/\s\S*$/);
    text = lastSpace >= 0 ? text.slice(0, lastSpace) : "";
  }
  return redactAskText(text, secrets).trim();
}
