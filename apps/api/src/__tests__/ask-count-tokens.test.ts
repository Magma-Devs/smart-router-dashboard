import { describe, expect, it, vi } from "vitest";
import { BedrockAdapter, type BedrockInput } from "../services/ask/bedrock.js";
import { readAskSettings } from "../config.js";

const settings = readAskSettings({
  AUTH_MODE: "enabled",
  DEPLOYMENT_MODE: "managed",
  ASK_DATA_ENABLED: "true",
  ASK_DATA_CUSTOMER_ID: "customer-a",
  ASK_DATA_MCP_TOKEN: "synthetic-key",
  AWS_BEARER_TOKEN_BEDROCK: "synthetic-provider",
  ASK_DATA_BEDROCK_MODEL: "global.anthropic.fixture",
});
const input: BedrockInput = {
  system: "Synthetic system",
  messages: [
    {
      role: "assistant",
      content: [{ toolUse: { toolUseId: "read-1", name: "read", input: { query: "fixture" } } }],
    },
    {
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "read-1",
            content: [{ text: "Synthetic result" }],
            status: "error",
          },
        },
      ],
    },
  ],
  tools: [{ name: "read", description: "Fixture read", inputSchema: { type: "object" } }],
  forceTool: true,
};
describe("free Bedrock token preflight", () => {
  it("counts the same runtime system/messages/tool schema including forced choice", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ inputTokens: 123 })));
    expect(
      await new BedrockAdapter(settings, fetchImpl).countTokens(input, {
        mode: "runtime",
        model: settings.bedrockModel,
      }),
    ).toBe(123);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/count-tokens");
    const body = JSON.parse(init!.body as string) as {
      input: { converse: Record<string, unknown> };
    };
    expect(body.input.converse).toMatchObject({
      system: [{ text: input.system }],
      messages: input.messages,
      toolConfig: {
        toolChoice: { any: {} },
        tools: [{ toolSpec: { name: "read", inputSchema: { json: { type: "object" } } } }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("maxTokens");
  });
  it("maps the supported text/tool subset to the explicit Mantle model and API-key header", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ input_tokens: 321 })));
    expect(
      await new BedrockAdapter(settings, fetchImpl).countTokens(input, {
        mode: "mantle",
        model: "anthropic.fixture",
      }),
    ).toBe(321);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages/count_tokens",
    );
    expect(init!.headers).toMatchObject({
      "x-api-key": settings.bedrockToken,
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(init!.body as string)).toMatchObject({
      model: "anthropic.fixture",
      system: input.system,
      tool_choice: { type: "any" },
      messages: [
        { content: [{ type: "tool_use", id: "read-1" }] },
        { content: [{ type: "tool_result", tool_use_id: "read-1", is_error: true }] },
      ],
    });
  });
  it.each([
    new Response("denied", { status: 403 }),
    new Response('{"inputTokens":-1}'),
    new Response('{"inputTokens":"10"}'),
  ])("fails closed without falling back to a paid model", async (response) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(
      new BedrockAdapter(settings, fetchImpl).countTokens(input, {
        mode: "runtime",
        model: settings.bedrockModel,
      }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain("/converse");
  });
});
