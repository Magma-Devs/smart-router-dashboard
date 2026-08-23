/**
 * Thin Prometheus HTTP client — ports `app/services/prometheus.py`.
 * Uses the global `fetch` (Node 22+). Never throws on PromQL "no data" — an
 * empty result set is a valid answer the higher layers degrade on.
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

export class PrometheusClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly baseUrl: string = config.prometheus.url,
    private readonly timeoutMs: number = config.prometheus.timeoutMs,
    /**
     * Router scope applied to every query this client runs. Injected here
     * rather than threaded through ~40 builders — see `promql/scope.ts`.
     */
    private readonly scope: MetricScope | null = null,
    private readonly auth: PromAuth = config.prometheus,
  ) {
    this.headers = buildAuthHeaders(auth);
  }

  /**
   * A client restricted to one router. Returns `this` when the scope is
   * absent or malformed, so a bad value reads cluster-wide rather than
   * silently becoming a different query.
   */
  withScope(scope: MetricScope | null | undefined): PrometheusClient {
    if (!isValidScope(scope)) return this;
    return new PrometheusClient(this.baseUrl, this.timeoutMs, scope, this.auth);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<PromResponse<T>> {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: this.headers });
      if (!res.ok) {
        return { status: "error", error: `prometheus ${res.status}` };
      }
      return (await res.json()) as PromResponse<T>;
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Instant query → vector. */
  async query(expr: string): Promise<PromVectorSample[]> {
    const r = await this.get<PromVectorSample[]>("api/v1/query", {
      query: applyScope(expr, this.scope),
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
      query: applyScope(expr, this.scope),
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
