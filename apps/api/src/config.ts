/**
 * Single source of truth for env-var defaults. Parsed once at startup.
 * Every default is documented in the env-var table in the repo CLAUDE.md.
 */

function env(name: string): string | undefined {
  return process.env[name];
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string): string[] | true {
  const raw = env(name);
  if (!raw) return true;
  // Accept both a JSON array (legacy Python backend) and a comma list.
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through to comma split */
    }
  }
  return trimmed.split(",").map((o) => o.trim()).filter(Boolean);
}

export const config = {
  env: env("NODE_ENV") ?? "production",
  isDev: env("NODE_ENV") === "development",
  isProd: env("NODE_ENV") === "production",

  server: {
    port: envInt("API_PORT", 8000),
    host: env("API_HOST") ?? "0.0.0.0",
    corsOrigins: envList("CORS_ORIGINS"),
    rateLimitMax: envInt("RATE_LIMIT_MAX", 300),
  },

  prometheus: {
    url: env("PROMETHEUS_URL") ?? "http://localhost:9090",
    timeoutMs: envInt("PROMETHEUS_TIMEOUT_MS", 10000),
    /**
     * Target label that identifies ONE router deployment, used by the
     * `?router=` scope (see `promql/scope.ts`). The router labels its series
     * with the chain, not with itself, so telling two routers on one chain
     * apart relies on a per-target label the collector attaches. `service` is
     * the Prometheus Operator's (the value being the router's Service name);
     * point it at `job` for a scrape config that names jobs per router.
     */
    routerScopeLabel: env("ROUTER_SCOPE_LABEL") ?? "service",
  },

  /** Helm-values / router config the dashboard reflects (read-only). */
  config: {
    valuesDir: env("HELM_VALUES_DIR") ?? "/app/helm-values",
  },

  /**
   * Authentication (see docs/AUTH.md).
   *  - `disabled` (default) — no login, no DB; every route stays open.
   *  - `enabled`  — Auth.js (web) + HS256 JWT validated here; /api/* routes
   *    require a Bearer token; Postgres-backed users with an ADMIN_EMAIL /
   *    ADMIN_PASSWORD bootstrap seed.
   * NOTE: `secret` is also re-read inside the auth plugin at register time
   * so test setups that inject AUTH_SECRET late still work.
   */
  auth: {
    mode: (env("AUTH_MODE") ?? "disabled") as "disabled" | "enabled",
    secret: env("AUTH_SECRET"),
    databaseUrl: env("DATABASE_URL"),
    adminEmail: env("ADMIN_EMAIL"),
    adminPassword: env("ADMIN_PASSWORD"),
    /** Needed to validate the `aud` claim of Google ID tokens server-side. */
    googleClientId: env("GOOGLE_CLIENT_ID"),
  },

  /**
   * Direct-to-upstream relay (`POST /api/upstreams/relay`) — the api dials a
   * configured upstream on the caller's behalf, bypassing the router, so the
   * Try-me drawer can show what an upstream answers on its own.
   *
   * `enabled` is a real switch, not decoration: with the default
   * AUTH_MODE=disabled, anyone who can reach the api can spend the operator's
   * upstream quota (and send write methods) through this route, using
   * credentials only the api holds. Turn it off on any deployment where that
   * is not acceptable.
   */
  upstreamRelay: {
    enabled: (env("UPSTREAM_RELAY_ENABLED") ?? "true").toLowerCase() !== "false",
    timeoutMs: envInt("UPSTREAM_RELAY_TIMEOUT_MS", 10000),
    /** Response bodies past this are truncated, not streamed. */
    maxBodyBytes: envInt("UPSTREAM_RELAY_MAX_BODY_BYTES", 262144),
    /** Per-IP per-minute, tighter than the global RATE_LIMIT_MAX. */
    rateLimitMax: envInt("UPSTREAM_RELAY_RATE_LIMIT_MAX", 20),
  },

  /**
   * Upstream vendor status (`GET /api/vendors/status`) — the Status Page Index
   * the api reads to tell "the vendor has declared an incident" from "this
   * deployment is broken". Keyless but rate-limited per IP (30/min), which is
   * why the read is server-side and cached rather than made by every browser.
   *
   * `STATUS_PAGE_INDEX_URL=""` switches the feature OFF and the api makes no
   * outbound call at all — the setting for an air-gapped install, which must
   * not quietly dial a public index just because that is the default.
   */
  vendorStatus: {
    url: env("STATUS_PAGE_INDEX_URL") ?? "https://providers-status.magmadevs.com",
    /** Short on purpose: a slow status page must never hold up a dashboard. */
    timeoutMs: 5000,
    /** How long one good read serves every browser. Its own knob rather than
     *  the shared list TTL: this one is bounded by somebody else's rate limit,
     *  not by how fresh a metric ought to be. */
    ttlMs: 60_000,
    /** How long to wait after a FAILED read before trying again. Short: the
     *  index being unreachable is usually a blip, and the last good answer
     *  keeps being served meanwhile. */
    failureTtlMs: 10_000,
  },

  tenantId: env("TENANT_ID") ?? "default",
  logLevel: (env("LOG_LEVEL") ?? "info").toLowerCase(),

  build: {
    commit: env("GIT_COMMIT") ?? "unknown",
    version: env("APP_VERSION") ?? "0.0.0",
  },

  /** Cache TTLs (seconds) — realtime 10-30s, lists 60-300s (lava-connect rule). */
  cacheTtl: {
    realtime: 15,
    lists: 60,
    config: 300,
  },
} as const;
