/**
 * Thin Prometheus HTTP client — ports `app/services/prometheus.py`.
 * Uses the global `fetch` (Node 22+). Never throws on PromQL "no data" — an
 * empty result set is a valid answer the higher layers degrade on.
 */
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

export class PrometheusClient {
  constructor(
    private readonly baseUrl: string = config.prometheus.url,
    private readonly timeoutMs: number = config.prometheus.timeoutMs,
  ) {}

  private async get<T>(path: string, params: Record<string, string>): Promise<PromResponse<T>> {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
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
    const r = await this.get<PromVectorSample[]>("api/v1/query", { query: expr });
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
      query: expr,
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

  /** Liveness probe against Prometheus itself. */
  async ping(): Promise<boolean> {
    try {
      const url = new URL("-/ready", this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
