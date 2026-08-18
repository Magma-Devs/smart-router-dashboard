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

/**
 * Parse `TRUST_PROXY` into what Fastify's `trustProxy` option accepts:
 * a hop count (number), an explicit proxy list (string), or `false`.
 * `true` is deliberately NOT reachable — see `server.trustProxy`.
 */
function envTrustProxy(name: string): number | string | false {
  const raw = env(name)?.trim();
  if (raw === undefined || raw === "") return 1;
  if (raw === "false" || raw === "0") return false;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return hops;
  // Anything else is a proxy list ("10.0.0.0/8, 192.168.1.1").
  return raw;
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
    /**
     * How far to trust `X-Forwarded-For` when deriving `request.ip`, which
     * feeds both the per-IP rate limit and the audit log's access events.
     *
     * Default `1` — trust exactly the immediate peer. Behind our ingress that
     * yields the browser's real address and ignores anything a client tried to
     * prepend. Accepts a hop count, a comma list of proxy IPs/CIDRs (tightest,
     * use it when you know the ingress range), or `false` to trust nothing.
     *
     * It was `true` — trust every hop — which on a publicly reachable api lets
     * any caller claim any address and so walk past the per-IP limit entirely.
     * Per-*account* lockout is the real control regardless; this is
     * defence-in-depth and an audit-quality question.
     */
    trustProxy: envTrustProxy("TRUST_PROXY"),
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
    /**
     * Shared secret proving a request came from our own web tier.
     *
     * `/auth/sign-in` is publicly reachable, so the browser details the web
     * forwards on the caller's behalf (`clientContext`) are forgeable — and
     * those become the IP and device on the audit log's access events. With
     * this set, forwarded context is honoured only when the caller presents
     * the secret; without it the api falls back to what it observes itself,
     * so a direct caller records their own address rather than a chosen one.
     * Unset ⇒ forwarded context is always ignored (safe, less useful).
     */
    internalSecret: env("INTERNAL_AUTH_SECRET"),
  },

  /**
   * Which shape of deployment this is. It forks every credential-delivery path,
   * because on-prem has no mail server and never will:
   *
   *  - `managed`  — we host. Invitations and password resets are emailed.
   *  - `onprem`   — the customer hosts. Links are shown to an admin and handed
   *                 over directly; the first admin is created through the
   *                 first-run page using the installer's setup token.
   *
   * Defaults to `onprem`: assuming no mail server is the safe way to be wrong,
   * since the failure is "an admin copies a link" rather than "an invitation
   * silently never arrives".
   */
  deploymentMode: (env("DEPLOYMENT_MODE") ?? "onprem") as "managed" | "onprem",

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
