import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Serve-last, refresh-behind cache for every `GET /api/metrics/*` read.
 *
 * Against a healthy Prometheus this is invisible (soft TTL matches the web's
 * 15s poll). Against a degraded one it is the difference between a dashboard
 * and a blank page: a full Overview recompute was measured at 107s on a
 * customer's Prometheus while it struggled — the browser must never wait on
 * that. A response is served from cache the moment one exists, and past the
 * soft TTL a single background self-request recomputes it; only a cache
 * past the hard TTL (or empty) computes in the foreground.
 *
 * The raw `/api/metrics/query` passthrough is exempt — it is a debugging
 * surface where a cached answer would mislead.
 */
const SOFT_TTL_MS = 15_000;
const HARD_TTL_MS = 10 * 60_000;
const REFRESH_HEADER = "x-cache-refresh";

export const metricsCachePlugin = fp(async (app: FastifyInstance) => {
  // Vitest asserts against per-test fetch stubs; a cache across injects would
  // hand one test another test's payload.
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return;

  const cache = new Map<string, { at: number; body: string }>();
  const refreshing = new Set<string>();

  const cacheable = (req: FastifyRequest): boolean =>
    req.method === "GET" &&
    req.url.startsWith("/api/metrics/") &&
    !req.url.startsWith("/api/metrics/query");

  app.addHook("preHandler", async (req, reply) => {
    if (!cacheable(req) || req.headers[REFRESH_HEADER]) return;
    const hit = cache.get(req.url);
    if (!hit) return;
    const age = Date.now() - hit.at;
    if (age > HARD_TTL_MS) return;
    if (age > SOFT_TTL_MS && !refreshing.has(req.url)) {
      refreshing.add(req.url);
      void app
        .inject({ method: "GET", url: req.url, headers: { [REFRESH_HEADER]: "1", authorization: req.headers.authorization ?? "" } })
        .catch(() => {})
        .then(() => refreshing.delete(req.url));
    }
    reply.header("content-type", "application/json; charset=utf-8");
    reply.header("x-cache-age-sec", String(Math.round(age / 1000)));
    return reply.send(hit.body);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    if (cacheable(req) && reply.statusCode === 200 && typeof payload === "string") {
      cache.set(req.url, { at: Date.now(), body: payload });
    }
    return payload;
  });
});
