/**
 * Single source of truth for env-var defaults. Parsed once at startup.
 * Every default is documented in the env-var table in the repo CLAUDE.md.
 */
import { isValidScopeLabel, isValidScopeValue, type MetricScope } from "@sr/shared";

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
    /**
     * Deployment scope — see `readMetricsScope()`. Read at plugin registration
     * (live env, not this snapshot) so a bad pair fails the boot with a
     * message instead of failing every query with an empty result.
     */
    /**
     * Credentials for a store that is not a bare Prometheus — a per-tenant
     * read proxy, or Mimir behind a basic-auth gateway. Both halves of the
     * pair are needed for the `Authorization` header to be sent at all.
     * `orgId` becomes `X-Scope-OrgID` for a multi-tenant store that takes the
     * org from the client; unset sends no header. All three unset = today's
     * unauthenticated fetch, unchanged.
     */
    username: env("PROMETHEUS_USERNAME"),
    password: env("PROMETHEUS_PASSWORD"),
    orgId: env("PROMETHEUS_ORG_ID"),
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

/**
 * The deployment scope: a `label="value"` matcher EVERY metrics query carries,
 * from `METRICS_SCOPE_LABEL` + `METRICS_SCOPE_VALUE`. For one dashboard per
 * zone (or per tenant) against a shared store whose series all carry that
 * label. Unset = no matcher, the whole store, today's behaviour.
 *
 * Half a pair or a malformed pair THROWS. The alternative — ignore it and
 * read cluster-wide — is exactly the failure this exists to prevent: a
 * dashboard showing another deployment's numbers with nothing on screen to
 * say so. A refused boot is visible; a wrong scope is not.
 */
export function readMetricsScope(source: NodeJS.ProcessEnv = process.env): MetricScope | null {
  const label = source.METRICS_SCOPE_LABEL ?? "";
  const value = source.METRICS_SCOPE_VALUE ?? "";
  if (label === "" && value === "") return null;
  if (label === "" || value === "") {
    throw new Error(
      "METRICS_SCOPE_LABEL and METRICS_SCOPE_VALUE must be set together — half a pair would read the whole store under a scoped name",
    );
  }
  if (!isValidScopeLabel(label)) {
    throw new Error(`METRICS_SCOPE_LABEL ${JSON.stringify(label)} is not a Prometheus label name ([a-zA-Z_][a-zA-Z0-9_]*)`);
  }
  if (!isValidScopeValue(value)) {
    throw new Error(
      `METRICS_SCOPE_VALUE ${JSON.stringify(value)} cannot be embedded in a label matcher (no quotes, backslashes, braces or newlines; at most 253 characters)`,
    );
  }
  return { label, value };
}
