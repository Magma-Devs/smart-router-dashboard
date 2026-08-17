import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTargetUrl,
  redactSecrets,
  relayHttp,
  relayWs,
  RelayTransportError,
  REDACTED,
} from "../services/upstream-relay.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTargetUrl", () => {
  it("returns the base untouched when no path is given", () => {
    expect(buildTargetUrl("https://rpc.example.com/v2/secretkey123").url).toBe(
      "https://rpc.example.com/v2/secretkey123",
    );
  });

  it("APPENDS a REST path to the upstream's own path", () => {
    // The killer case: the key lives in the base path. Replacing it (what
    // `new URL(path, base)` would do) turns a 200 into a mystery 404.
    const out = buildTargetUrl("https://rest.example.com/apikey-abcdef12", "/cosmos/base/tendermint/v1beta1/blocks/latest");
    expect(out).toEqual({
      ok: true,
      url: "https://rest.example.com/apikey-abcdef12/cosmos/base/tendermint/v1beta1/blocks/latest",
    });
  });

  it("merges the caller's query with the base's, keeping both", () => {
    const out = buildTargetUrl("https://rest.example.com/api?apikey=secretkey123", "/blocks?height=42");
    expect(out.ok).toBe(true);
    const url = new URL((out as { url: string }).url);
    expect(url.pathname).toBe("/api/blocks");
    expect(url.searchParams.get("apikey")).toBe("secretkey123");
    expect(url.searchParams.get("height")).toBe("42");
  });

  it("does not double the slash on a base with a trailing one", () => {
    expect(buildTargetUrl("https://rest.example.com/api/", "/blocks").url).toBe(
      "https://rest.example.com/api/blocks",
    );
  });

  it("collapses a run of trailing slashes without backtracking", () => {
    expect(buildTargetUrl(`https://rest.example.com/api${"/".repeat(5000)}`, "/blocks").url).toBe(
      "https://rest.example.com/api/blocks",
    );
  });

  it("appends the endpoint's auth-query with a `?` when the url has no query", () => {
    expect(buildTargetUrl("https://rpc.example.com/evm", undefined, "apikey=abcdef123456").url).toBe(
      "https://rpc.example.com/evm?apikey=abcdef123456",
    );
  });

  it("appends it with an `&` when the url (or the caller's path) already queries", () => {
    const out = buildTargetUrl("https://rest.example.com/api", "/blocks?height=42", "apikey=abc123");
    expect(out.url).toBe("https://rest.example.com/api/blocks?height=42&apikey=abc123");
  });

  it("does not double the separator a values file wrote into the auth-query", () => {
    expect(buildTargetUrl("https://rpc.example.com/evm", undefined, "?apikey=abc123").url).toBe(
      "https://rpc.example.com/evm?apikey=abc123",
    );
  });

  it.each([
    ["blocks", "no leading slash"],
    ["//evil.example.com/blocks", "protocol-relative"],
    ["/../../admin", "traversal"],
    ["/blocks\nHost: evil", "control character"],
    ["/blocks latest", "space"],
  ])("rejects %s (%s)", (path) => {
    const out = buildTargetUrl("https://rest.example.com/api", path);
    expect(out.ok).toBe(false);
  });
});

describe("redactSecrets", () => {
  const URL_WITH_KEY = "https://rpc.example.com/v2/sk-live-abcdef123456";

  it("blanks a key the upstream echoed back in its error body", () => {
    const body = `{"error":"no such project: /v2/sk-live-abcdef123456"}`;
    const out = redactSecrets(body, URL_WITH_KEY);
    expect(out).not.toContain("sk-live-abcdef123456");
    expect(out).toContain(REDACTED);
  });

  it("blanks the whole url when the body quotes it", () => {
    const out = redactSecrets(`failed to reach ${URL_WITH_KEY} twice`, URL_WITH_KEY);
    expect(out).toBe(`failed to reach ${REDACTED} twice`);
  });

  it("blanks a key carried in the query string", () => {
    const url = "https://rpc.example.com/rpc?apikey=abcdef1234567890";
    expect(redactSecrets(`bad key abcdef1234567890`, url)).toBe(`bad key ${REDACTED}`);
  });

  it("leaves short path segments alone — they are never keys", () => {
    // `/evm` is a real upstream path in the dev values file; blanking it
    // would mangle honest bodies for nothing.
    const out = redactSecrets(`{"result":"ok on /evm"}`, "https://rpc.hyperliquid.xyz/evm");
    expect(out).toBe(`{"result":"ok on /evm"}`);
  });

  it("blanks basic-auth credentials from the url", () => {
    const out = redactSecrets("auth failed for hunter2000", "https://user:hunter2000@rpc.example.com/");
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("hunter2000");
  });
});

describe("redactSecrets · declared credentials", () => {
  it("scrubs an auth-config header value the upstream echoed back", () => {
    const out = redactSecrets(
      `{"error":"invalid token Bearer 0f8d432c-18c2-47c0"}`,
      "https://rpc.example.com/evm",
      ["Bearer 0f8d432c-18c2-47c0"],
    );
    expect(out).not.toContain("0f8d432c-18c2-47c0");
  });

  it("scrubs the token on its own — a 401 rarely quotes the whole header", () => {
    const out = redactSecrets(`{"error":"unknown key sk-live-abcdef123456"}`, "https://rpc.example.com/", [
      "Bearer sk-live-abcdef123456",
    ]);
    expect(out).toBe(`{"error":"unknown key ${REDACTED}"}`);
  });

  it("leaves a short scheme word alone (`Bearer` is not the secret)", () => {
    const out = redactSecrets("Bearer token required", "https://rpc.example.com/", ["Bearer abc"]);
    expect(out).toBe("Bearer token required");
  });
});

describe("relayHttp", () => {
  const OPTS = { httpMethod: "POST" as const, timeoutMs: 5000, maxBodyBytes: 1024 };

  it("sends the JSON body, does not follow redirects, and reports the upstream status", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
    });

    const out = await relayHttp("https://rpc.example.com/key12345678", {
      ...OPTS,
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
    });

    expect(out.httpStatus).toBe(200);
    expect(out.transport).toBe("http");
    expect(out.truncated).toBe(false);
    expect(out.body).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(calls[0]!.url).toBe("https://rpc.example.com/key12345678");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
    });
  });

  it("sends no body for a POST that has none — a REST POST argues in the path", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    });
    await relayHttp("https://rest.example.com/wallet/getnowblock", { ...OPTS, httpMethod: "POST" });
    expect(calls[0]!.body).toBeUndefined();
    // No content-type either — there is no content.
    expect(calls[0]!.headers).toEqual({ accept: "application/json" });
  });

  it("sends the endpoint's auth-config headers — the credential the router attaches", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    });
    await relayHttp("https://rpc.example.com/evm", {
      ...OPTS,
      body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] },
      authHeaders: { Authorization: "Bearer 0f8d432c-18c2-47c0" },
    });
    expect(calls[0]!.headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      Authorization: "Bearer 0f8d432c-18c2-47c0",
    });
  });

  it("lets the values file's own content-type win over the relay's default", async () => {
    const calls: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response("{}", { status: 200 });
    });
    await relayHttp("https://rpc.example.com/evm", {
      ...OPTS,
      body: { id: 1 },
      authHeaders: { "content-type": "application/json-rpc" },
    });
    expect((calls[0]!.headers as Record<string, string>)["content-type"]).toBe("application/json-rpc");
  });

  it("scrubs the auth header's token out of what the upstream echoes", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(`{"error":"bad token tok-abcdef123456"}`, { status: 401 }),
    );
    const out = await relayHttp("https://rpc.example.com/evm", {
      ...OPTS,
      authHeaders: { Authorization: "Bearer tok-abcdef123456" },
    });
    expect(out.httpStatus).toBe(401);
    expect(JSON.stringify(out.body)).not.toContain("tok-abcdef123456");
  });

  it("hands back a 4xx from the upstream as data, not as a failure", async () => {
    vi.stubGlobal("fetch", async () => new Response(`{"error":"rate limited"}`, { status: 429 }));
    const out = await relayHttp("https://rpc.example.com/", OPTS);
    expect(out.httpStatus).toBe(429);
    expect(out.body).toEqual({ error: "rate limited" });
  });

  it("truncates a body past the cap instead of buffering it whole", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(5000), { status: 200 }));
    const out = await relayHttp("https://rpc.example.com/", { ...OPTS, maxBodyBytes: 100 });
    expect(out.truncated).toBe(true);
    expect((out.body as { _raw: string })._raw).toHaveLength(100);
  });

  it("scrubs the upstream's own url out of what it echoes", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(`{"error":"unknown project sk-live-abcdef123456"}`, { status: 401 }),
    );
    const out = await relayHttp("https://rpc.example.com/v2/sk-live-abcdef123456", OPTS);
    expect(JSON.stringify(out.body)).not.toContain("sk-live-abcdef123456");
  });

  it("raises a timeout-kind error when the upstream never answers", async () => {
    vi.stubGlobal("fetch", async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    });
    await expect(relayHttp("https://rpc.example.com/", OPTS)).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("raises a connect-kind error carrying the cause code but never the url", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const err = await relayHttp("https://rpc.example.com/secret-path-12345", OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(RelayTransportError);
    expect(err.kind).toBe("connect");
    expect(err.message).toContain("ENOTFOUND");
    expect(err.message).not.toContain("secret-path-12345");
  });
});

/**
 * The ws leg's credential rides on the HANDSHAKE, through an undici extension
 * the standard WebSocket types don't describe. A raw TCP listener reading the
 * upgrade request is the only way to prove it left the process — without this,
 * a Node release that drops the extension would silently stop sending the
 * operator's auth header and every gated ws upstream would look broken.
 */
describe("relayWs · handshake", () => {
  it("carries the endpoint's auth headers and auth-query on the upgrade request", async () => {
    let handshake = "";
    const server = createServer((socket) => {
      socket.once("data", (buf) => {
        handshake = buf.toString();
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    // The upstream never completes the handshake, so the relay rejects — the
    // request bytes are what this asserts on.
    await relayWs(`ws://127.0.0.1:${port}/evm?apikey=q-abcdef123456`, { id: 1 }, {
      timeoutMs: 2000,
      maxBodyBytes: 1024,
      authHeaders: { Authorization: "Bearer tok-abcdef123456" },
    }).catch(() => undefined);
    server.close();

    expect(handshake).toContain("GET /evm?apikey=q-abcdef123456 HTTP/1.1");
    expect(handshake).toContain("Authorization: Bearer tok-abcdef123456");
  });
});
