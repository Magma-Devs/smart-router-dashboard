/**
 * Single source of truth for env-var defaults. Parsed once at startup.
 * Every default is documented in the env-var table in the repo CLAUDE.md.
 */
import { isMetricWindow, isValidScopeLabel, isValidScopeValue, type MetricScope, type MetricWindow } from "@sr/shared";
import { DEFAULT_DB_POOL, type DbPoolOptions } from "@sr/db";

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

/** A metric window, or null for `never` / `off` / `0`; an unknown value takes the fallback. */
function envWindow(name: string, fallback: MetricWindow): MetricWindow | null {
  const raw = env(name)?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "never" || raw === "off" || raw === "0" || raw === "false") return null;
  return isMetricWindow(raw) ? raw : fallback;
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

/**
 * The labels a collector stamps the router identity on, in the order they
 * are tried when `ROUTER_SCOPE_LABEL` is unset: `router` is what the fleet's
 * collector and the chart's ServiceMonitor (6.20.0+) copy from the pod label
 * `app.smart-router-id`; `service` is the Prometheus Operator's automatic
 * label, the router's Service name (`<id>-router`).
 */
export const ROUTER_SCOPE_CANDIDATES = ["router", "service"] as const;

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
     * How long a successful answer is reused for an identical read (same
     * path, params, scope and credential). The panels poll every 15 s, so
     * 10 s means two tabs or two panels asking the same instant read in an
     * interval cost the store one query; range reads stamp their window with
     * the current second, so they share only when they coincide. Per
     * process — each replica keeps its own. 0 keeps every read live;
     * identical reads in flight at the same moment share one request either
     * way, and a refused refresh is answered from the last good read for up
     * to 60 s (see `PrometheusClient`).
     */
    cacheTtlMs: envInt("PROMETHEUS_CACHE_TTL_MS", 10000),
    /**
     * Target label that identifies ONE router deployment, used by the
     * `?router=` scope (see `promql/scope.ts`). The router labels its series
     * with the chain, not with itself, so telling two routers on one chain
     * apart relies on a per-target label the collector attaches. Empty (the
     * default) means "find out": the first of `ROUTER_SCOPE_CANDIDATES` the
     * store reports values for, probed when a request first needs it and
     * remembered once found (`plugins/prometheus.ts`). Set it to `job` for a
     * scrape config that names jobs per router.
     */
    routerScopeLabel: env("ROUTER_SCOPE_LABEL") ?? "",
    /**
     * Recorded reads — see `promql/recorded.ts`. The narrowest window read
     * from the store's recorded series instead of the raw families; windows
     * under it stay raw and exact. `never` (or `off`) holds a tenant on raw
     * reads for every window. The series exist only where the fleet store's
     * ruler evaluates the rules, and only from then on, so the api probes
     * their freshness (`plugins/prometheus.ts`) and reads raw while they are
     * missing or older than `recordedStaleMs`.
     */
    recorded: {
      from: envWindow("METRICS_RECORDED_FROM", "3h"),
      staleMs: envInt("METRICS_RECORDED_STALE_MS", 300_000),
      probeMs: envInt("METRICS_RECORDED_PROBE_MS", 60_000),
      /** How far back the probe looks for the oldest recorded sample; the widest window the dashboard offers. */
      historyLookback: "30d" as const,
    },
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

  /**
   * Log store the Transactions tab, the Errors tab's request list and the
   * Failed requests card read (Loki). The router writes a line for each step
   * of every request, all carrying the request's GUID. Unset ⇒ they say the
   * logs can't be read. `routerSelector` is the LogQL stream selector for the
   * router's lines: `{component="router"}` is what the fleet's log agent and the
   * compose `logs` profile's promtail both label them.
   * Credentials work as the Prometheus ones do: basic auth only with both
   * halves, `X-Scope-OrgID` only when `orgId` is set.
   */
  loki: {
    url: env("LOKI_URL") || undefined,
    timeoutMs: envInt("LOKI_TIMEOUT_MS", 60000),
    routerSelector: env("LOKI_ROUTER_SELECTOR") || '{component="router"}',
    username: env("LOKI_USERNAME"),
    password: env("LOKI_PASSWORD"),
    orgId: env("LOKI_ORG_ID"),
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
    /**
     * 32 bytes, base64 or hex, encrypting every enrolled TOTP secret at rest.
     *
     * **Deliberately not derived from `AUTH_SECRET`.** That key signs sessions
     * and rotating it is a routine operation; if it also unlocked the
     * authenticator secrets, one rotation would invalidate every enrolled phone
     * in the deployment at once. Two very different blast radii, so two keys.
     *
     * No default, and none is possible: a per-boot random key would encrypt
     * secrets the next restart could not read, which presents as "everyone's
     * authenticator broke overnight". Required whenever AUTH_MODE=enabled —
     * `services/two-factor.ts` throws with the `openssl` line to generate one.
     */
    totpEncryptionKey: env("TOTP_ENCRYPTION_KEY"),
    /** What an authenticator app shows as the issuer. Overridable so somebody
     *  administering two dashboards can tell the two entries apart; defaults to
     *  `TOTP_DEFAULT_ISSUER` in `@sr/shared`. */
    totpIssuer: env("TOTP_ISSUER"),
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
   * Which shape of deployment this is. It forks every credential-delivery path,
   * because on-prem has no mail server and never will:
   *
   *  - `managed`  — we host. Invitations and self-serve password resets are
   *                 emailed once `AWS_REGION` is set; an invitation that could
   *                 not be sent comes back to the admin to hand over.
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
   * Who this deployment belongs to, as it appears in the invitation subject
   * ("You've been added to {customer} on Smart Router").
   *
   * An invitation arrives at an address that has never heard of us, so the
   * customer's own name is what stops it reading as spam. Defaults to the
   * product name rather than a placeholder: "You've been added to Smart Router
   * on Smart Router" is clumsy, but "You've been added to {customer}" reaching
   * somebody's inbox is worse.
   */
  customerName: env("CUSTOMER_NAME")?.trim() || "Smart Router",

  /** Browser-facing origin of the web app, used to build invitation and
   *  password-reset links. There is no sane default: guessing a host would
   *  produce a link that looks right and goes nowhere, so the routes that need
   *  it fail loudly instead. */
  publicWebOrigin: env("PUBLIC_WEB_ORIGIN"),

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
 * The web origin links are built on, and the deployment's shape — read from the
 * live environment first.
 *
 * `config` snapshots at module load, which is before any test's `beforeEach`
 * can set a variable, so a route reading the snapshot cannot be tested with
 * more than one value. Every route that builds a link or forks on the mode
 * reads these instead, so they cannot disagree with one another.
 */
export function publicWebOrigin(): string | undefined {
  return process.env.PUBLIC_WEB_ORIGIN?.trim() || config.publicWebOrigin;
}

/** The Loki URL, live env first - same reason as `publicWebOrigin()`. */
export function lokiUrl(): string | undefined {
  return process.env.LOKI_URL?.trim() || config.loki.url;
}

export function deploymentMode(): "managed" | "onprem" {
  const live = process.env.DEPLOYMENT_MODE;
  if (live === "managed" || live === "onprem") return live;
  return config.deploymentMode;
}

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

/**
 * The Postgres pool, per api process — `DB_POOL_MAX` connections, each closed
 * after `DB_IDLE_TIMEOUT_S` seconds idle (0 = kept for the life of the
 * process). Both default to what the api always ran with (`DEFAULT_DB_POOL`:
 * 20 and 30), so a deployment that sets neither is unchanged.
 *
 * Every authenticated request takes a connection for the session join, so the
 * pool bounds a backend's concurrency and, summed over a deployment's backends,
 * what its Postgres must admit. A fleet that runs one backend per node against
 * a shared instance sets this per backend from the instance's connection
 * budget — which is also why a malformed value THROWS instead of defaulting: a
 * pool of `0`, or `abc`, quietly becoming 20 is a budget somebody sized from a
 * value that was never applied. Read live (the db plugin registers after tests
 * set the environment), like `readMetricsScope`.
 */
export function readDbPoolOptions(
  source: NodeJS.ProcessEnv = process.env,
): Required<DbPoolOptions> {
  return {
    max: envWholeNumber(source, "DB_POOL_MAX", DEFAULT_DB_POOL.max, 1),
    idleTimeout: envWholeNumber(source, "DB_IDLE_TIMEOUT_S", DEFAULT_DB_POOL.idleTimeout, 0),
  };
}

/** Unset or empty takes the fallback; anything else must be digits only and at least `min`. */
function envWholeNumber(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
): number {
  const raw = source[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new Error(
      `${name} must be a whole number of at least ${min}, got ${JSON.stringify(raw)}`,
    );
  }
  return Number(raw);
}

/**
 * Customer-reported incidents (`POST /api/incidents`), from the live env so
 * tests can flip them per app instance.
 *
 *  - `INCIDENTS_ENABLED` — the switch. Off unless it is exactly `true`: the
 *    route sends a report into our on-call system, and with the default
 *    `AUTH_MODE=disabled` anyone who can reach the api may send one, so it is
 *    opt-in per deployment, never on by accident.
 *  - `INCIDENT_WEBHOOK_URL` — the deployment's own inbound webhook in our
 *    on-call system. The URL is the credential, so it arrives from a Secret.
 *    https only; plain http is accepted for a loopback host, which is a local
 *    mock and nothing else.
 *  - `INCIDENT_WEBHOOK_TIMEOUT_MS` (10 s), `INCIDENT_RATE_LIMIT_MAX` (3 per
 *    caller per 10 minutes) and `INCIDENT_POD_MAX` (10 per 5 minutes from
 *    every caller together, per api process) — see `services/incidents.ts`.
 *
 * Switched on with no usable URL is NOT a refused boot: the dashboard is the
 * customer's view of their traffic, and losing it over the incident form would
 * be the worse outage. `problem` says what is wrong; the api logs it at boot
 * and every report answers 503, which the form shows.
 */
export interface IncidentSettings {
  enabled: boolean;
  /** Null when unset or refused — `problem` says which. */
  webhookUrl: string | null;
  problem: string | null;
  timeoutMs: number;
  perIpMax: number;
  podMax: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function readIncidentSettings(source: NodeJS.ProcessEnv = process.env): IncidentSettings {
  const enabled = source.INCIDENTS_ENABLED?.trim().toLowerCase() === "true";
  const raw = source.INCIDENT_WEBHOOK_URL?.trim() ?? "";
  let webhookUrl: string | null = null;
  let problem: string | null = null;
  if (raw === "") {
    problem = "INCIDENT_WEBHOOK_URL is not set";
  } else {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      problem = "INCIDENT_WEBHOOK_URL is not a URL";
    }
    if (url) {
      const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
      if (secure) webhookUrl = url.toString();
      else problem = "INCIDENT_WEBHOOK_URL must be https";
    }
  }
  return {
    enabled,
    webhookUrl,
    problem: enabled ? problem : null,
    timeoutMs: positiveInt(source.INCIDENT_WEBHOOK_TIMEOUT_MS, 10_000),
    perIpMax: positiveInt(source.INCIDENT_RATE_LIMIT_MAX, 3),
    podMax: positiveInt(source.INCIDENT_POD_MAX, 10),
  };
}
