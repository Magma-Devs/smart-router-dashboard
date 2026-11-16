import { afterEach, describe, expect, it, vi } from "vitest";
import { readAskSettings } from "../config.js";
import { BedrockAdapter } from "../services/ask/bedrock.js";
import { McpAdapter } from "../services/ask/mcp.js";
import { boundedFetch } from "../services/ask/http.js";
import { AskFailure } from "../services/ask/errors.js";

const env = {
  ASK_DATA_ENABLED: "true",
  AUTH_MODE: "enabled",
  DEPLOYMENT_MODE: "managed",
  ASK_DATA_CUSTOMER_ID: "gk8",
  ASK_DATA_MCP_TOKEN: "customer-test-token",
  AWS_BEARER_TOKEN_BEDROCK: "bedrock-test-token",
  ASK_DATA_BEDROCK_MODEL: "test-model",
};
const settings = () => readAskSettings(env);
const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30, cacheReadInputTokens: 5 };
const input = {
  system: "System policy",
  messages: [{ role: "user" as const, content: [{ text: "What happened?" }] }],
};
const providerResult = () => ({
  output: { message: { role: "assistant", content: [{ text: '{"summary":"answer"}' }] } },
  stopReason: "end_turn",
  usage,
});
afterEach(() => vi.restoreAllMocks());

describe("Ask settings and provider boundary", () => {
  it("requires every availability gate and explicit server customer configuration", () => {
    expect(settings().problem).toBeNull();
    for (const override of [
      { ASK_DATA_ENABLED: "false" },
      { AUTH_MODE: "disabled" },
      { DEPLOYMENT_MODE: "onprem" },
    ])
      expect(readAskSettings({ ...env, ...override }).enabled).toBe(false);
    for (const override of [
      { ASK_DATA_CUSTOMER_ID: "" },
      { ASK_DATA_MCP_TOKEN: "" },
      { AWS_BEARER_TOKEN_BEDROCK: "" },
      { ASK_DATA_BEDROCK_MODEL: "" },
      { ASK_DATA_MCP_URL: "https://secret@evil.test/mcp" },
      { ASK_DATA_MCP_URL: "http://evil.test/mcp" },
      { ASK_DATA_MCP_URL: "https://safe.test/mcp?token=secret" },
      { ASK_DATA_BEDROCK_REGION: "evil.test/" },
    ])
      expect(readAskSettings({ ...env, ...override }).problem).not.toBeNull();
  });

  it("never invokes either provider while disabled or misconfigured", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const value of [
      { ...settings(), enabled: false },
      { ...settings(), problem: "missing key" },
    ]) {
      await expect(
        new BedrockAdapter(value, fetchImpl).converse(input, {
          onUsage: vi.fn(),
          onDispatch: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(AskFailure);
      await expect(
        new McpAdapter(value, fetchImpl).withConnection(async () => undefined),
      ).rejects.toBeInstanceOf(AskFailure);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds advertised and streamed bodies without retaining provider secrets", async () => {
    const base = { timeoutMs: 1000, maxBytes: 3 };
    await expect(
      boundedFetch(
        "https://provider.test",
        {},
        {
          ...base,
          fetchImpl: async () => new Response("1234", { headers: { "content-length": "4" } }),
        },
      ),
    ).rejects.toMatchObject({ code: "ASK_LIMIT_REACHED" });
    await expect(
      boundedFetch(
        "https://provider.test",
        {},
        { ...base, fetchImpl: async () => new Response("1234") },
      ),
    ).rejects.toMatchObject({ code: "ASK_LIMIT_REACHED" });
    await expect(
      boundedFetch(
        "https://provider.test",
        {},
        {
          ...base,
          fetchImpl: async () => {
            throw new Error("Bearer top-secret");
          },
        },
      ),
    ).rejects.toMatchObject({ message: "Ask your data is temporarily unavailable." });
  });

  it("respects pre-existing cancellation and a live request deadline", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      boundedFetch(
        "https://provider.test",
        {},
        { timeoutMs: 100, maxBytes: 100, signal: AbortSignal.abort(), fetchImpl },
      ),
    ).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
    const waiting: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      });
    await expect(
      boundedFetch(
        "https://provider.test",
        {},
        { timeoutMs: 10, maxBytes: 100, fetchImpl: waiting },
      ),
    ).rejects.toMatchObject({ code: "ASK_TIMEOUT" });
  });
});

describe("Bedrock adapter", () => {
  it("uses the fixed region/model endpoint, bounded output and server bearer", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(providerResult()));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const result = await new BedrockAdapter(settings(), fetchImpl).converse(input, {
      onUsage,
      onDispatch: async () => undefined,
    });
    expect(result.usage).toEqual(usage);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage, {
      requestId: null,
      providerStatus: 200,
    });
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/test-model/converse");
    expect(request?.redirect).toBe("error");
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer bedrock-test-token");
    const body = JSON.parse(String(request?.body));
    expect(body.inferenceConfig).toEqual({ maxTokens: 2048 });
    expect(body.inferenceConfig.temperature).toBeUndefined();
  });

  it.each(["max_tokens", "model_context_window_exceeded", "guardrail_intervened"])(
    "records usage before refusing %s",
    async (stopReason) => {
      const onUsage = vi.fn().mockResolvedValue(undefined);
      const result = { ...providerResult(), stopReason };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
      await expect(
        new BedrockAdapter(settings(), fetchImpl).converse(input, {
          onUsage,
          onDispatch: async () => undefined,
        }),
      ).rejects.toBeInstanceOf(AskFailure);
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(usage, {
        requestId: null,
        providerStatus: 200,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves uncertain usage on transport/provider failure without retrying", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("credential-bearing URL"));
    const onUsage = vi.fn().mockResolvedValue(undefined);
    await expect(
      new BedrockAdapter(settings(), fetchImpl).converse(input, {
        onUsage,
        onDispatch: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ASK_BEDROCK_UNAVAILABLE" });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(null, {
      requestId: null,
      providerStatus: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records valid usage even when the provider output is malformed", async () => {
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ usage, output: "bad" }));
    await expect(
      new BedrockAdapter(settings(), fetchImpl).converse(input, {
        onUsage,
        onDispatch: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ASK_INVALID_ANSWER" });
    expect(onUsage).toHaveBeenCalledWith(usage, { requestId: null, providerStatus: 200 });
  });

  it("records missing usage as uncertain and bounds context before dispatch", async () => {
    const onUsage = vi.fn().mockResolvedValue(undefined);
    const raw: Record<string, unknown> = providerResult();
    delete raw.usage;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(raw));
    expect(
      (
        await new BedrockAdapter(settings(), fetchImpl).converse(input, {
          onUsage,
          onDispatch: async () => undefined,
        })
      ).usage,
    ).toBeNull();
    expect(onUsage).toHaveBeenCalledWith(null, { requestId: null, providerStatus: 200 });
    await expect(
      new BedrockAdapter({ ...settings(), maxContextBytes: 10 }, fetchImpl).converse(input, {
        onDispatch: async () => undefined,
        onUsage,
      }),
    ).rejects.toMatchObject({ code: "ASK_LIMIT_REACHED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

function mcpFixture(
  overrides: {
    identity?: unknown;
    sourceTenant?: string;
    resultTenant?: string;
    readOnly?: boolean;
    method?: string;
    sse?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer customer-test-token");
    if (init?.method !== "POST") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "test-mcp", version: "1" },
      };
    else if (request.method === "tools/list")
      result = {
        tools: ["whoami", "list_sources", "search_operations", "execute_operation"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      };
    else if (request.method === "tools/call") {
      const { name, arguments: args } = request.params;
      calls.push({ name, args });
      let data: unknown;
      if (name === "whoami")
        data = overrides.identity ?? {
          tenantId: "gk8",
          subject: "customer-principal",
          scopes: ["read"],
        };
      else if (name === "list_sources")
        data = [
          {
            id: "gk8-metrics",
            tenantId: overrides.sourceTenant,
            name: "Metrics",
            kind: "mimir",
            operationIds: ["metrics.query", "delete.everything"],
          },
        ];
      else if (name === "search_operations")
        data = {
          version: "test-v1",
          sources: [
            {
              sourceId: "gk8-metrics",
              operations: ["metrics.query", "delete.everything"].map((id) => ({
                id,
                description: "untrusted description",
                method: overrides.method ?? "GET",
                readOnly: overrides.readOnly ?? true,
                inputSchema: { type: "object" },
              })),
            },
          ],
        };
      else
        data = {
          tenantId: overrides.resultTenant ?? "gk8",
          sourceId: args.sourceId,
          operationId: args.operationId,
          ok: true,
          data: { result: [] },
        };
      result = {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: { result: data },
      };
    } else throw new Error("Unexpected MCP method");
    const response = { jsonrpc: "2.0", id: request.id, result };
    return overrides.sse && request.method === "tools/call"
      ? new Response(`event: message\ndata: ${JSON.stringify(response)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(response);
  });
  return { fetchImpl, calls };
}

describe("MCP SDK transport and customer policy", () => {
  it.each([false, true])(
    "discovers and reads only the customer's audited operation (SSE %s)",
    async (sse) => {
      const fixture = mcpFixture({ sse });
      await new McpAdapter(settings(), fixture.fetchImpl).withConnection(async (connection) => {
        const snapshot = await connection.discover();
        expect(snapshot.sources[0]?.operationIds).toEqual(["metrics.query"]);
        const result = await connection.read("gk8-metrics", "metrics.query", {
          query: "count(up)",
        });
        expect(result).toMatchObject({ ok: true, sourceId: "gk8-metrics", data: { result: [] } });
      });
      expect(fixture.calls.filter((c) => c.name === "whoami")).toHaveLength(2);
      expect(fixture.calls.filter((c) => c.name === "execute_operation")).toHaveLength(1);
    },
  );

  it.each([
    { tenantId: "other", subject: "other", scopes: ["read"] },
    { tenantId: "gk8", subject: "staff", scopes: ["read"], access: "staff", tenantIds: ["gk8"] },
    { tenantId: "gk8", subject: "broad", scopes: ["read"], tenantIds: ["gk8", "other"] },
    { tenantId: "gk8", subject: "writer", scopes: ["read", "write"] },
  ])("rejects foreign or broad identities before reading data", async (identity) => {
    const fixture = mcpFixture({ identity });
    await expect(
      new McpAdapter(settings(), fixture.fetchImpl).withConnection((c) => c.discover()),
    ).rejects.toMatchObject({ code: "ASK_IDENTITY_MISMATCH" });
    expect(fixture.calls.map((c) => c.name)).toEqual(["whoami"]);
  });

  it("rejects a foreign source and a foreign result envelope", async () => {
    const foreignSource = mcpFixture({ sourceTenant: "other" });
    await expect(
      new McpAdapter(settings(), foreignSource.fetchImpl).withConnection((c) => c.discover()),
    ).rejects.toMatchObject({ code: "ASK_IDENTITY_MISMATCH" });
    const foreignResult = mcpFixture({ resultTenant: "other" });
    await expect(
      new McpAdapter(settings(), foreignResult.fetchImpl).withConnection((c) =>
        c.read("gk8-metrics", "metrics.query", { query: "up" }),
      ),
    ).rejects.toMatchObject({ code: "ASK_IDENTITY_MISMATCH" });
  });

  it("rejects unapproved operations, foreign IDs, range escalation and credential arguments", async () => {
    const fixture = mcpFixture();
    await new McpAdapter(settings(), fixture.fetchImpl).withConnection(async (connection) => {
      await connection.discover();
      for (const [source, operation, args] of [
        ["gk8-metrics", "delete.everything", {}],
        ["other-metrics", "metrics.query", { query: "up" }],
        ["gk8-metrics", "metrics.query", { query: "up", tenantId: "other" }],
        ["gk8-metrics", "metrics.query", { query: "up", headers: { authorization: "secret" } }],
        ["gk8-metrics", "metrics.query", { query: "up", url: "https://evil.test" }],
      ] as const)
        await expect(connection.read(source, operation, args)).rejects.toMatchObject({
          code: "ASK_TOOL_DENIED",
        });
    });
    expect(fixture.calls.some((c) => c.name === "execute_operation")).toBe(false);
  });

  it.each([
    "rate(up[365d])",
    "up offset 365d",
    "up @ 1",
    "rate(up[1h])[24h:1s]",
    "rate(up[1h * 1000])",
  ])("rejects query-text range escalation before sending an MCP operation: %s", async (query) => {
    const fixture = mcpFixture();
    await expect(
      new McpAdapter(settings(), fixture.fetchImpl).withConnection((c) =>
        c.read("gk8-metrics", "metrics.query", { query }),
      ),
    ).rejects.toMatchObject({ code: "ASK_TOOL_DENIED" });
    expect(fixture.calls.some((c) => c.name === "execute_operation")).toBe(false);
  });

  it.each([{ readOnly: false }, { method: "POST" }])(
    "remote annotations cannot authorize an unsafe operation",
    async (overrides) => {
      const fixture = mcpFixture(overrides);
      await new McpAdapter(settings(), fixture.fetchImpl).withConnection(async (c) => {
        expect((await c.discover()).sources[0]?.operationIds).toEqual([]);
        await expect(c.read("gk8-metrics", "metrics.query", { query: "up" })).rejects.toMatchObject(
          { code: "ASK_TOOL_DENIED" },
        );
      });
    },
  );
});
