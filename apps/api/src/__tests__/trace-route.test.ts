/**
 * `GET /api/trace/:guid` — the relay trace lookup.
 *
 * Env is set BEFORE the app (and its config snapshot) is imported. The model
 * call is never made: `TRACE_AI_ENABLED` stays false here so these exercise
 * the log path, and the explanation parsing is pinned separately in
 * `trace-explain.test.ts`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

process.env.LOKI_URL = "http://loki.test:3100";
process.env.TRACE_AI_ENABLED = "false";

const { buildApp } = await import("../app.js");

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A Loki query_range payload with the given lines in one stream. */
function lokiStreams(values: [string, string][], level = "info") {
  return new Response(
    JSON.stringify({ status: "success", data: { resultType: "streams", result: [{ stream: { service: "router", level }, values }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const GUID = "8471029384710293";

describe("GET /api/trace/:guid", () => {
  it("returns the relay's lines, oldest first", async () => {
    vi.stubGlobal("fetch", async () =>
      lokiStreams([
        ["1700000002000000000", `{"level":"error","GUID":"${GUID}","message":"failed relay"}`],
        ["1700000001000000000", `{"level":"info","GUID":"${GUID}","message":"Consumer received a new JSON-RPC request"}`],
      ]),
    );

    const res = await app.inject({ method: "GET", url: `/api/trace/${GUID}` });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.guid).toBe(GUID);
    expect(json.lines).toHaveLength(2);
    // Loki orders within a stream, not across them — and a relay spans streams
    // whenever the level changes mid-relay, which is when things go wrong.
    expect(json.lines[0].tMs).toBeLessThan(json.lines[1].tMs);
    expect(json.lines[0].line).toContain("Consumer received");
    expect(json.truncated).toBe(false);
  });

  it("orders lines written inside the SAME millisecond", async () => {
    // The regression this pins: a router relay writes most of its trail inside
    // one or two milliseconds, so sorting on a millisecond key leaves the
    // densest stretch of the story shuffled — and the entry line rendering
    // fourth is what the model is handed as "oldest first".
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          status: "success",
          data: { resultType: "streams", result: [
            // Same millisecond (…832), separate streams, deliberately reversed.
            { stream: { service: "router", level: "info" }, values: [
              ["1788290214832805336", '{"message":"CALCULATING VALID ADDRESSES"}'],
            ]},
            { stream: { service: "router", level: "debug" }, values: [
              ["1788290214832748128", '{"message":"CrossValidation mode enabled"}'],
            ]},
            { stream: { service: "router", level: "info" }, values: [
              ["1788290214832537253", '{"message":"Consumer received a new JSON-RPC request"}'],
            ]},
          ]},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const json = (await app.inject({ method: "GET", url: `/api/trace/${GUID}` })).json();
    const messages = json.lines.map((l: { line: string }) => JSON.parse(l.line).message);
    expect(messages).toEqual([
      "Consumer received a new JSON-RPC request", // the relay's actual start
      "CrossValidation mode enabled",
      "CALCULATING VALID ADDRESSES",
    ]);
    // All three collapse to one millisecond, so tMs cannot be the sort key.
    expect(new Set(json.lines.map((l: { tMs: number }) => l.tMs)).size).toBe(1);
  });

  it("puts the GUID in the query as a field match, not just a substring", async () => {
    let seen = "";
    vi.stubGlobal("fetch", async (url: string | URL) => {
      seen = String(url);
      return lokiStreams([["1700000001000000000", "{}"]]);
    });

    await app.inject({ method: "GET", url: `/api/trace/${GUID}` });
    const query = new URL(seen).searchParams.get("query") ?? "";
    expect(query).toContain(`|= \`${GUID}\``);
    expect(query).toContain(`| json | GUID = \`${GUID}\``);
    // Cheap byte filter must precede the parse, or this times out in prod.
    expect(query.indexOf("|=")).toBeLessThan(query.indexOf("| json"));
  });

  it("widens the search window until it finds the relay, then stops", async () => {
    const windows: number[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const p = new URL(String(url)).searchParams;
      const spanSec = (Number(p.get("end")) - Number(p.get("start"))) / 1e9;
      windows.push(Math.round(spanSec));
      // Nothing in the first two windows; a hit in the third.
      return windows.length < 3 ? lokiStreams([]) : lokiStreams([["1700000001000000000", "{}"]]);
    });

    const res = await app.inject({ method: "GET", url: `/api/trace/${GUID}` });
    expect(res.statusCode).toBe(200);
    expect(windows).toEqual([900, 3600, 21600]); // stopped at the hit
  });

  it("reports a truncated trail rather than passing it off as a short relay", async () => {
    process.env.TRACE_MAX_LINES = "2";
    vi.resetModules();
    const { buildApp: build } = await import("../app.js");
    const scoped = await build();
    await scoped.ready();

    vi.stubGlobal("fetch", async () =>
      lokiStreams([
        ["1700000001000000000", "a"],
        ["1700000002000000000", "b"],
        ["1700000003000000000", "c"],
      ]),
    );

    const res = await scoped.inject({ method: "GET", url: `/api/trace/${GUID}` });
    const json = res.json();
    expect(json.truncated).toBe(true);
    expect(json.lines).toHaveLength(2);

    await scoped.close();
    delete process.env.TRACE_MAX_LINES;
    vi.resetModules();
  });

  it("makes NO model call — the lookup is free and the explanation is a separate ask", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      hosts.push(new URL(String(url)).host);
      return lokiStreams([["1700000001000000000", "{}"]]);
    });

    const json = (await app.inject({ method: "GET", url: `/api/trace/${GUID}` })).json();
    // Opening a trace must never spend: the URL is meant to be pasted around.
    expect(hosts.every((h) => !h.includes("anthropic"))).toBe(true);
    expect(json).not.toHaveProperty("explanation");
    // AI is off in this suite, so the page knows not to offer the button.
    expect(json.aiAvailable).toBe(false);
    expect(json.model).toBeNull();
  });

  it("returns an empty trail rather than an error when nothing carries the GUID", async () => {
    vi.stubGlobal("fetch", async () => lokiStreams([]));
    const res = await app.inject({ method: "GET", url: `/api/trace/${GUID}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().lines).toEqual([]);
  });

  it("does not apply the model rate limit to the free lookup", async () => {
    vi.stubGlobal("fetch", async () => lokiStreams([["1700000001000000000", "{}"]]));
    // The tight limit protects a model budget; with the AI off there is none,
    // and behind an ingress every dashboard user shares one IP bucket.
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: "GET", url: `/api/trace/${GUID}` });
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
  });

  it("rejects anything that is not a GUID", async () => {
    for (const bad of ["abc", "1%60%20or%20%601", "-1", "99999999999999999999"]) {
      const res = await app.inject({ method: "GET", url: `/api/trace/${bad}` });
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it("distinguishes an unreachable log store from an empty answer", async () => {
    vi.stubGlobal("fetch", async () => new Response("upstream is down", { status: 502 }));
    const res = await app.inject({ method: "GET", url: `/api/trace/${GUID}` });
    // 503, not a 200 with no lines: "we could not look" must never render as
    // "that relay does not exist".
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("log_store_unavailable");
  });
});

describe("POST /api/trace/:guid/explain", () => {
  it("404s when the AI is off, naming which half is missing", async () => {
    const res = await app.inject({ method: "POST", url: `/api/trace/${GUID}/explain`, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("ai_disabled");
  });

  it("accepts a caller's own key even when the deployment has none", async () => {
    // The whole point of bring-your-own-key: a deployment holding no secret
    // must not block someone who brought their own.
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      if (String(url).includes("generativelanguage")) {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "ok" }) }] }, finishReason: "STOP" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return lokiStreams([["1700000001000000000", "{}"]]);
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/trace/${GUID}/explain`,
      payload: { provider: "gemini", model: "gemini-3.6-flash", apiKey: "caller-key" },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.usedCallerKey).toBe(true);
    expect(json.provider).toBe("gemini");
    // A secret that arrived in a request body has no business in the response.
    expect(res.body).not.toContain("caller-key");
    expect(json).not.toHaveProperty("apiKey");
    expect(body).not.toEqual({});
  });

  it("strips unknown fields so they never reach the handler", async () => {
    // Fastify's ajv runs with removeAdditional, so `additionalProperties:
    // false` DROPS extras rather than 400ing on them. Either is safe; what
    // matters is that a field nobody declared cannot ride along with a body
    // that carries a secret.
    let outbound = "";
    vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit) => {
      if (String(url).includes("generativelanguage")) {
        outbound = String(init.body);
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: "ok" }) }] }, finishReason: "STOP" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return lokiStreams([["1700000001000000000", "{}"]]);
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/trace/${GUID}/explain`,
      payload: { provider: "gemini", apiKey: "caller-key", exfiltrateTo: "https://evil.example" },
    });

    expect(res.statusCode).toBe(200);
    expect(outbound).not.toContain("evil.example");
    expect(res.body).not.toContain("evil.example");
  });

  it("rejects a non-GUID before it reaches the model", async () => {
    const res = await app.inject({ method: "POST", url: "/api/trace/abc/explain", payload: {} });
    // 404 (ai off) is checked first here; the point is it never 500s.
    expect([400, 404]).toContain(res.statusCode);
  });
});

describe("GET /api/trace/:guid with no log store configured", () => {
  it("says there is no log store rather than returning an empty trace", async () => {
    delete process.env.LOKI_URL;
    vi.resetModules();
    const { buildApp: build } = await import("../app.js");
    const bare = await build();
    await bare.ready();

    const res = await bare.inject({ method: "GET", url: `/api/trace/${GUID}` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("log_store_not_configured");

    await bare.close();
    process.env.LOKI_URL = "http://loki.test:3100";
    vi.resetModules();
  });
});
