import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WsFailure, wsProbe, wsSendOnce } from "../services/ws-once.js";

/* A WebSocket peer small enough to misbehave on purpose: it answers the
 * upgrade by hand, then does whatever `onFrame` says with the client's first
 * text frame. It never answers a close frame, which is the peer the teardown
 * exists for. */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** A text frame's header announcing `bytes` of payload, and none of it. */
function headerOnly(bytes: number): Buffer {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(bytes), 2);
  return header;
}

interface Peer {
  url: string;
  /** Sockets the peer still holds open. */
  open: () => number;
  upgrades: () => string[];
}

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function peer(opts: { path?: string; onFrame?: (socket: Socket) => void } = {}): Promise<Peer> {
  const path = opts.path ?? "/ws";
  const live = new Set<Socket>();
  const upgrades: string[] = [];
  const server = createServer((socket) => {
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    socket.on("error", () => undefined);
    let upgraded = false;
    socket.on("data", (buf) => {
      if (!upgraded) {
        const head = buf.toString();
        upgrades.push(head);
        if ((head.split(" ")[1] ?? "") !== path) {
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
      if ((buf[0]! & 0x0f) === 0x1) opts.onFrame?.(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    for (const s of live) s.destroy();
    server.close();
  });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    open: () => live.size,
    upgrades: () => upgrades,
  };
}

const LIMITS = { timeoutMs: 2000, maxBytes: 1024 };

describe("wsSendOnce", () => {
  it("sends one frame and resolves on the first message", async () => {
    const p = await peer({ onFrame: (socket) => socket.write(textFrame('{"result":"0x2a"}')) });
    expect(await wsSendOnce(p.url, '{"id":1}', LIMITS)).toEqual({ text: '{"result":"0x2a"}', tooLarge: false });
  });

  it("puts the caller's headers on the handshake", async () => {
    const p = await peer({ onFrame: (socket) => socket.write(textFrame("{}")) });
    await wsSendOnce(p.url, "{}", { ...LIMITS, headers: { Authorization: "Bearer tok-abcdef123456" } });
    expect(p.upgrades()[0]).toContain("Authorization: Bearer tok-abcdef123456");
  });

  it("refuses a message past the limit from its header, without waiting for the bytes", async () => {
    // The peer announces 64 MiB and sends none of it: a client that buffers
    // first would sit here until the deadline.
    const p = await peer({ onFrame: (socket) => socket.write(headerOnly(64 * 1024 * 1024)) });
    const t0 = performance.now();
    expect(await wsSendOnce(p.url, "{}", LIMITS)).toEqual({ text: "", tooLarge: true });
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("takes a message of exactly the limit", async () => {
    const big = "x".repeat(100);
    const p = await peer({ onFrame: (socket) => socket.write(textFrame(big)) });
    expect(await wsSendOnce(p.url, "{}", { timeoutMs: 2000, maxBytes: 100 })).toEqual({ text: big, tooLarge: false });
  });

  it("drops the socket when the peer never answers the close", async () => {
    const p = await peer({ onFrame: (socket) => socket.write(textFrame("{}")) });
    await wsSendOnce(p.url, "{}", LIMITS);
    expect(p.open()).toBe(1);
    await expect.poll(() => p.open(), { timeout: 4000, interval: 100 }).toBe(0);
  });

  it("fails as refused when the upgrade is not served", async () => {
    const p = await peer({ path: "/ws" });
    const err = await wsSendOnce(p.url.replace("/ws", "/wrong"), "{}", LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WsFailure);
    expect((err as WsFailure).kind).toBe("refused");
  });

  it("times out when the socket opens and no message comes, and drops it", async () => {
    const p = await peer();
    const err = await wsSendOnce(p.url, "{}", { timeoutMs: 300, maxBytes: 1024 }).catch((e: unknown) => e);
    expect((err as WsFailure).kind).toBe("timeout");
    await expect.poll(() => p.open(), { timeout: 4000, interval: 100 }).toBe(0);
  });

  it("fails without raising when the url cannot be dialled at all", async () => {
    const err = await wsSendOnce("ws://127.0.0.1:1/ws", "{}", LIMITS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WsFailure);
  });
});

describe("wsProbe", () => {
  it("is online on an open, and leaves no socket behind", async () => {
    const p = await peer();
    expect(await wsProbe(p.url, 2000)).toBe(true);
    await expect.poll(() => p.open(), { timeout: 4000, interval: 100 }).toBe(0);
  });

  it("is offline on a 405, on nothing listening and on a deadline", async () => {
    const p = await peer({ path: "/ws" });
    expect(await wsProbe(p.url.replace("/ws", "/"), 2000)).toBe(false);
    expect(await wsProbe("ws://127.0.0.1:1/ws", 2000)).toBe(false);
  });
});
