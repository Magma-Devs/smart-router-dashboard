/**
 * Router relay — the Try-me drawer's "via router" request, sent by the api to
 * the router's own listener inside the deployment.
 *
 * Why the api sends it at all: a tenant can admit only a list of source
 * addresses at its public hostnames (one Cloudflare custom rule per tenant).
 * A browser anywhere else is refused at the edge before the router sees the
 * request, while the api reaches the router without crossing the edge.
 *
 * What keeps it from being an open proxy is what keeps the upstream relay
 * from being one: the target is never taken from the caller. The caller names
 * a router and an interface, the api resolves them against the mounted values
 * file (`ConfigurationService.resolveRouterOrigin`), and the path it adds
 * passes `buildTargetUrl`'s checks. Of the caller's own request, only the two
 * router directives the drawer sets cross over.
 *
 * Nothing is redacted on the way back. These are the bytes the router hands
 * any caller of its public hostname, and the browser read them directly
 * before this route existed.
 */

import type { RouterRelayResponse } from "@sr/shared";
import { RelayTransportError, describeCause, parseBody, readCapped } from "./upstream-relay.js";

/** The router directives the drawer can set. */
export interface RouterDirectives {
  selectProvider?: string;
  forceCacheRefresh?: boolean;
}

/** The directives as the request headers the router reads. */
export function directiveHeaders(d: RouterDirectives): Record<string, string> {
  const headers: Record<string, string> = {};
  if (d.selectProvider) headers["lava-select-provider"] = d.selectProvider;
  if (d.forceCacheRefresh) headers["lava-force-cache-refresh"] = "true";
  return headers;
}

/** `Lava-Retries` read the way the drawer has always read it: absent or blank
 *  is unknown, and a value that is not a number counts as no retries. */
export function retriesOf(header: string | null): number | null {
  if (header === null || header === "") return null;
  return Number(header) || 0;
}

/** The router-telemetry half of a reply, all absent — a WebSocket reply
 *  carries no headers to read it from. */
const NO_TELEMETRY = {
  servedBy: null,
  retries: null,
  cvStatus: null,
  cvAgreeing: null,
  cvDisagreeing: null,
} as const;

function isTimeout(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return name === "TimeoutError" || name === "AbortError";
}

export interface RouterHttpOptions {
  httpMethod: "GET" | "POST";
  body?: unknown;
  /** The directive headers — the only caller-chosen headers sent. */
  headers: Record<string, string>;
  timeoutMs: number;
  maxBodyBytes: number;
}

/**
 * Fire one HTTP request at a router and read back its body and its `Lava-*`
 * headers. Answers with the router's own status inside, like the upstream
 * relay: a 429 from the router is a result to show, not a failure of ours.
 *
 * The deadline covers the body as well as the headers. Some routes never
 * finish one — octez serves `/monitor/*` as a chunked stream that stays open
 * for the life of the chain — and a read that never ends is the same dead end
 * as a connection that never answers.
 */
export async function relayRouterHttp(url: string, opts: RouterHttpOptions): Promise<RouterRelayResponse> {
  const headers: Record<string, string> = { ...opts.headers };
  const init: RequestInit = {
    method: opts.httpMethod,
    headers,
    // The router never redirects; a Location from anything else answering on
    // that address is not somewhere this relay should follow.
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs),
  };
  if (opts.httpMethod === "POST" && opts.body !== undefined && opts.body !== null) {
    // A REST POST carries its arguments in the path, so the drawer sends no
    // body for one; posting "null" on its behalf is what a nodeos or
    // java-tron endpoint rejects.
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw isTimeout(e)
      ? new RelayTransportError(`The router did not answer within ${opts.timeoutMs}ms.`, "timeout")
      : new RelayTransportError(`Could not reach the router (${describeCause(e)}).`, "connect");
  }
  let read: { text: string; truncated: boolean };
  try {
    read = await readCapped(res, opts.maxBodyBytes);
  } catch (e) {
    if (isTimeout(e)) {
      throw new RelayTransportError(
        `The router did not finish its answer within ${opts.timeoutMs}ms.`,
        "timeout",
      );
    }
    throw new RelayTransportError(`The router's answer broke off (${describeCause(e)}).`, "connect");
  }
  return {
    httpStatus: res.status,
    latencyMs: Math.round(performance.now() - t0),
    body: parseBody(read.text),
    truncated: read.truncated,
    transport: "http",
    servedBy: res.headers.get("Lava-Provider-Address"),
    retries: retriesOf(res.headers.get("Lava-Retries")),
    cvStatus: res.headers.get("Lava-Cross-Validation-Status"),
    cvAgreeing: res.headers.get("Lava-Cross-Validation-Agreeing-Providers"),
    cvDisagreeing: res.headers.get("Lava-Cross-Validation-Disagreeing-Providers"),
  };
}

/**
 * Single-shot WebSocket to a router: connect, send one JSON-RPC envelope,
 * resolve on the first message, close — the drawer's ws mode is
 * request/response, as it was from the browser.
 *
 * No directives: the router reads none on a WebSocket, so there is nothing to
 * put on the handshake.
 */
export async function relayRouterWs(
  url: string,
  body: unknown,
  opts: { timeoutMs: number; maxBodyBytes: number },
): Promise<RouterRelayResponse> {
  if (typeof WebSocket === "undefined") {
    throw new RelayTransportError("This api runtime has no WebSocket client.", "connect");
  }
  const t0 = performance.now();
  return await new Promise<RouterRelayResponse>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new RelayTransportError(`Could not open the socket (${describeCause(e)}).`, "connect"));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(new RelayTransportError(`The router did not answer within ${opts.timeoutMs}ms.`, "timeout")),
      );
    }, opts.timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(body ?? {}));
    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      const capped = raw.length > opts.maxBodyBytes;
      finish(() =>
        resolve({
          httpStatus: null,
          latencyMs: Math.round(performance.now() - t0),
          body: parseBody(capped ? raw.slice(0, opts.maxBodyBytes) : raw),
          truncated: capped,
          transport: "ws",
          ...NO_TELEMETRY,
        }),
      );
    };
    ws.onerror = () => {
      finish(() => reject(new RelayTransportError("The router refused or dropped the socket.", "connect")));
    };
    ws.onclose = () => {
      finish(() =>
        reject(new RelayTransportError("The router closed the socket before answering.", "connect")),
      );
    };
  });
}

/**
 * Whether a router listener serves the WebSocket upgrade at `url`: open it,
 * and report true on OPEN, false on an error, a close or the deadline. OPEN is
 * the whole test — the router answers a handshake on the wrong path with 405.
 */
export async function probeRouterWs(url: string, timeoutMs: number): Promise<boolean> {
  if (typeof WebSocket === "undefined") return false;
  return await new Promise<boolean>((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (online: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(online);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => finish(true);
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(false);
  });
}
