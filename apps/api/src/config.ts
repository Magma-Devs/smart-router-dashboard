/**
 * Single source of truth for env-var defaults. Parsed once at startup.
 * Every default is documented in the env-var table in the repo CLAUDE.md.
 */

/**
 * An env var, with EMPTY treated as unset.
 *
 * Compose passes optional vars through as `FOO=${FOO:-}`, which sets them to
 * the empty string rather than leaving them out — and `""` is not `undefined`,
 * so `env("X") ?? fallback` would hand back `""` and skip the default. That
 * silently produced a model name of `""` and a request to
 * `/models/:generateContent`, which 404s in a way that reads like a bad key.
 * Every caller here means "unset" when the value is blank.
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
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

/** Model providers the relay-trace explanation can call. */
export type TraceAiProvider = "anthropic" | "gemini";

/** Default model per provider. `TRACE_AI_MODEL` overrides either — model names
 *  move faster than this file does, so the override is the supported escape
 *  hatch rather than an edge case. */
const DEFAULT_TRACE_MODELS: Record<TraceAiProvider, string> = {
  anthropic: "claude-sonnet-5",
  gemini: "gemini-3.6-flash",
};

/**
 * `TRACE_AI_PROVIDER` when set and valid; otherwise inferred from whichever
 * key is present. `null` means neither — the Ask-AI button is not offered and
 * the explain route 404s, rather than a button that can only fail.
 */
function traceAiProvider(): TraceAiProvider | null {
  const named = env("TRACE_AI_PROVIDER")?.trim().toLowerCase();
  if (named === "anthropic" || named === "gemini") return named;
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  if (env("GEMINI_API_KEY")) return "gemini";
  return null;
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
   * Loki, for the Relay Trace surface (`GET /api/trace/:guid`).
   *
   * `url` unset is the normal state on a deployment with no bundled log stack,
   * and the route says so explicitly rather than answering with an empty
   * trace — "no log store here" and "no such relay" are different facts.
   */
  loki: {
    url: env("LOKI_URL"),
    timeoutMs: envInt("LOKI_TIMEOUT_MS", 10000),
    /**
     * Stream selector for the router's logs. Which labels a collector attaches
     * is a property of the deployment, not of the dashboard — the same reason
     * `ROUTER_SCOPE_LABEL` exists for Prometheus. The bundled Promtail sets
     * `service` from the compose service name.
     */
    routerSelector: env("LOKI_ROUTER_SELECTOR") ?? '{service="router"}',
  },

  /**
   * The AI explanation layered on a trace. Off unless configured: it spends
   * money and sends log content (which includes relay request bodies) to a
   * third party. With it off, `/api/trace/:guid` still returns the raw lines,
   * so the page degrades to a GUID-scoped log viewer rather than breaking.
   */
  traceAi: {
    enabled: (env("TRACE_AI_ENABLED") ?? "false").toLowerCase() === "true",
    /**
     * Which model answers. `TRACE_AI_PROVIDER` decides explicitly; with it
     * unset the provider is inferred from whichever key is present, so setting
     * one key is all a deployment normally has to do. Anthropic wins when both
     * are set and neither is named — an arbitrary tie-break, but a stated one,
     * and `TRACE_AI_PROVIDER` overrides it.
     */
    provider: traceAiProvider(),
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    geminiApiKey: env("GEMINI_API_KEY"),
    /** Per-provider default; `TRACE_AI_MODEL` overrides either. */
    model: env("TRACE_AI_MODEL") ?? DEFAULT_TRACE_MODELS[traceAiProvider() ?? "anthropic"],
    /** Lines past this are dropped before the model call, oldest kept. */
    maxLines: envInt("TRACE_MAX_LINES", 400),
    /** Per-IP per-minute, tighter than RATE_LIMIT_MAX — each call costs. */
    rateLimitMax: envInt("TRACE_AI_RATE_LIMIT_MAX", 10),
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
