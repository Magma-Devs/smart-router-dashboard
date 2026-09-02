/**
 * The Gemini transport.
 *
 * Gemini goes over plain `fetch` rather than an SDK, so the request shape is
 * ours to get right and worth pinning: a wrong field name fails at runtime
 * with a 400 that reads like a key problem. The model call itself is stubbed —
 * `.claude/rules/testing.md` forbids reaching a real endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const LINES = [
  { tMs: 1788290214832, line: '{"message":"Consumer received a new JSON-RPC request"}', level: "info" },
  { tMs: 1788290215137, line: '{"message":"jsonrpc http","HasError":true}', level: "error" },
];

const ANSWER = {
  summary: "eth_getBalance on ETH1 failed — both upstreams rejected the parameter.",
  timeline: [{ at: "+0.000s", what: "Request received" }],
  findings: [{ severity: "warning", title: "Invalid params", detail: "Both providers rejected it." }],
  notDetermined: ["whether the caller retried"],
};

/** A Gemini generateContent response carrying `text`. */
function geminiOk(text: string) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** Load the service with a fresh config snapshot for the given env. */
async function loadWith(env: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.resetModules();
  return import("../services/trace-explain.js");
}

const CLEAN = {
  TRACE_AI_ENABLED: "true",
  ANTHROPIC_API_KEY: undefined,
  GEMINI_API_KEY: undefined,
  TRACE_AI_PROVIDER: undefined,
  TRACE_AI_MODEL: undefined,
};

beforeEach(() => {
  for (const k of Object.keys(CLEAN)) delete process.env[k];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const k of Object.keys(CLEAN)) delete process.env[k];
});

describe("provider selection", () => {
  it("infers gemini from the key alone, so one env var is enough", async () => {
    const { explainAvailable } = await loadWith({ ...CLEAN, GEMINI_API_KEY: "g-key" });
    expect(explainAvailable()).toBe(true);
  });

  it("prefers an explicit TRACE_AI_PROVIDER over the key that happens to be set", async () => {
    // Both keys present, gemini named: gemini must win, or the override is
    // decoration.
    let seenUrl = "";
    vi.stubGlobal("fetch", async (url: string | URL) => {
      seenUrl = String(url);
      return geminiOk(JSON.stringify(ANSWER));
    });
    const { explainTrace } = await loadWith({
      ...CLEAN,
      ANTHROPIC_API_KEY: "a-key",
      GEMINI_API_KEY: "g-key",
      TRACE_AI_PROVIDER: "gemini",
    });
    await explainTrace("42", LINES, false);
    expect(seenUrl).toContain("generativelanguage.googleapis.com");
  });

  it("is unavailable when the named provider's key is missing", async () => {
    // A button offered for a call that can only fail is worse than no button.
    const { explainAvailable } = await loadWith({
      ...CLEAN,
      TRACE_AI_PROVIDER: "gemini",
      ANTHROPIC_API_KEY: "a-key",
    });
    expect(explainAvailable()).toBe(false);
  });

  it("is unavailable with no key at all, even when enabled", async () => {
    const { explainAvailable } = await loadWith({ ...CLEAN });
    expect(explainAvailable()).toBe(false);
  });
});

describe("the Gemini request", () => {
  it("sends the prompt, the lines and a JSON response constraint", async () => {
    let url = "";
    let init: RequestInit = {};
    vi.stubGlobal("fetch", async (u: string | URL, i: RequestInit) => {
      url = String(u);
      init = i;
      return geminiOk(JSON.stringify(ANSWER));
    });

    const { explainTrace } = await loadWith({ ...CLEAN, GEMINI_API_KEY: "g-key" });
    const out = await explainTrace("42", LINES, false);

    expect(url).toContain("/v1beta/models/gemini-3.6-flash:generateContent");
    // Key in a header, not the query string: a URL is the thing proxies and
    // access logs keep.
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    expect(url).not.toContain("g-key");

    const body = JSON.parse(String(init.body));
    expect(body.systemInstruction.parts[0].text).toContain("Smart Router");
    expect(body.contents[0].parts[0].text).toContain("Relay GUID: 42");
    expect(body.contents[0].parts[0].text).toContain("[+0.000s]");
    // Constrains the model to bare JSON, which is the drift the parser would
    // otherwise have to absorb.
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    // Gemini's flash models think, and thinking counts against this budget.
    // Measured: a steady ~650-token answer against thoughts ranging 692-1388,
    // so 2000 truncates SOMETIMES — the worst kind of failure.
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(8000);

    expect(out.explanation.summary).toContain("eth_getBalance");
    expect(out.explanation.notDetermined).toHaveLength(1);
    // The caller supplied no key here, so the deployment's answered.
    expect(out.usedCallerKey).toBe(false);
    expect(out.provider).toBe("gemini");
  });

  it("treats an EMPTY TRACE_AI_MODEL as unset, not as a model name", async () => {
    // Compose passes optional vars as `FOO=${FOO:-}`, i.e. the empty string.
    // `?? fallback` does not catch that, and the result was a request to
    // `/models/:generateContent` — a 404 that reads like a bad key.
    let url = "";
    vi.stubGlobal("fetch", async (u: string | URL) => {
      url = String(u);
      return geminiOk(JSON.stringify(ANSWER));
    });
    const { explainTrace } = await loadWith({ ...CLEAN, GEMINI_API_KEY: "g-key", TRACE_AI_MODEL: "" });
    await explainTrace("42", LINES, false);
    expect(url).toContain("gemini-3.6-flash:generateContent");
    expect(url).not.toContain("models/:");
  });

  it("honours TRACE_AI_MODEL, since model names move faster than this repo", async () => {
    let url = "";
    vi.stubGlobal("fetch", async (u: string | URL) => {
      url = String(u);
      return geminiOk(JSON.stringify(ANSWER));
    });
    const { explainTrace } = await loadWith({
      ...CLEAN,
      GEMINI_API_KEY: "g-key",
      TRACE_AI_MODEL: "gemini-3-experimental",
    });
    await explainTrace("42", LINES, false);
    expect(url).toContain("gemini-3-experimental:generateContent");
  });

  it("reports an HTTP failure with the status, not as a parse error", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":{"message":"API key not valid"}}', { status: 400 }));
    const { explainTrace, TraceExplainError } = await loadWith({ ...CLEAN, GEMINI_API_KEY: "bad" });
    await expect(explainTrace("42", LINES, false)).rejects.toThrow(TraceExplainError);
    await expect(explainTrace("42", LINES, false)).rejects.toThrow(/400.*API key not valid/s);
  });

  it("names finishReason when the answer comes back empty", async () => {
    // Hitting the token ceiling produces no text. Reporting that as "invalid
    // JSON" would send someone debugging the wrong thing.
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { explainTrace } = await loadWith({ ...CLEAN, GEMINI_API_KEY: "g-key" });
    await expect(explainTrace("42", LINES, false)).rejects.toThrow(/MAX_TOKENS/);
  });

  it("still tolerates a fenced answer, mime-type constraint notwithstanding", async () => {
    vi.stubGlobal("fetch", async () => geminiOk("```json\n" + JSON.stringify(ANSWER) + "\n```"));
    const { explainTrace } = await loadWith({ ...CLEAN, GEMINI_API_KEY: "g-key" });
    expect((await explainTrace("42", LINES, false)).explanation.summary).toContain("eth_getBalance");
  });
});
