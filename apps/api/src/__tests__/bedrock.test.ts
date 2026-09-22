/**
 * Bedrock client + availability gate (MAG-3702).
 *
 * `fetch` is stubbed throughout — nothing here reaches AWS, and no test needs
 * a credential. The point of most of these is the REFUSALS: the gate is the
 * feature, and a regression that quietly opens it would otherwise be invisible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BedrockService,
  BedrockError,
  bedrockAvailability,
} from "../services/bedrock.js";

const KEY = "test-bearer-token";

function stubFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) => impl(String(url), init as RequestInit));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bedrockAvailability", () => {
  it("is unavailable with no key, whatever the auth mode", () => {
    expect(bedrockAvailability("enabled", undefined)).toEqual({ ok: false, reason: "not_configured" });
    expect(bedrockAvailability("disabled", undefined)).toEqual({ ok: false, reason: "not_configured" });
  });

  it("REFUSES a configured key while auth is disabled", () => {
    // The whole point: an open api must not hand out a credential whose IAM
    // policy covers InvokeModel on Resource:"*".
    expect(bedrockAvailability("disabled", KEY)).toEqual({ ok: false, reason: "auth_required" });
  });

  it("does not treat an unknown auth mode as enabled", () => {
    expect(bedrockAvailability("", KEY)).toEqual({ ok: false, reason: "auth_required" });
    expect(bedrockAvailability("ENABLED", KEY)).toEqual({ ok: false, reason: "auth_required" });
  });

  it("is available only with a key AND auth enabled", () => {
    expect(bedrockAvailability("enabled", KEY)).toEqual({ ok: true });
  });
});

describe("BedrockService.complete", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("sends bearer auth to the region's InvokeModel endpoint", async () => {
    const spy = stubFetch(() => ok({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }));
    const svc = new BedrockService(KEY, "us-east-1", "global.anthropic.claude-sonnet-5");

    await svc.complete({ messages: [{ role: "user", content: "hello" }] });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-5/invoke",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("never sends temperature — Sonnet 5 rejects it with a 400", async () => {
    const spy = stubFetch(() => ok({ content: [{ type: "text", text: "x" }] }));
    await new BedrockService(KEY).complete({ messages: [{ role: "user", content: "hi" }] });

    const body = JSON.parse((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("temperature");
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
  });

  it("omits `system` entirely when none is given, rather than sending empty", async () => {
    const spy = stubFetch(() => ok({ content: [{ type: "text", text: "x" }] }));
    await new BedrockService(KEY).complete({ messages: [{ role: "user", content: "hi" }] });

    const body = JSON.parse((spy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("system");
  });

  it("concatenates every text block and reports usage", async () => {
    stubFetch(() =>
      ok({
        content: [{ type: "text", text: "one " }, { type: "thinking" }, { type: "text", text: "two" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 11, output_tokens: 22 },
      }),
    );
    const answer = await new BedrockService(KEY).complete({ messages: [{ role: "user", content: "hi" }] });

    expect(answer.text).toBe("one two");
    expect(answer.stopReason).toBe("end_turn");
    expect(answer.inputTokens).toBe(11);
    expect(answer.outputTokens).toBe(22);
  });

  it("surfaces a truncated answer rather than hiding it", async () => {
    stubFetch(() => ok({ content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens" }));
    const answer = await new BedrockService(KEY).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(answer.stopReason).toBe("max_tokens");
  });

  it("throws with the upstream status on an HTTP error", async () => {
    stubFetch(() => new Response("ValidationException: bad model", { status: 400 }));
    const svc = new BedrockService(KEY);

    await expect(svc.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({
      name: "BedrockError",
      statusCode: 502,
      upstreamStatus: 400,
    });
  });

  it("throws when the key is absent instead of calling out unauthenticated", async () => {
    const spy = stubFetch(() => ok({}));
    await expect(
      new BedrockService(undefined).complete({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toBeInstanceOf(BedrockError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never puts the credential in a log line", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const warn = vi.fn();
    const svc = new BedrockService(KEY, "us-east-1", "m", 60000, { warn });

    await expect(svc.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();

    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });
});
