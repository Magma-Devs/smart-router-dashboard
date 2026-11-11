/**
 * One-shot WebSocket client for the relays: open, send one frame, take the
 * first message, tear the socket down.
 *
 * The `ws` client rather than Node's own, for two things Node's cannot do. It
 * refuses a message past `maxBytes` from the frame header, before any of it is
 * buffered. And it can drop a socket whose peer never answers the close, where
 * `close()` alone waits on the peer for as long as it likes.
 */

import { WebSocket as WsClient } from "ws";

/** How long a peer gets to answer the close before the socket is dropped. */
const CLOSE_GRACE_MS = 2000;

/** `ws`'s code for a message longer than `maxPayload`. */
const TOO_LARGE = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";

export interface WsSendOptions {
  timeoutMs: number;
  /** A message past this is not read: the reply comes back `tooLarge`. */
  maxBytes: number;
  /** Sent on the handshake. */
  headers?: Record<string, string>;
}

export interface WsReply {
  /** The first message's text; empty for a binary one, or one too large. */
  text: string;
  tooLarge: boolean;
}

/** Why no reply came. Never carries the url. */
export class WsFailure extends Error {
  constructor(public readonly kind: "timeout" | "refused" | "closed" | "unopenable") {
    super(kind);
  }
}

/** Close politely, and drop the socket if the peer does not go along. An
 *  `error` listener stays on throughout: `ws` raises one for a socket closed
 *  mid-handshake, and an unheard `error` event takes the process down. */
function tearDown(ws: WsClient): void {
  ws.on("error", () => undefined);
  if (ws.readyState === WsClient.CONNECTING) {
    ws.terminate();
    return;
  }
  if (ws.readyState === WsClient.CLOSED) return;
  const drop = setTimeout(() => ws.terminate(), CLOSE_GRACE_MS);
  drop.unref();
  ws.once("close", () => clearTimeout(drop));
  try {
    ws.close();
  } catch {
    ws.terminate();
  }
}

function open(url: string, opts: { timeoutMs: number; maxBytes?: number; headers?: Record<string, string> }): WsClient {
  return new WsClient(url, {
    headers: opts.headers,
    handshakeTimeout: opts.timeoutMs,
    maxPayload: opts.maxBytes,
    // One small request, one reply: nothing here is worth a compression
    // context, and an inflated reply is one more thing to bound.
    perMessageDeflate: false,
    followRedirects: false,
  });
}

/** Send `payload` as one text frame and resolve on the first message. */
export async function wsSendOnce(url: string, payload: string, opts: WsSendOptions): Promise<WsReply> {
  return await new Promise<WsReply>((resolve, reject) => {
    let ws: WsClient;
    try {
      ws = open(url, opts);
    } catch {
      reject(new WsFailure("unopenable"));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tearDown(ws);
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new WsFailure("timeout"))), opts.timeoutMs);
    ws.on("open", () => ws.send(payload));
    ws.on("message", (data, isBinary) => {
      finish(() => resolve({ text: isBinary ? "" : data.toString(), tooLarge: false }));
    });
    ws.on("error", (err: Error & { code?: string }) => {
      if (err.code === TOO_LARGE) finish(() => resolve({ text: "", tooLarge: true }));
      else finish(() => reject(new WsFailure("refused")));
    });
    ws.on("close", () => finish(() => reject(new WsFailure("closed"))));
  });
}

/** Whether the upgrade is served at `url`: true on open, false on an error, a
 *  close or the deadline. */
export async function wsProbe(url: string, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let ws: WsClient;
    try {
      ws = open(url, { timeoutMs });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (online: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tearDown(ws);
      resolve(online);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.on("open", () => finish(true));
    ws.on("error", () => finish(false));
    ws.on("close", () => finish(false));
  });
}
