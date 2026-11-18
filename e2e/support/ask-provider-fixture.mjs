/** Deterministic provider boundary for browser tests only. Never imported by
 * product code or shipped in the API image. The browser, API, auth, worker,
 * accounting and PostgreSQL are real; MCP/Bedrock responses are synthetic. */
if (
  process.env.NODE_ENV === "production" ||
  process.env.ASK_DATA_CUSTOMER_ID !== "e2e-customer" ||
  process.env.ASK_DATA_BEDROCK_MODEL !== "anthropic.fixture"
)
  throw new Error("Ask provider fixture is test-only");
const actualFetch = globalThis.fetch;
const customer = "e2e-customer";
// A separate visual suite uses readable demo content; adversarial fixtures
// below remain unchanged for the behavioral/security suite.
const presentation = process.env.ASK_TEST_PRESENTATION === "true";
const sourceId = presentation ? "demo-metrics" : "e2e-metrics";
const usage = { inputTokens: 300, outputTokens: 100, totalTokens: 400 };
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin === "https://ask-mcp.e2e.invalid") {
    if (url.pathname !== "/mcp" || init?.method !== "POST")
      return new Response(null, { status: 405 });
    const request = JSON.parse(String(init.body));
    if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    let result;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "synthetic-mcp", version: "1" },
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
      let data;
      if (name === "whoami")
        data = {
          tenantId: customer,
          tenantIds: [customer],
          access: "customer",
          subject: "synthetic-customer",
          scopes: ["read"],
        };
      else if (name === "list_sources")
        data = [
          {
            id: sourceId,
            tenantId: customer,
            name: "Synthetic metrics",
            kind: "mimir",
            operationIds: ["metrics.query"],
          },
        ];
      else if (name === "search_operations")
        data = {
          version: "e2e-fixture-v1",
          sources: [
            {
              sourceId,
              tenantId: customer,
              operations: [
                {
                  id: "metrics.query",
                  description: "Synthetic read",
                  method: "GET",
                  readOnly: true,
                  inputSchema: { type: "object" },
                },
              ],
            },
          ],
        };
      else if (
        name === "execute_operation" &&
        args.sourceId === sourceId &&
        args.operationId === "metrics.query"
      )
        data = {
          tenantId: customer,
          sourceId,
          operationId: "metrics.query",
          ok: true,
          requestId: "synthetic-read",
          data: {
            status: "success",
            data: {
              resultType: "vector",
              result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), "3"] }],
            },
          },
        };
      else throw new Error("Unexpected synthetic MCP request");
      result = {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: { result: data },
      };
    } else throw new Error("Unexpected synthetic MCP method");
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  }
  if (
    url.hostname === "bedrock-runtime.us-east-1.amazonaws.com" &&
    url.pathname.startsWith("/model/anthropic.fixture/")
  ) {
    if (url.pathname.endsWith("/count-tokens")) return Response.json({ inputTokens: 500 });
    if (!url.pathname.endsWith("/converse"))
      throw new Error("Unexpected synthetic model operation");
    const body = JSON.parse(String(init.body));
    const question =
      body.messages
        .filter((message) => message.role === "user")
        .flatMap((message) => message.content)
        .filter((part) => typeof part.text === "string")
        .at(-1)?.text ?? "";
    const text = JSON.stringify(body.messages);
    const toolResult = body.messages.some((message) =>
      message.content.some((part) => part.toolResult),
    );
    if (toolResult) await pause(text.includes("SLOW_FIXTURE") ? 15_000 : 600, init?.signal);
    const content = toolResult
      ? [
          {
            toolUse: {
              toolUseId: "synthetic-answer-1",
              name: "present_answer",
              type: "tool_use",
              input: {
                kind: "data",
                summary: "Three authorized fixture targets were returned.",
                sections: [
                  {
                    title: "Observed targets",
                    body: "This is synthetic browser-test evidence. It does not establish router health.",
                    stat: { value: "3", label: "Authorized fixture targets", tone: "neutral" },
                  },
                  { title: "Untrusted text", body: "<script>window.__askUnsafe=true</script>" },
                ],
              },
            },
          },
        ]
      : [
          {
            toolUse: {
              toolUseId: "synthetic-read-1",
              name: "metrics_query",
              type: "tool_use",
              input: { sourceId, query: "count(up)", time: Date.now() / 1000 },
            },
          },
        ];
    if (presentation) {
      if (!toolResult) content[0].toolUse.input.query = "sum(up)";
      else
        content[0].toolUse.input = question.includes("every RPC")
          ? {
              kind: "data",
              summary: "No — a target being up doesn’t guarantee healthy RPC traffic.",
              sections: [
                {
                  title: "What to check next",
                  body: "Start with the chain and time range you’re investigating.",
                  points: [
                    "Compare request error rates for the affected chain.",
                    "Check latency and recent router logs over the same time window.",
                  ],
                },
              ],
            }
          : {
              kind: "data",
              summary: "Three monitoring targets are up right now.",
              sections: [
                {
                  title: "Current snapshot",
                  body: "The latest snapshot reports three targets up. This tells us they are reachable; it doesn’t tell us whether every RPC request is succeeding.",
                  stat: { value: "3", label: "targets up", tone: "good" },
                },
              ],
            };
    }
    if (question === "what is the date today?")
      content.splice(0, content.length, {
        toolUse: {
          toolUseId: "synthetic-conversation",
          name: "present_answer",
          input: {
            kind: "conversation",
            summary: `Today is ${new Date().toISOString().slice(0, 10)} (UTC).`,
            sections: [],
          },
        },
      });
    return Response.json(
      {
        output: { message: { role: "assistant", content } },
        stopReason: toolResult && text.includes("INVALID_FIXTURE") ? "max_tokens" : "tool_use",
        usage: {
          ...usage,
          cacheReadInputTokens: 0,
          cacheReadInputTokenCount: 0,
          cacheWriteInputTokens: 0,
          cacheWriteInputTokenCount: 0,
          serverToolUsage: {},
        },
      },
      { headers: { "x-amzn-requestid": "synthetic-model-receipt" } },
    );
  }
  return actualFetch(input, init);
};
