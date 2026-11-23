import { appendFileSync } from "node:fs";
import { askAnswerContentSchema } from "../../packages/shared/dist/index.js";
import { converseFromStream } from "./converse-stream.mjs";
if (process.env.E2E_ASK_LIVE !== "true" || process.env.NODE_ENV === "production")
  throw new Error("Live metadata observer requires the isolated live-check opt-in");
const target = process.env.E2E_ASK_LIVE_PROVIDER_META_FILE;
if (!target?.startsWith("/private/tmp/sr-ask-live-provider-"))
  throw new Error("Live metadata observer requires an owned temporary output");
const original = globalThis.fetch;
const known = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const fields = new Set([
  "summary",
  "sections",
  "title",
  "body",
  "points",
  "stat",
  "value",
  "label",
  "tone",
]);
const issues = (value) => {
  const result = askAnswerContentSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map((part) =>
          typeof part === "number" ? part : fields.has(part) ? part : "unknown",
        ),
      }));
};
globalThis.fetch = async (input, init) => {
  const response = await original(input, init);
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (
    url.hostname !== "bedrock-runtime.us-east-1.amazonaws.com" ||
    !(url.pathname.endsWith("/converse") || url.pathname.endsWith("/converse-stream"))
  )
    return response;
  const metadata = {
    status: response.status,
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-amzn-requestid"),
  };
  try {
    const reader = response.clone().body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024 * 1024) {
          void reader.cancel();
          throw new Error("LIMIT");
        }
        chunks.push(Buffer.from(chunk.value));
      }
    }
    const bytes = Buffer.concat(chunks);
    const raw = known(
      url.pathname.endsWith("/converse-stream")
        ? converseFromStream(bytes)
        : JSON.parse(bytes.toString("utf8")),
    );
    const message = known(known(raw.output).message);
    metadata.topLevelKeys = Object.keys(raw);
    metadata.outputKeys = Object.keys(known(raw.output));
    metadata.messageKeys = Object.keys(message);
    metadata.stopReason = [
      "end_turn",
      "tool_use",
      "max_tokens",
      "guardrail_intervened",
      "model_context_window_exceeded",
    ].includes(raw.stopReason)
      ? raw.stopReason
      : "other";
    metadata.usageKeys = Object.keys(known(raw.usage));
    const serverUsage = known(raw.usage).serverToolUsage;
    metadata.serverToolUsageType =
      serverUsage === null ? "null" : Array.isArray(serverUsage) ? "array" : typeof serverUsage;
    metadata.serverToolUsageKeys = Object.keys(known(serverUsage));
    metadata.numericServerToolUsage = Object.fromEntries(
      Object.entries(known(serverUsage)).filter(
        ([, value]) => Number.isSafeInteger(value) && value >= 0,
      ),
    );
    metadata.numericUsage = Object.fromEntries(
      Object.entries(known(raw.usage)).filter(
        ([, value]) => Number.isSafeInteger(value) && value >= 0,
      ),
    );
    metadata.blocks = Array.isArray(message.content)
      ? message.content.map((block) => ({
          text: typeof block.text === "string",
          textLength: typeof block.text === "string" ? block.text.length : undefined,
          toolUse: Boolean(block.toolUse),
          toolRequestType:
            known(block.toolUse).type === null
              ? "null"
              : known(block.toolUse).type === undefined
                ? "omitted"
                : ["tool_use", "server_tool_use", "client_tool_use", "client", "server"].includes(
                      known(block.toolUse).type,
                    )
                  ? known(block.toolUse).type
                  : "other",
          toolUseProtocolKeys: Object.keys(known(block.toolUse)),
          knownTool: ["read_customer_data", "present_answer"].includes(known(block.toolUse).name),
          presentation: known(block.toolUse).name === "present_answer",
          presentationContractValid:
            known(block.toolUse).name === "present_answer"
              ? askAnswerContentSchema.safeParse(known(block.toolUse).input).success
              : undefined,
          presentationIssues:
            known(block.toolUse).name === "present_answer"
              ? issues(known(block.toolUse).input)
              : undefined,
          inputType: typeof known(block.toolUse).input,
          reasoningContent: Boolean(block.reasoningContent),
          unknownBlockCount: Object.keys(block).filter(
            (k) => !["text", "toolUse", "reasoningContent"].includes(k),
          ).length,
        }))
      : [];
    if (raw.stopReason === "end_turn" && Array.isArray(message.content)) {
      const text = message.content
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join("");
      metadata.answer = { jsonParseable: false, fenced: /^\s*```/.test(text) };
      try {
        const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/.exec(text.trim());
        const parsed = JSON.parse(fenced ? fenced[1] : text);
        const checked = askAnswerContentSchema.safeParse(parsed);
        const fields = new Set([
          "summary",
          "sections",
          "title",
          "body",
          "points",
          "stat",
          "value",
          "label",
          "tone",
        ]);
        metadata.answer = {
          jsonParseable: true,
          fenced: Boolean(fenced),
          valid: checked.success,
          rootFields: Object.keys(known(parsed)).filter((key) => fields.has(key)),
          unknownRootFieldCount: Object.keys(known(parsed)).filter((key) => !fields.has(key))
            .length,
          sectionCount: Array.isArray(known(parsed).sections) ? parsed.sections.length : undefined,
          issues: checked.success
            ? []
            : checked.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.map((part) =>
                  typeof part === "number" ? part : fields.has(part) ? part : "unknown",
                ),
              })),
        };
      } catch {
        /* Never retain model-authored text or parse-error messages. */
      }
    }
  } catch {
    metadata.metadataUnavailable = true;
  }
  appendFileSync(target, JSON.stringify(metadata) + "\n");
  return response;
};
