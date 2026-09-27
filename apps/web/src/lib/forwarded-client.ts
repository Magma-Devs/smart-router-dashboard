/**
 * What the web tier tells the api about the browser behind it.
 *
 * Auth.js callbacks and the server-rendered previews call the api from this
 * container, so the api sees the web pod. These helpers pick the browser's own
 * address and device out of the request the web received, and send them as
 * vouched headers — the api believes them only alongside INTERNAL_AUTH_SECRET,
 * records them on sessions and access events, and keys its per-IP limit on
 * them. Shared by `auth.config.ts` and `lib/bootstrap.ts` so the two cannot
 * disagree about who is calling.
 */

/**
 * How many proxies sit between the browser and this container. Each one appends
 * the address it received from, so the client is that many entries from the
 * right of `X-Forwarded-For`. Must match the ingress topology, and the api's
 * own `TRUST_PROXY`.
 *
 * **0 means nothing sits in front of the web** — the compose files publish it
 * directly. Then no header is ours: Next sets `X-Forwarded-For` from the socket
 * only when the request did not carry one, so whatever a browser sends arrives
 * untouched, and reading any of it would let the browser choose its recorded
 * address. With 0, no address is forwarded at all.
 */
function trustedHops(): number {
  const raw = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 1;
}

/**
 * The browser's own address, picked out of `X-Forwarded-For` by hop count.
 *
 * **Never the left-most entry.** Most ingresses append rather than replace, so
 * the left of that header is whatever the caller sent — meaning a client could
 * choose the address written to its own session row and audit trail, which is
 * the forgery the internal secret exists to prevent. Counting from the right
 * lands on an entry a proxy wrote.
 *
 * Returns undefined when the header is shorter than the configured hop count:
 * that is a misconfiguration or a manipulated header, and recording this
 * container's address is the honest answer to it.
 *
 * Exported for tests — the arithmetic is the whole security property.
 */
export function clientIpFrom(headers: Headers | null, hops = trustedHops()): string | undefined {
  if (!headers || hops === 0) return undefined;
  const chain =
    headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  if (chain.length === 0) return headers.get("x-real-ip") || undefined;
  return chain[chain.length - hops] ?? undefined;
}

/**
 * What the browser told *us*, forwarded to the api so the session row and the
 * audit log record the person's own address rather than this container's.
 *
 * The api only believes it alongside `INTERNAL_AUTH_SECRET`; without that it
 * falls back to what it observes, so an attacker calling the public sign-in
 * endpoint directly cannot choose the address recorded against their attempts.
 *
 * Headers rather than a body field: the api's rate limiter runs before a body
 * exists and keys on this same address, so a deployment's sign-ins do not all
 * share one bucket.
 */
export function forwardedClientHeaders(headers: Headers | null): Record<string, string> {
  const secret = process.env.INTERNAL_AUTH_SECRET;
  if (!secret) {
    // The api refuses to boot without this, so a deployment that reaches here
    // has the web and the api configured differently — which is silent by
    // nature: sign-in works, and every session and access event just records
    // the api's own address.
    console.error(
      "INTERNAL_AUTH_SECRET is not set on the web tier. The browser's address and device cannot be forwarded, so the api will record its own on every sign-in. It must match the api's value.",
    );
    return {};
  }
  if (!headers) return {};

  const ip = clientIpFrom(headers);
  const userAgent = headers.get("user-agent") ?? undefined;
  if (!ip && !userAgent) return {};

  return {
    "X-Internal-Auth": secret,
    ...(ip ? { "X-Forwarded-Client-Ip": ip } : {}),
    ...(userAgent ? { "X-Forwarded-Client-Ua": userAgent } : {}),
  };
}
