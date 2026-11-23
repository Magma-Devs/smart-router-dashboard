import { z } from "zod";
import type { AskSettings } from "../../config.js";
import { AskFailure } from "./errors.js";
import { EventStreamDecoder, type StreamMessage } from "./event-stream.js";
import { boundedFetch, boundedStream } from "./http.js";

export interface BedrockTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}
export interface BedrockMessage {
  role: "user" | "assistant";
  content: Array<
    | { text: string }
    | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
    | {
        toolResult: {
          toolUseId: string;
          content: Array<{ text: string }>;
          status: "success" | "error";
        };
      }
  >;
}
const count = z.number().int().nonnegative();
const usageSchema = z
  .object({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cacheReadInputTokens: count.optional(),
    cacheWriteInputTokens: count.optional(),
    cacheDetails: z
      .array(z.object({ ttl: z.enum(["5m", "1h"]), inputTokens: count }))
      .max(2)
      .optional(),
  })
  .strict();
export type BedrockUsage = z.infer<typeof usageSchema>;
const wireUsageSchema = usageSchema
  .extend({
    cacheReadInputTokenCount: count.optional(),
    cacheWriteInputTokenCount: count.optional(),
    // No server tools are requested. Only an absent/empty server-tool receipt
    // proves there is no additional, unpriced usage category to reconcile.
    serverToolUsage: z
      .union([z.object({}).strict(), z.array(z.never()).max(0)])
      .nullable()
      .optional(),
  })
  .superRefine((value, context) => {
    for (const [tokens, legacy] of [
      [value.cacheReadInputTokens, value.cacheReadInputTokenCount],
      [value.cacheWriteInputTokens, value.cacheWriteInputTokenCount],
    ]) {
      if (tokens !== undefined && legacy !== undefined && tokens !== legacy)
        context.addIssue({ code: "custom", message: "Conflicting cache usage counters" });
    }
  })
  .transform(
    ({
      cacheReadInputTokenCount,
      cacheWriteInputTokenCount,
      serverToolUsage: _serverToolUsage,
      ...value
    }) => ({
      ...value,
      ...(value.cacheReadInputTokens === undefined && cacheReadInputTokenCount !== undefined
        ? { cacheReadInputTokens: cacheReadInputTokenCount }
        : {}),
      ...(value.cacheWriteInputTokens === undefined && cacheWriteInputTokenCount !== undefined
        ? { cacheWriteInputTokens: cacheWriteInputTokenCount }
        : {}),
    }),
  );

const responseSchema = z
  .object({
    output: z.object({
      message: z.object({
        role: z.literal("assistant"),
        content: z
          .array(
            z.union([
              z.object({ text: z.string() }).strict(),
              z
                .object({
                  toolUse: z
                    .object({
                      toolUseId: z.string().min(1).max(200),
                      name: z.string().min(1).max(200),
                      input: z.record(z.string(), z.unknown()),
                      // Native client calls may carry tool_use or null.
                      // Server-tool discriminators remain rejected.
                      type: z.literal("tool_use").nullable().optional(),
                    })
                    .strict()
                    .transform(({ type: _type, ...tool }) => tool),
                })
                .strict(),
            ]),
          )
          .min(1)
          .max(32),
      }),
    }),
    stopReason: z.string(),
  })
  .passthrough();

export interface BedrockStep {
  message: BedrockMessage;
  stopReason: string;
  usage: BedrockUsage | null;
  model: string;
  region: string;
  receipt: BedrockReceipt;
}
export interface BedrockReceipt {
  requestId: string | null;
  providerStatus: number | null;
}
export interface BedrockInput {
  /** Instructions shared by every run; the prompt cache's prefix ends after them. */
  system: string;
  /** This run's own system text, sent after the cache point. */
  context?: string;
  messages: BedrockMessage[];
  tools?: BedrockTool[];
  forceTool?: boolean;
  requestMetadata?: Record<string, string>;
}

const CACHE_POINT = { cachePoint: { type: "default" } } as const;

/** Claude models on Bedrock cache a prompt prefix up to each cache point. */
export function cachesPrompt(model: string): boolean {
  return /^(?:(?:global|us|eu|apac|au|in)\.)?anthropic\.claude-/.test(model);
}

/** Three cache points: after the tools, after the shared instructions, and after
 * the newest message, so each step reads every earlier step from the cache. */
function converseBody(
  input: BedrockInput,
  maxOutputTokens: number,
  model: string,
  cache = cachesPrompt(model),
) {
  // Sonnet 5 enables adaptive thinking by default. The bounded JSON/tool
  // contract consumes text/tool blocks only, so select its documented off mode.
  const disableThinking =
    /^(?:(?:global|us|eu|apac|au|in)\.)?anthropic\.claude-sonnet-5(?:[-.:]|$)/.test(model);
  const last = input.messages.length - 1;
  return {
    system: [
      { text: input.system },
      ...(cache ? [CACHE_POINT] : []),
      ...(input.context ? [{ text: input.context }] : []),
    ],
    messages: cache
      ? input.messages.map((message, index) =>
          index === last ? { ...message, content: [...message.content, CACHE_POINT] } : message,
        )
      : input.messages,
    inferenceConfig: { maxTokens: maxOutputTokens },
    ...(disableThinking
      ? { additionalModelRequestFields: { thinking: { type: "disabled" } } }
      : {}),
    ...(input.requestMetadata ? { requestMetadata: input.requestMetadata } : {}),
    ...(input.tools?.length
      ? {
          toolConfig: {
            toolChoice: input.forceTool ? { any: {} } : { auto: {} },
            tools: [
              ...input.tools.map((tool) => ({
                toolSpec: {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: { json: tool.inputSchema },
                  ...(tool.strict ? { strict: true } : {}),
                },
              })),
              ...(cache ? [CACHE_POINT] : []),
            ],
          },
        }
      : {}),
  };
}

/** Every cache point this adapter sends asks for Bedrock's default five-minute
 * TTL, so a cache write the provider reports without a TTL breakdown is one. */
function withRequestedCacheTtl(usage: BedrockUsage): BedrockUsage {
  const writes = usage.cacheWriteInputTokens ?? 0;
  if (writes === 0 || usage.cacheDetails?.length) return usage;
  return { ...usage, cacheDetails: [{ ttl: "5m", inputTokens: writes }] };
}

/** No automatic model retries: a timed-out invocation may already be billable. */
export class BedrockAdapter {
  constructor(
    private readonly settings: AskSettings,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  /** Free preflight. No inference fallback if counting is unsupported or denied. */
  async countTokens(
    input: BedrockInput,
    counter: { mode: "runtime" | "mantle"; model: string },
    signal?: AbortSignal,
  ): Promise<number> {
    if (!this.settings.enabled || this.settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
    // The counter takes the request without cache points.
    const runtime = converseBody(
      input,
      this.settings.maxOutputTokens,
      this.settings.bedrockModel,
      false,
    );
    const body =
      counter.mode === "runtime"
        ? {
            input: {
              converse: {
                system: runtime.system,
                messages: runtime.messages,
                ...(runtime.toolConfig ? { toolConfig: runtime.toolConfig } : {}),
              },
            },
          }
        : {
            model: counter.model,
            ...runtime.additionalModelRequestFields,
            system: [input.system, input.context].filter(Boolean).join("\n"),
            messages: input.messages.map((message) => ({
              role: message.role,
              content: message.content.map((block) => {
                if ("text" in block) return { type: "text", text: block.text };
                if ("toolUse" in block)
                  return {
                    type: "tool_use",
                    id: block.toolUse.toolUseId,
                    name: block.toolUse.name,
                    input: block.toolUse.input,
                  };
                return {
                  type: "tool_result",
                  tool_use_id: block.toolResult.toolUseId,
                  content: block.toolResult.content.map((part) => ({
                    type: "text",
                    text: part.text,
                  })),
                  is_error: block.toolResult.status === "error",
                };
              }),
            })),
            ...(input.tools?.length
              ? {
                  tools: input.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.inputSchema,
                    ...(tool.strict ? { strict: true } : {}),
                  })),
                  tool_choice: { type: input.forceTool ? "any" : "auto" },
                }
              : {}),
          };
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > this.settings.maxContextBytes)
      throw new AskFailure("ASK_LIMIT_REACHED", 422);
    const endpoint =
      counter.mode === "runtime"
        ? `https://bedrock-runtime.${this.settings.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(counter.model)}/count-tokens`
        : `https://bedrock-mantle.${this.settings.bedrockRegion}.api.aws/anthropic/v1/messages/count_tokens`;
    try {
      const response = await boundedFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(counter.mode === "runtime"
              ? { authorization: `Bearer ${this.settings.bedrockToken}` }
              : { "x-api-key": this.settings.bedrockToken, "anthropic-version": "2023-06-01" }),
          },
          body: serialized,
        },
        {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.settings.requestTimeoutMs,
          maxBytes: this.settings.maxResponseBytes,
          signal,
        },
      );
      if (!response.ok) throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
      const raw = (await response.json()) as Record<string, unknown>;
      return z
        .number()
        .int()
        .min(1)
        .max(2_000_000)
        .parse(raw[counter.mode === "runtime" ? "inputTokens" : "input_tokens"]);
    } catch (error) {
      if (error instanceof AskFailure) throw error;
      throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
    }
  }

  async converse(
    input: BedrockInput,
    options: {
      signal?: AbortSignal;
      /** Must persist observed usage even when answer validation later fails. */
      onUsage: (usage: BedrockUsage | null, receipt: BedrockReceipt) => Promise<void>;
      /** The durable accounting layer marks potential spend before dispatch. */
      onDispatch: () => Promise<void>;
      /** Given, the step streams (ConverseStream) and this receives the
       * step's text as it arrives, unvalidated: the answer, written before
       * its closing `present_answer` call. A step that calls a read tool
       * withdraws it (empty text). Without it the step is one buffered
       * Converse call. */
      onDraft?: (summary: { text: string; complete: boolean }) => void;
    },
  ): Promise<BedrockStep> {
    if (!this.settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
    if (this.settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
    const cache = cachesPrompt(this.settings.bedrockModel);
    const body = JSON.stringify(
      converseBody(input, this.settings.maxOutputTokens, this.settings.bedrockModel, cache),
    );
    if (Buffer.byteLength(body) > this.settings.maxContextBytes)
      throw new AskFailure("ASK_LIMIT_REACHED", 422);
    const streamed = options.onDraft !== undefined;
    const endpoint = `https://bedrock-runtime.${this.settings.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(this.settings.bedrockModel)}/${streamed ? "converse-stream" : "converse"}`;
    let raw: unknown;
    const receipt: BedrockReceipt = { requestId: null, providerStatus: null };
    const head = (status: number, headers: Headers) => {
      receipt.providerStatus = status;
      const requestId = headers.get("x-amzn-requestid");
      if (requestId && /^[A-Za-z0-9-]{1,128}$/.test(requestId)) receipt.requestId = requestId;
    };
    const init = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.settings.bedrockToken}`,
        "content-type": "application/json",
      },
      body,
    };
    const bounds = {
      fetchImpl: this.fetchImpl,
      timeoutMs: this.settings.runTimeoutMs,
      maxBytes: this.settings.maxResponseBytes,
      signal: options.signal,
    };
    options.signal?.throwIfAborted();
    await options.onDispatch();
    try {
      if (streamed) {
        const decoder = new EventStreamDecoder();
        const stream = new ConverseStreamAssembler(options.onDraft);
        let ok = false;
        await boundedStream(
          endpoint,
          init,
          bounds,
          (response) => {
            head(response.status, response.headers);
            ok = response.ok;
          },
          (chunk) => {
            for (const message of decoder.push(chunk)) stream.message(message);
          },
        );
        if (!ok) throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
        decoder.finish();
        raw = stream.response();
      } else {
        const response = await boundedFetch(endpoint, init, bounds);
        head(response.status, response.headers);
        if (!response.ok) throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
        raw = await response.json();
      }
    } catch (error) {
      await options.onUsage(null, receipt);
      if (
        error instanceof AskFailure &&
        ["ASK_TIMEOUT", "ASK_CANCELLED", "ASK_LIMIT_REACHED"].includes(error.code)
      )
        throw error;
      throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
    }
    const usage = wireUsageSchema
      .transform((value) => (cache ? withRequestedCacheTtl(value) : value))
      .safeParse(typeof raw === "object" && raw !== null && "usage" in raw ? raw.usage : undefined);
    await options.onUsage(usage.success ? usage.data : null, receipt);
    if (!usage.success && typeof raw === "object" && raw !== null && "usage" in raw)
      throw new AskFailure("ASK_INVALID_ANSWER", 502, "bad_usage");
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new AskFailure("ASK_INVALID_ANSWER", 502, "malformed_response");
    if (
      parsed.data.stopReason === "max_tokens" ||
      parsed.data.stopReason === "model_context_window_exceeded"
    )
      throw new AskFailure("ASK_TRUNCATED", 502);
    if (parsed.data.stopReason !== "end_turn" && parsed.data.stopReason !== "tool_use")
      throw new AskFailure("ASK_INVALID_ANSWER", 502, "unexpected_stop");
    return {
      message: parsed.data.output.message,
      stopReason: parsed.data.stopReason,
      usage: usage.success ? usage.data : null,
      model: this.settings.bedrockModel,
      region: this.settings.bedrockRegion,
      receipt,
    };
  }
}

type StreamBlock =
  { text: string } | { toolUse: { toolUseId: string; name: string; type?: unknown }; json: string };

/**
 * Rebuilds a Converse response from ConverseStream's events, so the stream
 * and the buffered call share every check that follows. Usage arrives in the
 * last event (`metadata`); a stream cut before it leaves the step's usage
 * unknown. A content delta this reader does not know marks the response
 * invalid, and the stream is still read to its end so its usage is recorded;
 * an event type it does not know is skipped.
 * An exception event ends the step as a provider failure.
 */
class ConverseStreamAssembler {
  private role: unknown;
  private stopReason: unknown;
  private usage: unknown;
  private invalid = false;
  private readonly blocks: StreamBlock[] = [];
  private shown: string | null = null;

  constructor(private readonly onDraft?: (summary: { text: string; complete: boolean }) => void) {}

  message(message: StreamMessage): void {
    const kind = message.headers[":message-type"];
    if (kind !== "event") throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message.payload.toString("utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
      event = parsed as Record<string, unknown>;
    } catch {
      this.invalid = true;
      return;
    }
    const index = event.contentBlockIndex;
    switch (message.headers[":event-type"]) {
      case "messageStart":
        this.role = event.role;
        return;
      case "contentBlockStart": {
        const start = event.start as { toolUse?: Record<string, unknown> } | undefined;
        const tool = start?.toolUse;
        if (index === this.blocks.length && !tool && Object.keys(start ?? {}).length === 0) {
          this.blocks.push({ text: "" });
          return;
        }
        if (
          index !== this.blocks.length ||
          !tool ||
          typeof tool.toolUseId !== "string" ||
          typeof tool.name !== "string"
        ) {
          this.invalid = true;
          return;
        }
        this.blocks.push({
          toolUse: {
            toolUseId: tool.toolUseId,
            name: tool.name,
            ...(tool.type === undefined ? {} : { type: tool.type }),
          },
          json: "",
        });
        // Text before a read is not the answer: withdraw it. Text before the
        // closing call is the answer, whole.
        if (tool.name === "present_answer") this.draft(true);
        else this.withdraw();
        return;
      }
      case "contentBlockDelta": {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (typeof index !== "number" || !delta) {
          this.invalid = true;
          return;
        }
        if (typeof delta.text === "string" && Object.keys(delta).length === 1) {
          // A text block has no start event: its first delta opens it.
          if (index === this.blocks.length) this.blocks.push({ text: "" });
          const block = this.blocks[index];
          if (!block || !("text" in block)) this.invalid = true;
          else {
            block.text += delta.text;
            this.draft(false);
          }
          return;
        }
        const toolDelta = delta.toolUse as Record<string, unknown> | undefined;
        const block = this.blocks[index];
        if (
          Object.keys(delta).length !== 1 ||
          typeof toolDelta?.input !== "string" ||
          !block ||
          !("json" in block)
        ) {
          this.invalid = true;
          return;
        }
        block.json += toolDelta.input;
        return;
      }
      case "contentBlockStop":
        return;
      case "messageStop":
        this.stopReason = event.stopReason;
        // A step that ends on its text alone is a whole answer.
        if (event.stopReason === "end_turn") this.draft(true);
        return;
      case "metadata":
        this.usage = event.usage;
        return;
      default:
        // An event type added after this reader carries no content block of
        // its own; content always arrives in a contentBlockDelta.
        return;
    }
  }

  private reading = false;

  /** The step's text so far, unless the step already called a read. */
  private draft(complete: boolean): void {
    if (this.reading || !this.onDraft) return;
    const text = this.blocks.map((block) => ("text" in block ? block.text : "")).join("");
    this.publish({ text, complete });
  }

  private withdraw(): void {
    if (this.reading) return;
    this.reading = true;
    this.publish({ text: "", complete: true });
  }

  private publish(answer: { text: string; complete: boolean }): void {
    if (!this.onDraft) return;
    const key = `${answer.complete ? 1 : 0}${answer.text}`;
    if (key === this.shown) return;
    this.shown = key;
    try {
      this.onDraft(answer);
    } catch {
      // A draft is a preview: its consumer never ends the step.
    }
  }

  /** The Converse-shaped response; one that is invalid carries only its usage. */
  response(): Record<string, unknown> {
    const content: unknown[] = [];
    for (const block of this.blocks) {
      if ("text" in block) {
        content.push({ text: block.text });
        continue;
      }
      try {
        content.push({
          toolUse: { ...block.toolUse, input: JSON.parse(block.json || "{}") as unknown },
        });
      } catch {
        this.invalid = true;
      }
    }
    return {
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      ...(this.invalid
        ? {}
        : { output: { message: { role: this.role, content } }, stopReason: this.stopReason }),
    };
  }
}
