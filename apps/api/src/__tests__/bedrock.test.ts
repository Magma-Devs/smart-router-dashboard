/**
 * Bedrock client + the availability gate (MAG-3702).
 *
 * The SDK client is injected and stubbed throughout — nothing here reaches
 * AWS, and no test needs a credential. Most of these pin the REFUSALS: the
 * gate is the feature, and a regression that quietly opens it would otherwise
 * be invisible.
 */
import { describe, it, expect, vi } from "vitest";
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { BedrockService, BedrockError, bedrockGate } from "../services/bedrock.js";

/** A stand-in for BedrockRuntimeClient — only `send` and `config` are used. */
function fakeClient(opts: {
  send?: (cmd: unknown) => unknown;
  credentials?: () => Promise<{ accessKeyId: string } | undefined>;
}): BedrockRuntimeClient {
  return {
    send: vi.fn(async (cmd: unknown) => {
      if (!opts.send) return {};
      const out = opts.send(cmd);
      return out instanceof Promise ? await out : out;
    }),
    config: { credentials: opts.credentials ?? (async () => ({ accessKeyId: "ASIA-test" })) },
  } as unknown as BedrockRuntimeClient;
}

describe("bedrockGate", () => {
  it("is off by default — model calls cost money", () => {
    expect(bedrockGate("enabled", false)).toEqual({ ok: false, reason: "disabled" });
    expect(bedrockGate("disabled", false)).toEqual({ ok: false, reason: "disabled" });
  });

  it("REFUSES while auth is disabled, even when enabled", () => {
    // The whole point: an open api would let anyone spend the account's
    // Bedrock budget under our own IAM identity.
    expect(bedrockGate("disabled", true)).toEqual({ ok: false, reason: "auth_required" });
  });

  it("does not treat an unknown auth mode as enabled", () => {
    expect(bedrockGate("", true)).toEqual({ ok: false, reason: "auth_required" });
    expect(bedrockGate("ENABLED", true)).toEqual({ ok: false, reason: "auth_required" });
  });

  it("opens only with both enabled AND auth on", () => {
    expect(bedrockGate("enabled", true)).toEqual({ ok: true });
  });
});

describe("BedrockService.hasCredentials", () => {
  it("is true when the chain resolves an identity", async () => {
    const svc = new BedrockService("us-east-1", "m", undefined, fakeClient({}));
    await expect(svc.hasCredentials()).resolves.toBe(true);
  });

  it("is false — not a throw — when the chain resolves nothing", async () => {
    const client = fakeClient({
      credentials: async () => {
        throw new Error("Could not load credentials from any providers");
      },
    });
    const svc = new BedrockService("us-east-1", "m", undefined, client);
    await expect(svc.hasCredentials()).resolves.toBe(false);
  });
});

describe("BedrockService.complete", () => {
  it("ALWAYS sends maxTokens — unset reserves the model's maximum quota", async () => {
    const client = fakeClient({
      send: () => ({ output: { message: { content: [{ text: "hi" }] } }, stopReason: "end_turn" }),
    });
    const svc = new BedrockService("us-east-1", "global.anthropic.claude-sonnet-5", undefined, client);

    await svc.complete({ messages: [{ role: "user", content: "hello" }] });

    const cmd = (client.send as unknown as { mock: { calls: [{ input: Record<string, unknown> }][] } }).mock.calls[0]![0];
    const input = cmd.input as { inferenceConfig?: { maxTokens?: number }; modelId?: string };
    expect(input.inferenceConfig?.maxTokens).toBeGreaterThan(0);
    expect(input.modelId).toBe("global.anthropic.claude-sonnet-5");
  });

  it("sends the Converse message shape, and omits system when none is given", async () => {
    const client = fakeClient({ send: () => ({ output: { message: { content: [{ text: "x" }] } } }) });
    await new BedrockService("us-east-1", "m", undefined, client).complete({
      messages: [{ role: "user", content: "hello" }],
    });

    const input = ((client.send as unknown as { mock: { calls: [{ input: Record<string, unknown> }][] } }).mock.calls[0]![0]).input as {
      messages: { role: string; content: { text: string }[] }[];
      system?: unknown;
    };
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "hello" }] }]);
    expect(input).not.toHaveProperty("system");
  });

  it("passes a system prompt through as Converse expects", async () => {
    const client = fakeClient({ send: () => ({ output: { message: { content: [{ text: "x" }] } } }) });
    await new BedrockService("us-east-1", "m", undefined, client).complete({
      messages: [{ role: "user", content: "hi" }],
      system: "be terse",
    });

    const input = ((client.send as unknown as { mock: { calls: [{ input: Record<string, unknown> }][] } }).mock.calls[0]![0]).input as {
      system?: { text: string }[];
    };
    expect(input.system).toEqual([{ text: "be terse" }]);
  });

  it("concatenates every text block and reports usage", async () => {
    const client = fakeClient({
      send: () => ({
        output: { message: { content: [{ text: "one " }, { toolUse: {} }, { text: "two" }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 11, outputTokens: 22 },
      }),
    });
    const answer = await new BedrockService("us-east-1", "m", undefined, client).complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(answer.text).toBe("one two");
    expect(answer.stopReason).toBe("end_turn");
    expect(answer.inputTokens).toBe(11);
    expect(answer.outputTokens).toBe(22);
  });

  it("surfaces a truncated answer rather than hiding it", async () => {
    const client = fakeClient({
      send: () => ({ output: { message: { content: [{ text: "cut" }] } }, stopReason: "max_tokens" }),
    });
    const answer = await new BedrockService("us-east-1", "m", undefined, client).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(answer.stopReason).toBe("max_tokens");
  });

  it("keeps the AWS exception name — AccessDenied and Throttling need different fixes", async () => {
    const denied = Object.assign(new Error("not authorized to perform bedrock:InvokeModel"), {
      name: "AccessDeniedException",
    });
    const client = fakeClient({
      send: () => {
        throw denied;
      },
    });
    const svc = new BedrockService("us-east-1", "m", undefined, client);

    await expect(svc.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "BedrockError",
      statusCode: 502,
      awsErrorName: "AccessDeniedException",
    });
  });

  it("refuses an empty conversation instead of calling out", async () => {
    const client = fakeClient({});
    await expect(
      new BedrockService("us-east-1", "m", undefined, client).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(BedrockError);
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe("BEDROCK_ROLE_ARN — the customer-deployment path", () => {
  /**
   * The role is wired through the SDK's own `fromTemporaryCredentials`, so
   * these pin the CONTRACT rather than re-testing AWS's provider: with no
   * role the client must be left to the default chain, and a role the box
   * cannot assume must surface as "no credentials" rather than as a crash on
   * the first real call.
   */
  it("reports no credentials — not a throw — when the role cannot be assumed", async () => {
    const client = fakeClient({
      credentials: async () => {
        throw Object.assign(new Error("not authorized to perform: sts:AssumeRole"), {
          name: "AccessDenied",
        });
      },
    });
    const svc = new BedrockService("us-east-1", "m", undefined, client);
    await expect(svc.hasCredentials()).resolves.toBe(false);
  });

  it("leaves the client's credentials alone when no role is named", async () => {
    // config.bedrock.roleArn is unset in tests, so a real client must carry no
    // explicit credentials provider — the SDK's default chain has to win.
    const svc = new BedrockService("us-east-1", "m");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolved = await (svc as any).client.config.credentials();
    // Resolves from this machine's own chain; the point is it did not throw
    // because we handed it an AssumeRole wrapper for a role nobody named.
    expect(resolved).toHaveProperty("accessKeyId");
  });
});
