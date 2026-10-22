/**
 * Thin Prometheus HTTP client — ports `app/services/prometheus.py`.
 * Uses the global `fetch` (Node 22+). Never throws on PromQL "no data" — an
 * empty result set is a valid answer the higher layers degrade on. A failed
 * call (non-2xx, timeout, PromQL error) ALSO comes back empty, so it is logged
 * at warn — throttled per distinct failure — or a bad URL and a 401 would
 * read exactly like a quiet router.
 */
import { createHash } from "node:crypto";
import { applyScope, durationSeconds, isValidScope, type MetricScope } from "@sr/shared";
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
  /**
   * How long a successful answer is reused for an identical read (same path,
   * params, scope and credential); a range read is reused for its step
   * instead (`rangeReuseMs`). Default `PROMETHEUS_CACHE_TTL_MS`; 0 keeps
   * every read live and remembers nothing. Identical reads in flight at the
   * same moment share one request whatever the TTL.
   */
  cacheTtlMs?: number;
  /**
   * How long a remembered answer may still stand in for a refused refresh
   * (429, timeout, error envelope) — counted from when it was read, or from
   * the end of its reuse for a range read — and so how long one is kept.
   * Default 60 s. Internal — tests shorten it.
   */
  staleMaxMs?: number;
  /** In-flight and remembered answers, shared across scoped copies. Internal. */
  reads?: ReadStore;
}

/** The answers a client holds: one promise per read in flight, one value per read remembered (read `at`, kept `until`). */
export interface ReadStore {
  inflight: Map<string, Promise<PromResponse<unknown>>>;
  remembered: Map<string, { at: number; until: number; value: PromResponse<unknown> }>;
}

/** One warn line per distinct failure per interval — a dead store must not
 *  turn every panel refresh into forty lines. */
const WARN_INTERVAL_MS = 60_000;

/** The most answers kept; the oldest goes when a new one arrives past this. */
const MAX_REMEMBERED_READS = 4096;

/** How long the last good answer may stand in for a refused refresh. */
const STALE_MAX_MS = 60_000;

/**
 * The longest a range read's answer is reused. Its window ends on a step
 * boundary, so the answer only goes out of date when samples land late
 * (remote-write retries, recorded series written after their timestamp),
 * which Mimir allows for by recomputing its newest 10 minutes on every read.
 * Five minutes, the age recorded series may reach before the api stops
 * reading them (`METRICS_RECORDED_STALE_MS`), keeps a late sample off a chart
 * for at most that long and turns a 30-day chart's 240 polls an hour (4-hour
 * step) into 12 reads.
 */
export const RANGE_REUSE_MAX_MS = 300_000;

export class PrometheusClient {
  private readonly headers: Record<string, string>;
  private readonly baseScope: MetricScope | null;
  private readonly logger: PromLogger | undefined;
  private readonly warnedAt: Map<string, number>;
  private readonly cacheTtlMs: number;
  private readonly staleMaxMs: number;
  private readonly reads: ReadStore;
  /** The credential's part of a read's key (hashed) — a different tenant's answer is never reused. */
  private readonly authKey: string;

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
    this.cacheTtlMs = options.cacheTtlMs ?? config.prometheus.cacheTtlMs;
    this.staleMaxMs = options.staleMaxMs ?? STALE_MAX_MS;
    this.reads = options.reads ?? { inflight: new Map(), remembered: new Map() };
    this.authKey = createHash("sha256")
      .update(
        Object.entries(this.headers)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(";"),
      )
      .digest("hex");
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
      cacheTtlMs: this.cacheTtlMs,
      staleMaxMs: this.staleMaxMs,
      reads: this.reads,
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

  /**
   * How long a range read's answer is reused: its step, at most
   * RANGE_REUSE_MAX_MS, never less than `cacheTtlMs`; 0 with the cache off.
   * Range reads end on a step boundary (`alignedBounds`), so every poll
   * until the next boundary asks for the same window.
   */
  private rangeReuseMs(step: string): number {
    if (this.cacheTtlMs <= 0) return 0;
    const stepMs = durationSeconds(step) * 1000;
    return Number.isFinite(stepMs) ? Math.max(this.cacheTtlMs, Math.min(stepMs, RANGE_REUSE_MAX_MS)) : this.cacheTtlMs;
  }

  /**
   * One read. Identical reads (same URL — so same path, params and scope —
   * under the same credential) in flight together share one request, and a
   * successful answer is reused for `cacheTtlMs`, a range read's (one with
   * a `step`) for `rangeReuseMs`. Failures are never kept: a refused refresh
   * (429, timeout, error envelope) is answered from the last good answer
   * while that is under `staleMaxMs` old (`staleMaxMs` past its reuse for a
   * range read), and retried by the next caller either way — one refused
   * read must not blank every row a grouped read feeds. `live` reads (the
   * readiness probe) bypass all of it.
   */
  private async get<T>(
    path: string,
    params: Record<string, string>,
    opts: { live?: boolean } = {},
  ): Promise<PromResponse<T>> {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const url = new URL(path, base);
    // Resolving a path against a base drops the base's query string. Carry
    // it over: a proxy that takes its tenant or filter from the URL gets it
    // on every call instead of a request that silently lost it.
    for (const [k, v] of base.searchParams) url.searchParams.set(k, v);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const query = params.query ?? "";
    if (opts.live) return this.fetchOnce<T>(url, query);

    const reuseMs = params.step === undefined ? this.cacheTtlMs : this.rangeReuseMs(params.step);
    const standInMs = params.step === undefined ? this.staleMaxMs : reuseMs + this.staleMaxMs;
    const key = `${this.authKey}\n${url.toString()}`;
    const kept = this.reads.remembered.get(key);
    const age = kept ? Date.now() - kept.at : Infinity;
    if (kept && age < reuseMs) return kept.value as PromResponse<T>;
    const pending = this.reads.inflight.get(key);
    if (pending) return pending as Promise<PromResponse<T>>;

    const request = this.fetchOnce<T>(url, query);
    this.reads.inflight.set(key, request);
    try {
      const response = await request;
      if (response.status === "success") {
        if (reuseMs > 0) this.remember(key, response, Math.max(reuseMs, standInMs));
        return response;
      }
      if (kept && age < standInMs) {
        // One line a minute for the whole store, not one per query.
        this.warn("stale", { query, ageMs: age, error: response.error }, "prometheus refused a refresh — answered from the last good read");
        return kept.value as PromResponse<T>;
      }
      return response;
    } finally {
      this.reads.inflight.delete(key);
    }
  }

  /** Keep `value` under `key` for `keepMs`; drop what no refresh could use any more. */
  private remember(key: string, value: PromResponse<unknown>, keepMs: number): void {
    const { remembered } = this.reads;
    const now = Date.now();
    // Spans differ (a range read is kept for its step), so an expired answer
    // can sit behind a live one: check them all, MAX_REMEMBERED_READS at most.
    // A range read's window moves on at every step boundary, so this is what
    // clears the windows no poll asks for any more.
    for (const [k, v] of remembered) if (v.until <= now) remembered.delete(k);
    // Re-insert so the order stays oldest-first for the cap below.
    remembered.delete(key);
    if (remembered.size >= MAX_REMEMBERED_READS) {
      const oldest = remembered.keys().next().value;
      if (oldest !== undefined) remembered.delete(oldest);
    }
    remembered.set(key, { at: now, until: now + keepMs, value });
  }

  private async fetchOnce<T>(url: URL, query: string): Promise<PromResponse<T>> {
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

  /** Instant query at `timeSeconds` → vector; null when the store didn't answer. */
  async queryAtOrNull(expr: string, timeSeconds: number): Promise<PromVectorSample[] | null> {
    const r = await this.get<PromVectorSample[]>("api/v1/query", {
      query: this.scoped(expr),
      time: String(timeSeconds),
    });
    return r.status === "success" && r.data ? r.data.result : null;
  }

  /** Range query → matrix; null when the store didn't answer, so "no series" and "no answer" stay apart. */
  async queryRangeOrNull(
    expr: string,
    startSeconds: number,
    endSeconds: number,
    step: string,
  ): Promise<PromMatrixSample[] | null> {
    const r = await this.get<PromMatrixSample[]>("api/v1/query_range", {
      query: this.scoped(expr),
      start: String(startSeconds),
      end: String(endSeconds),
      step,
    });
    return r.status === "success" && r.data ? r.data.result : null;
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
    const r = await this.get<PromVectorSample[]>("api/v1/query", { query: "vector(1)" }, { live: true });
    return r.status === "success";
  }
}
