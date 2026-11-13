import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { normalizeIP } from "@fastify/rate-limit";

/**
 * What the web tier tells the api about the browser behind it, and when to
 * believe it.
 *
 * The web calls the api from its own container — Auth.js callbacks, the
 * server-rendered previews, the layouts' enrolment read — so the connection
 * the api sees is the web pod, shared by everybody it serves. The web sends the
 * browser's own address and device beside `X-Internal-Auth`, and the api
 * believes them only with that secret. The mirror of the web's
 * `lib/forwarded-client.ts`.
 */

/** Set by the web tier beside `X-Internal-Auth`, and believed only with it.
 *  Headers rather than a body field because the rate limiter runs in
 *  `onRequest`, before a body exists, and it has to key on the same address
 *  this records — otherwise every sign-in in the deployment shares one bucket. */
export const FORWARDED_IP_HEADER = "x-forwarded-client-ip";
export const FORWARDED_UA_HEADER = "x-forwarded-client-ua";

/** Constant-time comparison that doesn't leak length through early return. */
function secretsMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whether the caller proved it is our web tier. */
export function vouchedByWeb(request: FastifyRequest, expected: string | undefined): boolean {
  if (!expected) return false;
  const supplied = request.headers["x-internal-auth"];
  return typeof supplied === "string" && secretsMatch(supplied, expected);
}

/** One forwarded header's value, or null when it is absent or empty. */
export function forwardedHeader(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value ? value : null;
}

/** The forwarded address, or null when nothing vouches for one. Shared with the
 *  rate limiter so the two cannot disagree about who is calling. */
export function forwardedClientIp(
  request: FastifyRequest,
  expected: string | undefined,
): string | null {
  if (!vouchedByWeb(request, expected)) return null;
  return forwardedHeader(request, FORWARDED_IP_HEADER);
}

/**
 * Whose allowance a request spends in the api's per-minute limits — the ones
 * every route without a limit of its own shares.
 *
 * A caller the web does not vouch for spends its connection's address, as it
 * always has: a forwarded header without the secret changes nothing.
 *
 * A call the web vouches for is a browser's call made from the web pod, so it
 * spends that browser's allowance rather than the pod's. Keyed on the pod, every
 * signed-in person would share one bucket: the layouts ask the api whether the
 * reader must enrol on every page load, and a busy minute spent it for everyone,
 * leaving each new page waiting on the browser's own read.
 *
 *  - **The session**, when the call carries one. The api resolved it from its
 *    own table on this request (the limiter's hook runs after the auth hook), so
 *    nothing the web computed decides it — not the hop count that picks the
 *    browser out of `X-Forwarded-For`, which reports nothing when no proxy sits
 *    in front of the web and reports a proxy when it is set too low.
 *  - **The forwarded address**, for a vouched call with no session — the pages
 *    a visitor opens before signing in.
 *  - **The connection**, when the web forwarded neither.
 *
 * Normalised as the limiter's own default key is, so a forwarded address and
 * the same browser's direct calls land in one bucket.
 */
export function clientRateLimitKey(
  internalSecret: string | undefined,
): (request: FastifyRequest) => string {
  return (request) => {
    if (vouchedByWeb(request, internalSecret)) {
      const sessionId = request.authUser?.sessionId;
      if (sessionId) return `session:${sessionId}`;
      const forwardedIp = forwardedHeader(request, FORWARDED_IP_HEADER);
      if (forwardedIp) return normalizeIP(forwardedIp);
    }
    return normalizeIP(request.ip);
  };
}
