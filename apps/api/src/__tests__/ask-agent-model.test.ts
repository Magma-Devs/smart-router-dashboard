import { describe, expect, it, vi } from "vitest";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { readAskSettings } from "../config.js";
import { askAgentModel, type AskHistoryTurn } from "../services/ask/agent-model.js";
import type { AskExecutionHooks } from "../services/ask/orchestrator.js";

function fixture(history: AskHistoryTurn[]) {
  const settings = readAskSettings({
    AUTH_MODE: "enabled",
    DEPLOYMENT_MODE: "managed",
    ASK_DATA_ENABLED: "true",
    ASK_DATA_CUSTOMER_ID: "acme",
    ASK_DATA_MCP_URL: "https://fixture.invalid/mcp",
    ASK_DATA_MCP_TOKEN: "synthetic",
    AWS_BEARER_TOKEN_BEDROCK: "synthetic",
    ASK_DATA_BEDROCK_MODEL: "fixture",
  });
  settings.maxContextBytes = 8000;
  const hooks: AskExecutionHooks = {
    checkActive: vi.fn(async () => {}),
    beforeModelStep: vi.fn(async () => crypto.randomUUID()),
    modelDispatched: vi.fn(async () => {}),
    recordUsage: vi.fn(async () => {}),
    recordTool: vi.fn(async () => {}),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      output: { message: { role: "assistant", content: [{ text: "Fixture reply" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  );
  const inputSize = vi.fn();
  const model = askAgentModel({
    settings,
    history,
    hooks,
    fetchImpl,
    inputSize,
    runId: crypto.randomUUID(),
    signal: new AbortController().signal,
    validateStep: () => {},
  });
  return { settings, hooks, fetchImpl, inputSize, model };
}

function call(history: AskHistoryTurn[], question: string): LanguageModelV4CallOptions {
  const prompt: LanguageModelV4CallOptions["prompt"] = [
    { role: "system", content: "Fixed system" },
  ];
  for (const turn of history) {
    const content = [{ type: "text" as const, text: turn.content }];
    prompt.push(turn.role === "user" ? { role: "user", content } : { role: "assistant", content });
  }
  prompt.push({ role: "user", content: [{ type: "text", text: question }] });
  return { prompt };
}

describe("personal history and protected native context", () => {
  it("keeps small history intact and counts exactly the input it generates with", async () => {
    const history: AskHistoryTurn[] = [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ];
    const f = fixture(history);
    await f.model.doGenerate(call(history, "Current question"));
    const bounds = vi.mocked(f.hooks.beforeModelStep).mock.calls[0]![0];
    expect(bounds.input.messages.map((m) => m.content)).toEqual([
      [{ text: "Earlier question" }],
      [{ text: "Earlier answer" }],
      [{ text: "Current question" }],
    ]);
    expect(bounds.inputBytes).toBe(Buffer.byteLength(JSON.stringify(bounds.input)));
    expect(f.inputSize.mock.calls[0]![1]).toBeLessThan(bounds.inputBytes);
    expect(f.hooks.modelDispatched).toHaveBeenCalledOnce();
    expect(f.hooks.recordUsage).toHaveBeenCalledOnce();
  });

  it("reclaims old turns while preserving the current question and this run's tools", async () => {
    const history: AskHistoryTurn[] = Array.from({ length: 5 }, (_, i) => [
      { role: "user" as const, content: `old question ${i} ${"a".repeat(1800)}` },
      { role: "assistant" as const, content: `old reply ${i} ${"b".repeat(1800)}` },
    ]).flat();
    const f = fixture(history);
    const request = call(history, "Current question");
    request.prompt.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "current-read",
            toolName: "metrics_query",
            input: { query: "count(up)" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "current-read",
            toolName: "metrics_query",
            output: { type: "json", value: { observedTargets: 3 } },
          },
        ],
      },
    );
    await f.model.doGenerate(request);
    const input = vi.mocked(f.hooks.beforeModelStep).mock.calls[0]![0].input;
    expect(input.messages[0]?.role).toBe("user");
    expect(
      input.messages.some((m) =>
        m.content.some((p) => "text" in p && p.text === "Current question"),
      ),
    ).toBe(true);
    expect(input.messages.flatMap((m) => m.content)).toContainEqual({
      toolUse: { toolUseId: "current-read", name: "metrics_query", input: { query: "count(up)" } },
    });
    expect(input.messages.flatMap((m) => m.content)).toContainEqual(
      expect.objectContaining({
        toolResult: expect.objectContaining({ toolUseId: "current-read" }),
      }),
    );
    expect(Buffer.byteLength(String(f.fetchImpl.mock.calls[0]![1]?.body))).toBeLessThanOrEqual(
      f.settings.maxContextBytes,
    );
    expect(JSON.stringify(input)).not.toContain("old question 0");
  });

  it("does not remove the current user text when older consecutive users have identical text", async () => {
    const question = `Same request ${"q".repeat(2700)}`;
    const history: AskHistoryTurn[] = [
      { role: "user", content: question },
      { role: "user", content: question },
    ];
    const f = fixture(history);
    await f.model.doGenerate(call(history, question));
    const input = vi.mocked(f.hooks.beforeModelStep).mock.calls[0]![0].input;
    expect(input.messages).toHaveLength(1);
    expect(input.messages[0]?.role).toBe("user");
    expect(input.messages[0]!.content.length).toBeGreaterThanOrEqual(1);
    expect(input.messages[0]!.content.length).toBeLessThan(3);
    expect(input.messages[0]!.content.at(-1)).toEqual({ text: question });
  });

  it("refuses to reclaim a prefix that is not the supplied personal history", async () => {
    const f = fixture([{ role: "user", content: "Expected old question" }]);
    await expect(
      f.model.doGenerate(call([{ role: "user", content: "Different input" }], "Current question")),
    ).rejects.toMatchObject({ code: "ASK_INVALID_ANSWER" });
    expect(f.hooks.beforeModelStep).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("never drops an oversized current question to fit a billable request", async () => {
    const history: AskHistoryTurn[] = [
      { role: "user", content: "Old" },
      { role: "assistant", content: "Reply" },
    ];
    const f = fixture(history);
    await expect(f.model.doGenerate(call(history, "界".repeat(4000)))).rejects.toMatchObject({
      code: "ASK_LIMIT_REACHED",
    });
    expect(f.hooks.beforeModelStep).not.toHaveBeenCalled();
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
