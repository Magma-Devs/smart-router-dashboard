/**
 * Bedrock client + the availability gate (MAG-3702).
 *
 * The SDK client is injected and stubbed throughout — nothing here reaches AWS
 * and no test needs a credential, so these pass in CI exactly as they do on a
 * developer's machine. Most pin the REFUSALS: the gate is the feature, and a
 * regression that quietly opens it would otherwise be invisible.
 */
import { describe, it, expect, vi } from "vitest";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockService, BedrockError, bedrockGate } from "../services/bedrock.js";

/** A stand-in for BedrockRuntimeClient — only `send` is used. */
function fakeClient(send?: () => unknown): BedrockRuntimeClient {
  return { send: vi.fn(async () => send?.() ?? {}) } as unknown as BedrockRuntimeClient;
}

/** The ConverseCommand input the service built for its one call. */
function sentInput(client: BedrockRuntimeClient) {
  const calls = (client.send as unknown as { mock: { calls: [{ input: unknown }][] } }).mock.calls;
  return calls[0]![0].input as {
    modelId?: string;
    messages?: { role: string; content: { text: string }[] }[];
    system?: { text: string }[];
    inferenceConfig?: { maxTokens?: number };
  };
}

describe("bedrockGate", () => {
  it("is off by default — model calls cost money", () => {
    expect(bedrockGate("enabled", false)).toEqual({ ok: false, reason: "disabled" });
  });

  it("REFUSES while auth is disabled, and treats an unknown mode as disabled", () => {
    // The whole point: an open api would let anyone spend the account's
    // Bedrock budget under our own IAM identity.
    for (const mode of ["disabled", "", "ENABLED"]) {
      expect(bedrockGate(mode, true)).toEqual({ ok: false, reason: "auth_required" });
    }
  });

  it("opens only with both enabled AND auth on", () => {
    expect(bedrockGate("enabled", true)).toEqual({ ok: true });
  });
});

describe("BedrockService.complete", () => {
  it("always sends maxTokens, and the Converse shape, and no system when none given", async () => {
    // maxTokens unset would reserve the model's MAXIMUM quota per call, which
    // is the usual cause of an unexplained ThrottlingException.
    const client = fakeClient(() => ({ output: { message: { content: [{ text: "hi" }] } } }));
    await new BedrockService("global.anthropic.claude-sonnet-5", undefined, client).complete({
      messages: [{ role: "user", content: "hello" }],
    });

    const input = sentInput(client);
    expect(input.inferenceConfig?.maxTokens).toBeGreaterThan(0);
    expect(input.modelId).toBe("global.anthropic.claude-sonnet-5");
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "hello" }] }]);
    expect(input).not.toHaveProperty("system");
  });

  it("passes a system prompt through as Converse expects", async () => {
    const client = fakeClient(() => ({ output: { message: { content: [{ text: "x" }] } } }));
    await new BedrockService("m", undefined, client).complete({
      messages: [{ role: "user", content: "hi" }],
      system: "be terse",
    });
    expect(sentInput(client).system).toEqual([{ text: "be terse" }]);
  });

  it("concatenates every text block, reports usage, and surfaces truncation", async () => {
    const client = fakeClient(() => ({
      output: { message: { content: [{ text: "one " }, { toolUse: {} }, { text: "two" }] } },
      stopReason: "max_tokens",
      usage: { inputTokens: 11, outputTokens: 22 },
    }));
    const answer = await new BedrockService("m", undefined, client).complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(answer).toEqual({
      text: "one two",
      stopReason: "max_tokens",
      inputTokens: 11,
      outputTokens: 22,
    });
  });

  it("keeps the AWS exception name — AccessDenied and Throttling need different fixes", async () => {
    // Covers the role that cannot be assumed too: the SDK raises that as an
    // AccessDenied on the same path, and the name is what makes it actionable.
    const client = fakeClient(() => {
      throw Object.assign(new Error("is not authorized to perform: sts:AssumeRole"), {
        name: "AccessDeniedException",
      });
    });

    await expect(
      new BedrockService("m", undefined, client).complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ name: "BedrockError", statusCode: 502, awsErrorName: "AccessDeniedException" });
  });

  it("refuses an empty conversation instead of calling out", async () => {
    const client = fakeClient();
    await expect(
      new BedrockService("m", undefined, client).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(BedrockError);
    expect(client.send).not.toHaveBeenCalled();
  });
});
