import { afterEach, describe, expect, it, vi } from "vitest";
import { noteRefusedRead, trackReads } from "../services/read-health.js";
import { PrometheusClient } from "../services/prometheus-client.js";

const BASE = "http://prometheus.test:9090";

/** Lets queued work on other contexts run. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => vi.unstubAllGlobals());

describe("read health", () => {
  it("counts per context, not globally", async () => {
    let releaseA!: () => void;
    const a = trackReads(async () => {
      noteRefusedRead();
      await new Promise<void>((resolve) => (releaseA = resolve));
      noteRefusedRead();
      return "a";
    });
    // These two run while `a` is still open.
    const b = trackReads(async () => {
      await tick();
      noteRefusedRead();
      return "b";
    });
    const c = trackReads(async () => {
      await tick();
      return "c";
    });
    expect(await b).toEqual({ value: "b", refused: 1 });
    expect(await c).toEqual({ value: "c", refused: 0 });
    releaseA();
    expect(await a).toEqual({ value: "a", refused: 2 });
  });

  it("outside a context a refused read counts nowhere", async () => {
    noteRefusedRead();
    expect(await trackReads(async () => 1)).toEqual({ value: 1, refused: 0 });
  });

  it("a throw inside the block reaches the caller", async () => {
    await expect(
      trackReads(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("PrometheusClient notes each read the store refused", () => {
  const client = (timeoutMs = 1000) => new PrometheusClient(BASE, timeoutMs, null, {}, { cacheTtlMs: 0 });

  it.each([
    ["a non-2xx answer", () => new Response("too many outstanding requests", { status: 429 })],
    ["an error envelope", () => Response.json({ status: "error", errorType: "execution", error: "query timed out" })],
    [
      "a dropped connection",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("%s counts once against the work that read", async (_name, respond) => {
    vi.stubGlobal("fetch", async () => respond());
    expect(await trackReads(() => client().query("up"))).toEqual({ value: [], refused: 1 });
  });

  it("a timeout counts", async () => {
    vi.stubGlobal(
      "fetch",
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    expect(await trackReads(() => client(10).query("up"))).toEqual({ value: [], refused: 1 });
  });

  it("an answer counts nothing", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ status: "success", data: { resultType: "vector", result: [] } }));
    expect(await trackReads(() => client().query("up"))).toEqual({ value: [], refused: 0 });
  });

  it("only the work that issued a read counts its refusal, not work that joined it in flight", async () => {
    let refuse!: () => void;
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls++;
      return new Promise<Response>((resolve) => (refuse = () => resolve(new Response("busy", { status: 503 }))));
    });
    const shared = client();
    const issuer = trackReads(() => shared.query("up"));
    await tick();
    const joiner = trackReads(() => shared.query("up"));
    await tick();
    refuse();
    expect(await issuer).toEqual({ value: [], refused: 1 });
    expect(await joiner).toEqual({ value: [], refused: 0 });
    expect(calls).toBe(1);
  });
});
