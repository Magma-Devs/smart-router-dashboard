/**
 * Direct-to-upstream relay — dials ONE configured upstream endpoint on the
 * caller's behalf, bypassing the router.
 *
 * Why this lives in the api at all: the browser can never hold the upstream
 * url. `maskNodeUrl` (configuration.ts) strips path + query before the
 * topology leaves the process, because that is exactly where operators put
 * API keys. So "send this request straight to the upstream" has to be a
 * server-side hop, addressed by an opaque `{routerId, node, endpointIndex}`
 * triple that the api resolves against the same mounted values file.
 *
 * The rules that keep it from becoming an open proxy live here:
 *
 *  - the target url is NEVER accepted from the caller, only resolved;
 *  - the resolved url is NEVER echoed back, and anything derived from it is
 *    scrubbed out of the upstream's own response (`redactSecrets`);
 *  - redirects are not followed (a `Location` can carry the key onward);
 *  - the caller's headers are dropped — we send only what the transport needs
 *    plus the operator's own `auth-config` credential for that endpoint;
 *  - responses are capped and the whole call is deadlined.
 */

import type { UpstreamRelayResponse } from "@sr/shared";

export type BuildUrlResult = { ok: true; url: string } | { ok: false; error: string };

/** What a caller-supplied REST path may not contain, in one place. */
const PATH_TRAVERSAL = "..";

/**
 * Trim trailing slashes off a url path. A scan rather than `/\/+$/`: that
 * pattern backtracks polynomially on a path of many slashes, and this one runs
 * on an operator-supplied url with a caller-supplied path appended.
 */
function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/** Space and control characters — a path carrying either is a request-smuggling
 *  shape, not a path. Written as a codepoint scan rather than a regex because a
 *  control-character class in a literal is itself a lint error. */
function hasControlOrSpace(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Resolve `base` + a caller-supplied REST path into the url to dial.
 *
 * The path is APPENDED to the base's own path rather than replacing it —
 * plenty of upstreams carry their key as a path segment
 * (`https://host/v2/<key>`), and `new URL(path, base)` would silently drop it
 * and turn a 200 into a confusing 404. Query strings merge for the same
 * reason: a key living in `?apikey=` has to survive the user's `?height=`.
 */
export function buildTargetUrl(
  base: string,
  path?: string,
  authQuery?: string | null,
): BuildUrlResult {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return { ok: false, error: "Upstream url in the values file is not a valid url." };
  }
  if (path === undefined || path === "") {
    return { ok: true, url: appendAuthQuery(u.toString(), authQuery) };
  }
  if (!path.startsWith("/")) return { ok: false, error: "Path must start with '/'." };
  // `//host` is protocol-relative — it would retarget the request at another
  // host entirely.
  if (path.startsWith("//")) return { ok: false, error: "Path must not start with '//'." };
  if (path.includes(PATH_TRAVERSAL)) return { ok: false, error: "Path must not contain '..'." };
  if (hasControlOrSpace(path)) {
    return { ok: false, error: "Path must not contain spaces or control characters." };
  }

  const qIdx = path.indexOf("?");
  const rawPath = qIdx === -1 ? path : path.slice(0, qIdx);
  const rawQuery = qIdx === -1 ? "" : path.slice(qIdx + 1);
  u.pathname = stripTrailingSlashes(u.pathname) + rawPath;
  if (rawQuery) {
    for (const [k, v] of new URLSearchParams(rawQuery)) u.searchParams.append(k, v);
  }
  return { ok: true, url: appendAuthQuery(u.toString(), authQuery) };
}

/**
 * Append the endpoint's `auth-config.auth-query` exactly the way the router's
 * own `AddAuthPath` does — `?` when the url carries no query yet, `&` when it
 * does. Concatenated verbatim rather than parsed through `URLSearchParams`:
 * the value IS a query string (`apikey=abc`) and re-encoding it would change
 * the credential the upstream is checking.
 */
function appendAuthQuery(url: string, authQuery?: string | null): string {
  if (!authQuery) return url;
  const q = authQuery.replace(/^[?&]+/, "");
  if (q === "") return url;
  return `${url}${url.includes("?") ? "&" : "?"}${q}`;
}

/** Placeholder left in place of anything that came out of the upstream url. */
export const REDACTED = "<redacted>";

/**
 * Strip every credential-bearing fragment of `url` out of `text`.
 *
 * Upstreams echo their own request back more often than you would hope — a
 * 404 body quoting the full path, an auth error quoting the token. Since the
 * relay hands that body to the browser verbatim, anything recognisably taken
 * from the resolved url is replaced first.
 *
 * Path segments and query values shorter than 8 characters are left alone:
 * they are `/evm`, `/v1`, `?height=42` — never keys — and blanking them would
 * mangle honest responses for no gain.
 */
export function redactSecrets(text: string, url: string, declared: string[] = []): string {
  const out = text;
  const secrets = new Set<string>();
  // A declared credential (an `auth-config` header value) is a secret whatever
  // its length: "Bearer <uuid>" is echoed by a 401 body far more often than a
  // key in a path is, and the token alone comes back as often as the whole
  // header does.
  for (const value of declared) {
    for (const part of [value, ...value.split(/\s+/)]) {
      if (part.length >= 8) secrets.add(part);
    }
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return redactAll(out, [...secrets]);
  }
  if (u.username) secrets.add(u.username);
  if (u.password) secrets.add(u.password);
  for (const seg of u.pathname.split("/")) if (seg.length >= 8) secrets.add(seg);
  for (const [, v] of u.searchParams) if (v.length >= 8) secrets.add(v);
  // The whole url first, so a body quoting it doesn't leave a half-redacted
  // husk behind.
  return redactAll(out, [url, `${u.origin}${u.pathname}`, ...secrets]);
}

/** Longest secrets first: a substring of another secret would otherwise leave
 *  the longer one unrecognisable and half-printed. */
function redactAll(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Read at most `limit` bytes off a response body, then stop pulling. */
async function readCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > limit) {
        chunks.push(value.slice(0, value.byteLength - (size - limit)));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(joined), truncated };
}

/** JSON when it parses, `{ _raw }` otherwise — the drawer renders both. */
function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

export interface RelayHttpOptions {
  httpMethod: "GET" | "POST";
  body?: unknown;
  timeoutMs: number;
  maxBodyBytes: number;
  /** The endpoint's `auth-config.auth-headers` — the credential the ROUTER
   *  attaches on every relay it sends there. Without it a token-gated upstream
   *  401s on the direct leg while the router's leg answers 200, and the
   *  comparison reads as an upstream fault instead of a missing header. */
  authHeaders?: Record<string, string>;
}

export class RelayTransportError extends Error {
  constructor(
    message: string,
    /** `timeout` → 504, `connect` → 502. Never carries the target url. */
    public readonly kind: "timeout" | "connect",
  ) {
    super(message);
  }
}

/**
 * Fire the HTTP request. The relay answers 200 with the upstream's own status
 * inside `httpStatus` — a 429 from the upstream is a successful measurement,
 * not a dashboard failure, and the drawer shows the upstream's body for it.
 */
export async function relayHttp(url: string, opts: RelayHttpOptions): Promise<UpstreamRelayResponse> {
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = {
    method: opts.httpMethod,
    headers,
    // A redirect can carry the credentialed path to a host we never vetted,
    // and its Location would have to be scrubbed on the way back. Don't.
    redirect: "manual",
    signal: AbortSignal.timeout(opts.timeoutMs),
  };
  if (opts.httpMethod === "POST" && opts.body !== undefined) {
    // A REST POST carries its arguments in the PATH, so the drawer sends no
    // body for one. Posting `{}` on its behalf is what a nodeos / java-tron
    // endpoint rejects — send a body only when there is one.
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  // Last, so an endpoint whose values file insists on its own accept /
  // content-type gets what the operator wrote.
  Object.assign(headers, opts.authHeaders ?? {});

  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new RelayTransportError(
      timedOut
        ? `Upstream did not answer within ${opts.timeoutMs}ms.`
        : `Could not reach the upstream (${describeCause(e)}).`,
      timedOut ? "timeout" : "connect",
    );
  }
  const { text, truncated } = await readCapped(res, opts.maxBodyBytes);
  return {
    httpStatus: res.status,
    latencyMs: Math.round(performance.now() - t0),
    body: parseBody(redactSecrets(text, url, Object.values(opts.authHeaders ?? {}))),
    truncated,
    transport: "http",
  };
}

/**
 * Single-shot WebSocket: connect, send one JSON-RPC envelope, resolve on the
 * first message, close. Not a proxied socket — the drawer's ws mode is
 * request/response too, so a full duplex tunnel would be machinery nobody
 * uses.
 */
export async function relayWs(
  url: string,
  body: unknown,
  opts: { timeoutMs: number; maxBodyBytes: number; authHeaders?: Record<string, string> },
): Promise<UpstreamRelayResponse> {
  if (typeof WebSocket === "undefined") {
    throw new RelayTransportError("This api runtime has no WebSocket client.", "connect");
  }
  const authHeaders = opts.authHeaders ?? {};
  const t0 = performance.now();
  return await new Promise<UpstreamRelayResponse>((resolve, reject) => {
    let ws: WebSocket;
    try {
      // Node's WebSocket is undici's, whose second argument takes `headers`
      // beyond the standard `protocols` — the only place a handshake can carry
      // the endpoint's auth-config credential. The cast is the price of an
      // extension the DOM lib types don't know about; a runtime that ignores
      // it just sends the handshake bare, exactly as before.
      ws = new WebSocket(url, { headers: authHeaders } as unknown as string[]);
    } catch (e) {
      reject(new RelayTransportError(`Could not open the socket (${describeCause(e)}).`, "connect"));
      return;
    }
    const timer = setTimeout(() => {
      settled = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      reject(new RelayTransportError(`Upstream did not answer within ${opts.timeoutMs}ms.`, "timeout"));
    }, opts.timeoutMs);
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
    ws.onopen = () => ws.send(JSON.stringify(body ?? {}));
    ws.onmessage = (ev: MessageEvent) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      const capped = raw.length > opts.maxBodyBytes;
      finish(() =>
        resolve({
          httpStatus: null,
          latencyMs: Math.round(performance.now() - t0),
          body: parseBody(
            redactSecrets(
              capped ? raw.slice(0, opts.maxBodyBytes) : raw,
              url,
              Object.values(authHeaders),
            ),
          ),
          truncated: capped,
          transport: "ws",
        }),
      );
    };
    ws.onerror = () => {
      finish(() =>
        reject(new RelayTransportError("The upstream refused or dropped the socket.", "connect")),
      );
    };
    ws.onclose = () => {
      finish(() =>
        reject(new RelayTransportError("The upstream closed the socket before answering.", "connect")),
      );
    };
  });
}

/** A cause phrase safe to show — never the url, never a stack. */
function describeCause(e: unknown): string {
  const cause = (e as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code) return cause.code;
  return e instanceof Error ? e.name : "unknown error";
}
