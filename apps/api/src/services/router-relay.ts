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
 * passes `buildRouterUrl`'s checks. Of the caller's own request, only the two
 * router directives the drawer sets cross over.
 *
 * Nothing is redacted on the way back. These are the bytes the router hands
 * any caller of its public hostname, a browser send included.
 */

import {
  ROUTER_REPLY_HEADERS,
  readRouterHeader,
  routerDirectiveHeaders,
  type RouterDirectives,
  type RouterRelayResponse,
} from "@sr/shared";
import {
  RelayTransportError,
  describeCause,
  parseBody,
  readCapped,
  wsTransportError,
} from "./upstream-relay.js";
import { wsProbe, wsSendOnce, type WsReply } from "./ws-once.js";

/** `status` tells the caller's mistake (400) from an address the mounted
 *  config gives us that cannot be dialled (502). */
export type RouterUrlResult = { ok: true; url: string } | { ok: false; status: 400 | 502; error: string };

function refused(error: string): RouterUrlResult {
  return { ok: false, status: 400, error };
}

/** `.` or `..`, spelled out or percent-encoded: the url parser folds both. */
function isDotSegment(segment: string): boolean {
  const plain = segment.replace(/%2e/gi, ".");
  return plain === "." || plain === "..";
}

/**
 * A router's origin plus the caller's path, as the url to dial.
 *
 * The path and query go on as written, so a REST query reaches the router
 * byte for byte as a browser sends it; `buildTargetUrl` re-encodes one while
 * merging it into an upstream's own. The checks keep it a path on this
 * listener: a leading single slash, no dot segments or backslashes before the
 * query, no spaces or control characters anywhere.
 */
export function buildRouterUrl(origin: string, path?: string): RouterUrlResult {
  const suffix = path === undefined || path === "" ? "/" : path;
  if (!suffix.startsWith("/")) return refused("Path must start with '/'.");
  if (suffix.startsWith("//")) return refused("Path must not start with '//'.");
  for (const ch of suffix) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return refused("Path must not contain spaces or control characters.");
  }
  const queryAt = suffix.indexOf("?");
  const pathPart = queryAt === -1 ? suffix : suffix.slice(0, queryAt);
  if (pathPart.includes("\\")) return refused("Path must not contain backslashes.");
  if (pathPart.split("/").some(isDotSegment)) return refused("Path must not contain '.' or '..' segments.");

  let base: URL;
  let url: URL;
  try {
    base = new URL(origin);
    url = new URL(origin + suffix);
  } catch {
    return { ok: false, status: 502, error: "The router's address in the mounted config is not a valid url." };
  }
  // Nothing above lets the path reach the authority; this says so again.
  if (url.host !== base.host || url.protocol !== base.protocol) return refused("Path must stay on the router.");
  return { ok: true, url: url.href };
}

/**
 * How many relays may be in flight at once, per caller and in all.
 *
 * A relay holds its reply several times over while it is read, parsed and
 * sent on. The per-minute limit does not bound that: sixty slow calls can all
 * be open together.
 */
export class RelaySlots {
  private total = 0;
  private readonly byCaller = new Map<string, number>();

  constructor(
    private readonly maxTotal: number,
    private readonly maxPerCaller: number,
  ) {}

  /** A release function, or which limit refused. */
  take(caller: string): (() => void) | "caller" | "all" {
    const held = this.byCaller.get(caller) ?? 0;
    if (held >= this.maxPerCaller) return "caller";
    if (this.total >= this.maxTotal) return "all";
    this.total += 1;
    this.byCaller.set(caller, held + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.byCaller.get(caller) ?? 1) - 1;
      if (left <= 0) this.byCaller.delete(caller);
      else this.byCaller.set(caller, left);
    };
  }
}

/** The router directives the drawer can set. */
export type { RouterDirectives };

/**
 * The directives as the request headers the router reads, each under both of
 * its spellings (`smartrouter-*` and the `lava-*` of a router before the
 * rename). A router acts on the one it knows and drops the other before the
 * upstream, so the pin and the cache skip take effect on either generation
 * with no round trip to find out which is listening. See `router-wire.ts` in
 * `@sr/shared`.
 */
export function directiveHeaders(d: RouterDirectives): Record<string, string> {
  return routerDirectiveHeaders(d);
}

/** The retries header read the way the drawer's browser send reads it: absent
 *  or blank is unknown, and a value that is not a number counts as no retries. */
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
 * Fire one HTTP request at a router and read back its body and its telemetry
 * headers (`Smart-Router-*`, or `Lava-*` from a router before the rename). Answers with the router's own status inside, like the upstream
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
    servedBy: readRouterHeader(res.headers, ROUTER_REPLY_HEADERS.providerAddress),
    retries: retriesOf(readRouterHeader(res.headers, ROUTER_REPLY_HEADERS.retries)),
    cvStatus: readRouterHeader(res.headers, ROUTER_REPLY_HEADERS.crossValidationStatus),
    cvAgreeing: readRouterHeader(res.headers, ROUTER_REPLY_HEADERS.crossValidationAgreeing),
    cvDisagreeing: readRouterHeader(res.headers, ROUTER_REPLY_HEADERS.crossValidationDisagreeing),
  };
}

/**
 * Single-shot WebSocket to a router: connect, send one JSON-RPC envelope,
 * resolve on the first message, close — the drawer's ws mode is
 * request/response, as it is from the browser.
 *
 * No directives: the router reads none on a WebSocket, so there is nothing to
 * put on the handshake. A message past `maxBodyBytes` is not read at all, so
 * it comes back `truncated` with no body.
 */
export async function relayRouterWs(
  url: string,
  body: unknown,
  opts: { timeoutMs: number; maxBodyBytes: number },
): Promise<RouterRelayResponse> {
  const t0 = performance.now();
  let reply: WsReply;
  try {
    reply = await wsSendOnce(url, JSON.stringify(body ?? {}), {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBodyBytes,
    });
  } catch (e) {
    throw wsTransportError(e, "router", opts.timeoutMs);
  }
  return {
    httpStatus: null,
    latencyMs: Math.round(performance.now() - t0),
    body: parseBody(reply.text),
    truncated: reply.tooLarge,
    transport: "ws",
    ...NO_TELEMETRY,
  };
}

/**
 * Whether a router listener serves the WebSocket upgrade at `url`: open it,
 * and report true on OPEN, false on an error, a close or the deadline. OPEN is
 * the whole test — the router answers a handshake on the wrong path with 405.
 */
export async function probeRouterWs(url: string, timeoutMs: number): Promise<boolean> {
  return await wsProbe(url, timeoutMs);
}
