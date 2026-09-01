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

  it("skips the explanation, with a reason, when the AI is off", async () => {
    vi.stubGlobal("fetch", async () => lokiStreams([["1700000001000000000", "{}"]]));
    const json = (await app.inject({ method: "GET", url: `/api/trace/${GUID}` })).json();
    // The page still renders: lines without an answer beats an error.
    expect(json.explanation).toBeNull();
    expect(json.explainSkipped).toBe("disabled");
  });

  it("says so when the relay has no lines at all", async () => {
    vi.stubGlobal("fetch", async () => lokiStreams([]));
    const json = (await app.inject({ method: "GET", url: `/api/trace/${GUID}` })).json();
    expect(json.lines).toEqual([]);
    expect(json.explainSkipped).toBe("no_lines");
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
