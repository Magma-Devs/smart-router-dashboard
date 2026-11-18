import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import type { AskSettings } from "../../config.js";
import {
  BedrockAdapter,
  type BedrockInput,
  type BedrockMessage,
  type BedrockStep,
} from "./bedrock.js";
import { AskFailure, abortFailure } from "./errors.js";
import type { AskExecutionHooks } from "./orchestrator.js";

/** AI SDK owns the tool loop; our native adapter continues to own dispatch,
 * receipts and accounting. SDK lifecycle notifications are not safety guards:
 * they swallow callback errors. All admission happens inside doGenerate. */
export function askAgentModel(options: {
  settings: AskSettings;
  hooks: AskExecutionHooks;
  runId: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  validateStep: (step: BedrockStep) => void;
  inputSize?: (bytes: number) => void;
  timing?: (phase: "model" | "admission", durationMs: number) => void;
}): LanguageModelV4 {
  const { settings, hooks, signal } = options;
  const native = new BedrockAdapter(settings, options.fetchImpl);
  let steps = 0;
  return {
    specificationVersion: "v4",
    provider: "magma-bedrock",
    modelId: settings.bedrockModel,
    supportedUrls: {},
    async doGenerate(call) {
      if (signal.aborted) throw abortFailure(signal);
      if (++steps > settings.maxSteps) throw new AskFailure("ASK_LIMIT_REACHED", 422);
      await hooks.checkActive();
      const input = toBedrock(call);
      const bytes = Buffer.byteLength(JSON.stringify(input));
      options.inputSize?.(bytes);
      if (bytes > settings.maxContextBytes) throw new AskFailure("ASK_LIMIT_REACHED", 422);
      const admission = performance.now();
      const stepId = await hooks.beforeModelStep({
        input,
        inputBytes: bytes,
        outputTokens: settings.maxOutputTokens,
        signal,
      });
      options.timing?.("admission", performance.now() - admission);
      if (signal.aborted) throw abortFailure(signal);
      const started = performance.now();
      const step = await native.converse(
        { ...input, requestMetadata: { run_id: options.runId, step_id: stepId } },
        {
          signal,
          onDispatch: async () => {
            await hooks.checkActive();
            await hooks.modelDispatched(stepId);
          },
          onUsage: (usage, receipt) => hooks.recordUsage(stepId, usage, receipt),
        },
      );
      options.timing?.("model", performance.now() - started);
      for (const block of step.message.content) {
        if ("toolUse" in block && !input.tools?.some((tool) => tool.name === block.toolUse.name))
          throw new AskFailure(
            block.toolUse.name === "present_answer" ? "ASK_INVALID_ANSWER" : "ASK_TOOL_DENIED",
            422,
          );
      }
      // Usage has been durably observed even if content is invalid. Reject
      // unsafe calls before the SDK can execute or repair any tool input.
      options.validateStep(step);
      return {
        content: step.message.content.map((part) =>
          "text" in part
            ? { type: "text" as const, text: part.text }
            : "toolUse" in part
              ? {
                  type: "tool-call" as const,
                  toolCallId: part.toolUse.toolUseId,
                  toolName: part.toolUse.name,
                  input: JSON.stringify(part.toolUse.input),
                }
              : (() => {
                  throw new AskFailure("ASK_INVALID_ANSWER", 502);
                })(),
        ),
        finishReason: {
          unified: step.stopReason === "tool_use" ? "tool-calls" : "stop",
          raw: step.stopReason,
        },
        usage: {
          inputTokens: {
            total: step.usage?.inputTokens,
            noCache: step.usage?.inputTokens,
            cacheRead: step.usage?.cacheReadInputTokens,
            cacheWrite: step.usage?.cacheWriteInputTokens,
          },
          outputTokens: {
            total: step.usage?.outputTokens,
            text: step.usage?.outputTokens,
            reasoning: 0,
          },
        },
        response: { id: step.receipt.requestId ?? undefined },
        warnings: [],
      };
    },
    async doStream() {
      // The contract requires validation before display. Never stream raw
      // unvalidated customer data to the browser.
      throw new AskFailure("ASK_UNAVAILABLE");
    },
  };
}

function toBedrock(call: LanguageModelV4CallOptions): BedrockInput {
  const system: string[] = [];
  const messages: BedrockMessage[] = [];
  for (const message of call.prompt) {
    if (message.role === "system") {
      system.push(message.content);
      continue;
    }
    const content: BedrockMessage["content"] = message.content.map((part) => {
      if (part.type === "text") return { text: part.text };
      if (part.type === "tool-call")
        return {
          toolUse: {
            toolUseId: part.toolCallId,
            name: part.toolName,
            input: part.input as Record<string, unknown>,
          },
        };
      if (part.type === "tool-result") {
        const output = part.output;
        if (!["text", "json", "error-text", "error-json"].includes(output.type))
          throw new AskFailure("ASK_TOOL_DENIED", 403);
        const value = "value" in output ? output.value : undefined;
        const failed =
          output.type.startsWith("error") ||
          (value !== null && typeof value === "object" && "error" in value);
        return {
          toolResult: {
            toolUseId: part.toolCallId,
            status: failed ? ("error" as const) : ("success" as const),
            content: [{ text: typeof value === "string" ? value : JSON.stringify(value) }],
          },
        };
      }
      // This text-only product never fetches files, URLs or provider tools.
      throw new AskFailure("ASK_TOOL_DENIED", 403);
    });
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else messages.push({ role, content });
  }
  const tools = call.tools?.map((tool) => {
    if (tool.type !== "function") throw new AskFailure("ASK_TOOL_DENIED", 403);
    return {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.name === "present_answer"
        ? presentationSchema(tool.inputSchema)
        : tool.inputSchema) as Record<string, unknown>,
      ...(tool.name === "present_answer" ? { strict: true } : {}),
    };
  });
  return {
    system: system.join("\n"),
    messages,
    tools,
    forceTool: call.toolChoice?.type === "required",
  };
}

/** Bedrock's constrained decoder accepts structure, but not size/numeric
 * bounds. Keep the original full Zod schema as the final local authority. */
function presentationSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentationSchema);
  if (value === null || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          ![
            "$schema",
            "minLength",
            "maxLength",
            "maxItems",
            "minimum",
            "maximum",
            "multipleOf",
          ].includes(key),
      )
      .map(([key, child]) => [key, presentationSchema(child)]),
  );
  if (typeof node.maxLength === "number")
    result.description = [
      result.description,
      `Nonempty text, at most ${node.maxLength} characters.`,
    ]
      .filter(Boolean)
      .join(" ");
  return result;
}
