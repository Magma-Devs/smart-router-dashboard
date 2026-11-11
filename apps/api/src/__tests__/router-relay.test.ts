import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directiveHeaders,
  probeRouterWs,
  relayRouterHttp,
  relayRouterWs,
  retriesOf,
} from "../services/router-relay.js";
import { RelayTransportError } from "../services/upstream-relay.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OPTS = { httpMethod: "POST" as const, headers: {}, timeoutMs: 1000, maxBodyBytes: 1024 };

describe("directiveHeaders", () => {
  it("turns the drawer's two directives into the headers the router reads", () => {
    expect(directiveHeaders({ selectProvider: "eth-publicnode", forceCacheRefresh: true })).toEqual({
      "lava-select-provider": "eth-publicnode",
      "lava-force-cache-refresh": "true",
    });
  });

  it("sends nothing for a directive that is unset or off", () => {
    expect(directiveHeaders({})).toEqual({});
    expect(directiveHeaders({ selectProvider: "", forceCacheRefresh: false })).toEqual({});
  });
});

describe("retriesOf", () => {
  it("reads the count, and absent or blank as unknown", () => {
    expect(retriesOf("2")).toBe(2);
    expect(retriesOf("0")).toBe(0);
    expect(retriesOf(null)).toBeNull();
    expect(retriesOf("")).toBeNull();
  });

  it("counts a value that is not a number as no retries, as the drawer always has", () => {
    expect(retriesOf("many")).toBe(0);
  });
});

describe("relayRouterHttp", () => {
  it("hands back the router's body and its Lava-* telemetry", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x10" }), {
        status: 200,
        headers: {
          "Lava-Provider-Address": "eth-publicnode",
          "Lava-Retries": "1",
          "Lava-Cross-Validation-Status": "agreed",
          "Lava-Cross-Validation-Agreeing-Providers": "a,b",
          "Lava-Cross-Validation-Disagreeing-Providers": "",
        },
      }),
    );
    const res = await relayRouterHttp("http://eth1-router:3000/", { ...OPTS, body: { id: 1 } });
    expect(res).toMatchObject({
      httpStatus: 200,
      body: { result: "0x10" },
      truncated: false,
      transport: "http",
      servedBy: "eth-publicnode",
      retries: 1,
      cvStatus: "agreed",
      cvAgreeing: "a,b",
      cvDisagreeing: "",
    });
  });

  it("sends the directive headers and the JSON body, and nothing else of the caller's", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    await relayRouterHttp("http://eth1-router:3000/", {
      ...OPTS,
      body: { method: "eth_blockNumber" },
      headers: { "lava-select-provider": "eth-publicnode" },
    });
    const init = calls[0]!.init;
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.body).toBe(JSON.stringify({ method: "eth_blockNumber" }));
    expect(init.headers).toEqual({
      "lava-select-provider": "eth-publicnode",
      "content-type": "application/json",
    });
  });

  it("sends no body on a GET, nor on a REST POST whose arguments ride the path", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response("{}", { status: 200 });
    });
    await relayRouterHttp("http://x-router:3000/a", { ...OPTS, httpMethod: "GET", body: { ignored: true } });
    await relayRouterHttp("http://x-router:3000/wallet/getnowblock", { ...OPTS, body: null });
    for (const init of inits) {
      expect(init.body).toBeUndefined();
      expect(init.headers).toEqual({});
    }
  });

  it("returns a router error as a result, with the router's own status", async () => {
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    const res = await relayRouterHttp("http://eth1-router:3000/", OPTS);
    expect(res.httpStatus).toBe(429);
    expect(res.body).toEqual({ _raw: "rate limited" });
    expect(res.servedBy).toBeNull();
    expect(res.retries).toBeNull();
  });

  it("cuts a body past the cap and says so", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(5000), { status: 200 }));
    const res = await relayRouterHttp("http://eth1-router:3000/", { ...OPTS, maxBodyBytes: 100 });
    expect(res.truncated).toBe(true);
    expect((res.body as { _raw: string })._raw).toHaveLength(100);
  });

  it("is a timeout when the router never answers", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await relayRouterHttp("http://eth1-router:3000/", OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTransportError);
    expect((err as RelayTransportError).kind).toBe("timeout");
  });

  it("is a timeout when the router starts an answer and never finishes it", async () => {
    // octez's /monitor/* streams: headers arrive, the body never ends.
    vi.stubGlobal("fetch", async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        pull() {
          return Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        },
      });
      return new Response(body, { status: 200 });
    });
    const err = await relayRouterHttp("http://tezos-router:3000/monitor/heads/main", {
      ...OPTS,
      httpMethod: "GET",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTransportError);
    expect((err as RelayTransportError).kind).toBe("timeout");
    expect((err as Error).message).toContain("did not finish");
  });

  it("is a connect failure when the router cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    });
    const err = await relayRouterHttp("http://nope-router:3000/", OPTS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayTransportError);
    expect((err as RelayTransportError).kind).toBe("connect");
    expect((err as Error).message).toContain("ENOTFOUND");
  });
});

/* ── A WebSocket listener small enough to read ──────────────────────────────
 *
 * Node ships a WebSocket client and no server, and the router's behaviour that
 * matters here is two lines of the handshake: 101 on the right path, 405 on any
 * other. So this answers the upgrade by hand and, once open, replies to the
 * first frame with whatever `reply` returns. Client frames are masked and
 * short in these tests; server frames are sent unmasked, as the protocol says.
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function readClientFrame(buf: Buffer): string {
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  }
  const mask = buf.subarray(offset, offset + 4);
  const payload = buf.subarray(offset + 4, offset + 4 + len);
  return Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)).toString();
}

function serverFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

async function wsListener(opts: {
  /** Upgrade only this path; anything else gets the router's 405. */
  path: string;
  reply?: (text: string) => string;
}): Promise<{ port: number; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    let upgraded = false;
    socket.on("data", (buf) => {
      if (!upgraded) {
        const head = buf.toString();
        const requestPath = head.split(" ")[1] ?? "";
        if (requestPath !== opts.path) {
          socket.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const key = /Sec-WebSocket-Key: (.+)\r\n/i.exec(head)?.[1]?.trim() ?? "";
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        upgraded = true;
        return;
      }
      const opcode = buf[0]! & 0x0f;
      if (opcode !== 0x1) return; // close / ping — nothing to answer
      const text = readClientFrame(buf);
      seen.push(text);
      if (opts.reply) socket.write(serverFrame(opts.reply(text)));
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

describe("relayRouterWs", () => {
  it("sends one envelope and resolves on the router's first reply", async () => {
    const ws = await wsListener({
      path: "/ws",
      reply: (text) => JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(text).id, result: "0x2a" }),
    });
    try {
      const res = await relayRouterWs(
        `ws://127.0.0.1:${ws.port}/ws`,
        { jsonrpc: "2.0", id: 7, method: "eth_blockNumber", params: [] },
        { timeoutMs: 2000, maxBodyBytes: 1024 },
      );
      expect(ws.seen.map((t) => JSON.parse(t).method)).toEqual(["eth_blockNumber"]);
      expect(res).toMatchObject({
        httpStatus: null,
        body: { id: 7, result: "0x2a" },
        truncated: false,
        transport: "ws",
        servedBy: null,
        retries: null,
      });
    } finally {
      ws.close();
    }
  });

  it("fails as a connect error when the router refuses the upgrade", async () => {
    const ws = await wsListener({ path: "/ws" });
    try {
      const err = await relayRouterWs(`ws://127.0.0.1:${ws.port}/wrong`, { id: 1 }, {
        timeoutMs: 2000,
        maxBodyBytes: 1024,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayTransportError);
      expect((err as RelayTransportError).kind).toBe("connect");
    } finally {
      ws.close();
    }
  });

  it("times out when the socket opens and the router never replies", async () => {
    const ws = await wsListener({ path: "/ws" });
    try {
      const err = await relayRouterWs(`ws://127.0.0.1:${ws.port}/ws`, { id: 1 }, {
        timeoutMs: 300,
        maxBodyBytes: 1024,
      }).catch((e: unknown) => e);
      expect((err as RelayTransportError).kind).toBe("timeout");
    } finally {
      ws.close();
    }
  });
});

describe("probeRouterWs", () => {
  it("is online when the upgrade is served on that path", async () => {
    const ws = await wsListener({ path: "/websocket" });
    try {
      expect(await probeRouterWs(`ws://127.0.0.1:${ws.port}/websocket`, 2000)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("is offline when the router answers the handshake 405", async () => {
    const ws = await wsListener({ path: "/ws" });
    try {
      expect(await probeRouterWs(`ws://127.0.0.1:${ws.port}/`, 2000)).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("is offline when nothing listens", async () => {
    const ws = await wsListener({ path: "/ws" });
    const port = ws.port;
    ws.close();
    expect(await probeRouterWs(`ws://127.0.0.1:${port}/ws`, 2000)).toBe(false);
  });
});
