import { z } from "zod";
import type { AskSettings } from "../../config.js";
import { AskFailure } from "./errors.js";
import { boundedFetch } from "./http.js";

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
    const endpoint = `https://bedrock-runtime.${this.settings.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(this.settings.bedrockModel)}/converse`;
    let raw: unknown;
    const receipt: BedrockReceipt = { requestId: null, providerStatus: null };
    options.signal?.throwIfAborted();
    await options.onDispatch();
    try {
      const response = await boundedFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.settings.bedrockToken}`,
            "content-type": "application/json",
          },
          body,
        },
        {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.settings.runTimeoutMs,
          maxBytes: this.settings.maxResponseBytes,
          signal: options.signal,
        },
      );
      receipt.providerStatus = response.status;
      const requestId = response.headers.get("x-amzn-requestid");
      if (requestId && /^[A-Za-z0-9-]{1,128}$/.test(requestId)) receipt.requestId = requestId;
      if (!response.ok) throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
      raw = await response.json();
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
      throw new AskFailure("ASK_INVALID_ANSWER", 502);
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new AskFailure("ASK_INVALID_ANSWER", 502);
    if (
      parsed.data.stopReason === "max_tokens" ||
      parsed.data.stopReason === "model_context_window_exceeded"
    )
      throw new AskFailure("ASK_TRUNCATED", 502);
    if (parsed.data.stopReason !== "end_turn" && parsed.data.stopReason !== "tool_use")
      throw new AskFailure("ASK_INVALID_ANSWER", 502);
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
