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
  })
  .passthrough();
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
}
export interface BedrockInput {
  system: string;
  messages: BedrockMessage[];
  tools?: BedrockTool[];
}

/** No automatic model retries: a timed-out invocation may already be billable. */
export class BedrockAdapter {
  constructor(
    private readonly settings: AskSettings,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async converse(
    input: BedrockInput,
    options: {
      signal?: AbortSignal;
      /** Must persist observed usage even when answer validation later fails. */
      onUsage: (usage: BedrockUsage | null) => Promise<void>;
    },
  ): Promise<BedrockStep> {
    if (!this.settings.enabled) throw new AskFailure("ASK_DISABLED", 404);
    if (this.settings.problem) throw new AskFailure("ASK_UNAVAILABLE");
    const body = JSON.stringify({
      system: [{ text: input.system }],
      messages: input.messages,
      inferenceConfig: { maxTokens: this.settings.maxOutputTokens },
      ...(input.tools?.length
        ? {
            toolConfig: {
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
    });
    if (Buffer.byteLength(body) > this.settings.maxContextBytes)
      throw new AskFailure("ASK_LIMIT_REACHED", 422);
    const endpoint = `https://bedrock-runtime.${this.settings.bedrockRegion}.amazonaws.com/model/${encodeURIComponent(this.settings.bedrockModel)}/converse`;
    let raw: unknown;
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
      if (!response.ok) throw new AskFailure("ASK_BEDROCK_UNAVAILABLE");
      raw = await response.json();
    } catch (error) {
      await options.onUsage(null);
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
    await options.onUsage(usage.success ? usage.data : null);
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
    };
  }
}
