/**
 * Thin Prometheus HTTP client — ports `app/services/prometheus.py`.
 * Uses the global `fetch` (Node 22+). Never throws on PromQL "no data" — an
 * empty result set is a valid answer the higher layers degrade on. A failed
 * call (non-2xx, timeout, PromQL error) ALSO comes back empty, so it is logged
 * at warn — throttled per distinct failure — or a bad URL and a 401 would
 * read exactly like a quiet router.
 */
import { applyScope, isValidScope, type MetricScope } from "@sr/shared";
import { config } from "../config.js";

export interface PromMetric {
  [label: string]: string;
}

export interface PromVectorSample {
  metric: PromMetric;
  /** [unixSeconds, stringValue] */
  value: [number, string];
}

export interface PromMatrixSample {
  metric: PromMetric;
  /** [unixSeconds, stringValue][] */
  values: [number, string][];
}

export interface PromResponse<T> {
  status: "success" | "error";
  data?: { resultType: string; result: T };
  error?: string;
}

/** What the client sends to authenticate and (optionally) name its org. */
export interface PromAuth {
  username?: string;
  password?: string;
  /** Sent as `X-Scope-OrgID` — for a multi-tenant store that takes the org from the client. */
  orgId?: string;
}

/**
 * The fixed headers for one auth config. Basic auth only when BOTH halves
 * are present — half a credential would turn every query into a 401 that
 * reads, from the dashboard, exactly like "no data".
 */
export function buildAuthHeaders(auth: PromAuth): Record<string, string> {
  const headers: Record<string, string> = {};
  if (auth.username && auth.password) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
  }
  if (auth.orgId) headers["X-Scope-OrgID"] = auth.orgId;
  return headers;
}

/** The slice of a pino logger the client uses. */
export interface PromLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Deployment-wide settings a client carries through `withScope`. */
export interface PromClientOptions {
  /**
   * The deployment scope (`METRICS_SCOPE_*`): a matcher every query carries,
   * `cache_*` included, under any per-request router scope. See
   * `readMetricsScope()` in `config.ts`.
   */
  baseScope?: MetricScope | null;
  /** Where failed calls are reported. Unset = silent (tests, scripts). */
  logger?: PromLogger;
  /** Throttle state, shared across scoped copies. Internal. */
  warnedAt?: Map<string, number>;
}

/** One warn line per distinct failure per interval — a dead store must not
 *  turn every panel refresh into forty lines. */
const WARN_INTERVAL_MS = 60_000;

export class PrometheusClient {
  private readonly headers: Record<string, string>;
  private readonly baseScope: MetricScope | null;
  private readonly logger: PromLogger | undefined;
  private readonly warnedAt: Map<string, number>;

  constructor(
    private readonly baseUrl: string = config.prometheus.url,
    private readonly timeoutMs: number = config.prometheus.timeoutMs,
    /**
     * Router scope applied to every query this client runs. Injected here
     * rather than threaded through ~40 builders — see `promql/scope.ts`.
     */
    private readonly scope: MetricScope | null = null,
    private readonly auth: PromAuth = config.prometheus,
    private readonly options: PromClientOptions = {},
  ) {
    this.headers = buildAuthHeaders(auth);
    this.baseScope = isValidScope(options.baseScope) ? options.baseScope : null;
    this.logger = options.logger;
    this.warnedAt = options.warnedAt ?? new Map();
  }

  /**
   * A client restricted to one router, on top of the deployment scope.
   * Returns `this` when the scope is absent or malformed, so a bad value
   * reads deployment-wide rather than silently becoming a different query.
   */
  withScope(scope: MetricScope | null | undefined): PrometheusClient {
    if (!isValidScope(scope)) return this;
    return new PrometheusClient(this.baseUrl, this.timeoutMs, scope, this.auth, {
      ...this.options,
      warnedAt: this.warnedAt,
    });
  }

  /** Deployment scope first, router scope on top — each selector gets both. */
  private scoped(expr: string): string {
    return applyScope(applyScope(expr, this.baseScope, { cache: true }), this.scope);
  }

  private warn(key: string, obj: Record<string, unknown>, msg: string): void {
    if (!this.logger) return;
    const now = Date.now();
    if (now - (this.warnedAt.get(key) ?? 0) < WARN_INTERVAL_MS) return;
    this.warnedAt.set(key, now);
    this.logger.warn(obj, msg);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<PromResponse<T>> {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const url = new URL(path, base);
    // Resolving a path against a base drops the base's query string. Carry
    // it over: a proxy that takes its tenant or filter from the URL gets it
    // on every call instead of a request that silently lost it.
    for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const query = params.query ?? "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: this.headers });
      if (!res.ok) {
        // Prometheus puts the PromQL error in the body; keep enough to read it.
        const body = (await res.text().catch(() => "")).slice(0, 300);
        this.warn(`http:${res.status}:${body}`, { status: res.status, body, query, url: url.origin + url.pathname }, "prometheus call failed");
        return { status: "error", error: `prometheus ${res.status}` };
      }
      const parsed = (await res.json()) as PromResponse<T>;
      if (parsed.status === "error") {
        this.warn(`promql:${parsed.error ?? ""}`, { error: parsed.error, query }, "prometheus returned an error");
      }
      return parsed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`fetch:${message}`, { error: message, query, url: url.origin + url.pathname }, "prometheus unreachable");
      return { status: "error", error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Instant query → vector. */
  async query(expr: string): Promise<PromVectorSample[]> {
    const r = await this.get<PromVectorSample[]>("api/v1/query", {
      query: this.scoped(expr),
    });
    return r.status === "success" && r.data ? r.data.result : [];
  }

  /** Range query → matrix. */
  async queryRange(
    expr: string,
    startSeconds: number,
    endSeconds: number,
    step: string,
  ): Promise<PromMatrixSample[]> {
    const r = await this.get<PromMatrixSample[]>("api/v1/query_range", {
      query: this.scoped(expr),
      start: String(startSeconds),
      end: String(endSeconds),
      step,
    });
    return r.status === "success" && r.data ? r.data.result : [];
  }

  /** First scalar value of an instant query, or null when no sample. */
  async scalar(expr: string): Promise<number | null> {
    const result = await this.query(expr);
    const first = result[0];
    if (!first) return null;
    const n = Number(first.value[1]);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Readiness probe against the store. A trivial instant query rather than
   * `-/ready`: that route exists on a bare Prometheus but not under Mimir's
   * `/prometheus` API or behind a query-only proxy, and a probe that the
   * real read path cannot answer would hold the pod NotReady forever. The
   * query also exercises the credential, so a 401 shows up here first.
   */
  async ping(): Promise<boolean> {
    const r = await this.get<PromVectorSample[]>("api/v1/query", { query: "vector(1)" });
    return r.status === "success";
  }
}
