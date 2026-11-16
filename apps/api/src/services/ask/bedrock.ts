import { z } from "zod";
import type { AskSettings } from "../../config.js";
import { AskFailure } from "./errors.js";
import { boundedFetch } from "./http.js";

export interface BedrockTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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
                    })
                    .strict(),
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
  system: string;
  messages: BedrockMessage[];
  tools?: BedrockTool[];
  forceTool?: boolean;
  requestMetadata?: Record<string, string>;
}

function converseBody(input: BedrockInput, maxOutputTokens: number) {
  return {
    system: [{ text: input.system }],
    messages: input.messages,
    inferenceConfig: { maxTokens: maxOutputTokens },
    ...(input.requestMetadata ? { requestMetadata: input.requestMetadata } : {}),
    ...(input.tools?.length
      ? {
          toolConfig: {
            toolChoice: input.forceTool ? { any: {} } : { auto: {} },
            tools: input.tools.map((tool) => ({
              toolSpec: {
                name: tool.name,
                description: tool.description,
                inputSchema: { json: tool.inputSchema },
              },
            })),
          },
        }
      : {}),
  };
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
    const runtime = converseBody(input, this.settings.maxOutputTokens);
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
            system: input.system,
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
    const body = JSON.stringify(converseBody(input, this.settings.maxOutputTokens));
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
    const usage = usageSchema.safeParse(
      typeof raw === "object" && raw !== null && "usage" in raw ? raw.usage : undefined,
    );
    await options.onUsage(usage.success ? usage.data : null, receipt);
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
