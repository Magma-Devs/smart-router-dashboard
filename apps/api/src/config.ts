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
   * Amazon Bedrock — the model behind any AI surface (MAG-3702).
   *
   * There is deliberately **no API key here.** The AWS SDK signs with SigV4
   * from the default credential chain (env → `~/.aws/credentials` → SSO →
   * container → instance/pod role), so in a cluster the api runs under an IAM
   * role and there is no long-lived secret to mount, rotate or leak. Locally
   * it is whatever `aws configure` / `aws sso login` left behind.
   *
   * Off unless `enabled`, because model calls cost money, and refused while
   * `AUTH_MODE=disabled` — see `bedrockGate()`. An open api would let anyone
   * who can reach it spend the account's Bedrock budget under our identity.
   */
  bedrock: {
    /** Explicit opt-in. Off by default so ambient AWS credentials can't quietly start billing. */
    enabled: env("BEDROCK_ENABLED") === "true" || env("BEDROCK_ENABLED") === "1",
    /**
     * A role to ASSUME on top of whatever the chain resolved. This is how a
     * customer deployment is handed an identity: the box proves who it is
     * once (a Roles Anywhere certificate, an instance profile, a key), and
     * this names the role it should actually act as.
     *
     * Unset — the local case — the chain's own identity is used directly, so
     * a developer with `aws configure` done needs no extra setup.
     */
    roleArn: env("BEDROCK_ROLE_ARN"),
    /**
     * Shared secret the role's trust policy can demand (`sts:ExternalId`).
     * The standard confused-deputy guard for a role assumed across accounts:
     * without it, anyone who learns the role ARN and is trusted by it can
     * assume it. Set whenever `roleArn` points into someone else's account.
     */
    roleExternalId: env("BEDROCK_ROLE_EXTERNAL_ID"),
    region: env("BEDROCK_REGION") ?? "us-east-1",
    /**
     * A cross-region inference profile, not a bare model id. `global.` routes
     * to whichever region has capacity; a bare `anthropic.claude-sonnet-5`
     * is rejected for models only offered through a profile.
     */
    model: env("BEDROCK_MODEL") ?? "global.anthropic.claude-sonnet-5",
    /**
     * Ceiling on one answer, ALWAYS sent. Unset, Bedrock defaults to the
     * model's maximum and reserves that much quota per call — the usual cause
     * of an unexplained ThrottlingException.
     */
    maxTokens: envInt("BEDROCK_MAX_TOKENS", 4096),
    timeoutMs: envInt("BEDROCK_TIMEOUT_MS", 60000),
    /**
     * Per-IP per-minute on the routes that actually call the model, tighter
     * than the global RATE_LIMIT_MAX — the same reasoning as
     * `UPSTREAM_RELAY_RATE_LIMIT_MAX`. Auth stops an anonymous caller; it does
     * not stop a signed-in one looping, and Bedrock has no per-key budget.
     */
    rateLimitMax: envInt("BEDROCK_RATE_LIMIT_MAX", 10),
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
