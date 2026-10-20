/**
 * Minimal Loki reader: `query_range` for the lines the Transactions and Errors
 * tabs rebuild requests from, an instant `count` for the Failed requests
 * card, grouped metric queries (`metricRange`, `metricAt`) for the
 * Transactions tab's chart, and `volume` - what a stretch of logs weighs,
 * from the index alone - for sizing a read before it is made.
 *
 * Returns `null` when the logs could not be read - distinct from `[]`, "no
 * matching lines" - so the caller can say which. Failures are logged at warn,
 * one line per distinct failure per minute, like the Prometheus client.
 */
import { config } from "../config.js";
import { buildAuthHeaders, type PromAuth, type PromLogger } from "./prometheus-client.js";

export interface LokiLine {
  /**
   * Unix ms, fraction kept (Loki reports nanoseconds). The fraction is what
   * orders one request's lines: a router writes several in the same
   * millisecond, at different levels - and each level is its own stream.
   */
  tsMs: number;
  line: string;
}

interface LokiStreamsResponse {
  status: string;
  data?: { result: { values: [string, string][] }[] };
}

interface LokiVectorResponse {
  status: string;
  data?: { resultType?: string; result: { value: [number, string] }[] };
}

interface LokiMetricResponse {
  status: string;
  data?: { resultType?: string; result: { metric?: Record<string, string>; value?: [number, string]; values?: [number, string][] }[] };
}

/** One series of a metric query: its labels and its points, `[unix s, value]` - one point for an instant query. */
export interface LokiSeries {
  metric: Record<string, string>;
  values: [number, number][];
}

/** `index/stats` answers bare, with no status envelope. */
interface LokiIndexStats {
  bytes?: number;
}

const WARN_INTERVAL_MS = 60_000;

/** Unix ms → the nanosecond string Loki takes, fraction kept: a read that
 *  ends where the last one's oldest line was must not round past it. */
export function msToNs(ms: number): string {
  let whole = Math.floor(ms);
  let frac = Math.round((ms - whole) * 1e6);
  if (frac >= 1e6) {
    whole += 1;
    frac = 0;
  }
  return `${whole}${String(frac).padStart(6, "0")}`;
}

export class LokiClient {
  private readonly warnedAt = new Map<string, number>();
  private readonly headers: Record<string, string>;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = config.loki.timeoutMs,
    private readonly logger?: PromLogger,
    auth: PromAuth = {},
  ) {
    this.headers = buildAuthHeaders(auth);
  }

  private warn(key: string, obj: Record<string, unknown>, msg: string): void {
    if (!this.logger) return;
    const now = Date.now();
    if (now - (this.warnedAt.get(key) ?? 0) < WARN_INTERVAL_MS) return;
    this.warnedAt.set(key, now);
    this.logger.warn(obj, msg);
  }

  /** Lines matching `query` between two unix-ms times, at most `limit` of them. */
  async queryRange(
    query: string,
    startMs: number,
    endMs: number,
    limit: number,
    direction: "forward" | "backward",
  ): Promise<LokiLine[] | null> {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const url = new URL("loki/api/v1/query_range", base);
    url.searchParams.set("query", query);
    url.searchParams.set("start", msToNs(startMs));
    url.searchParams.set("end", msToNs(endMs));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("direction", direction);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: this.headers });
      if (!res.ok) {
        // Loki puts the LogQL error in the body; keep enough to read it.
        const body = (await res.text().catch(() => "")).slice(0, 300);
        this.warn(`http:${res.status}:${body}`, { status: res.status, body, query }, "loki call failed");
        return null;
      }
      const parsed = (await res.json()) as LokiStreamsResponse;
      if (parsed.status !== "success" || !parsed.data) {
        this.warn(`status:${parsed.status}`, { status: parsed.status, query }, "loki returned no data");
        return null;
      }
      return parsed.data.result.flatMap((s) =>
        s.values.map(([ns, line]) => ({ tsMs: Number(ns) / 1e6, line })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`fetch:${message}`, { error: message, url: url.origin }, "loki unreachable");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A metric query's series, read from `url`; null when Loki didn't answer. */
  private async metric(url: URL, query: string): Promise<LokiSeries[] | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: this.headers });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        this.warn(`http:${res.status}:${body}`, { status: res.status, body, query }, "loki call failed");
        return null;
      }
      const parsed = (await res.json()) as LokiMetricResponse;
      if (parsed.status !== "success" || !parsed.data) {
        this.warn(`status:${parsed.status}`, { status: parsed.status, query }, "loki returned no data");
        return null;
      }
      return parsed.data.result.map((r) => ({
        metric: r.metric ?? {},
        values: (r.values ?? (r.value ? [r.value] : [])).map(([t, v]): [number, number] => [Number(t), Number(v) || 0]),
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`fetch:${message}`, { error: message, url: url.origin }, "loki unreachable");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private endpoint(path: string): URL {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL(path, base);
  }

  /** A metric query (`sum by (…) (count_over_time(…))`) from `startSec` to `endSec`, a point each `stepSec`. */
  async metricRange(query: string, startSec: number, endSec: number, stepSec: number): Promise<LokiSeries[] | null> {
    const url = this.endpoint("loki/api/v1/query_range");
    url.searchParams.set("query", query);
    url.searchParams.set("start", String(startSec));
    url.searchParams.set("end", String(endSec));
    url.searchParams.set("step", String(stepSec));
    return this.metric(url, query);
  }

  /** A metric query at `timeSec`: one point per series. */
  async metricAt(query: string, timeSec: number): Promise<LokiSeries[] | null> {
    const url = this.endpoint("loki/api/v1/query");
    url.searchParams.set("query", query);
    url.searchParams.set("time", String(timeSec));
    return this.metric(url, query);
  }

  /** One number from a metric query (`sum(count_over_time(…))`), now: the
   *  vector's values added up - 0 when nothing matched, null when Loki
   *  didn't answer. */
  async count(query: string): Promise<number | null> {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const url = new URL("loki/api/v1/query", base);
    url.searchParams.set("query", query);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: this.headers });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        this.warn(`http:${res.status}:${body}`, { status: res.status, body, query }, "loki call failed");
        return null;
      }
      const parsed = (await res.json()) as LokiVectorResponse;
      if (parsed.status !== "success" || !parsed.data) {
        this.warn(`status:${parsed.status}`, { status: parsed.status, query }, "loki returned no data");
        return null;
      }
      return parsed.data.result.reduce((sum, r) => sum + (Number(r.value[1]) || 0), 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`fetch:${message}`, { error: message, url: url.origin }, "loki unreachable");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bytes of log lines the streams `selector` picks hold between two unix-ms
   * times, from Loki's index (`index/stats`): no chunk is read, so it answers
   * in well under a second for a month of the busiest tenant. A line filter
   * does not make a read cheaper - every chunk of the selected streams is
   * still opened - so this is what a read of that stretch scans. Null when
   * Loki didn't answer.
   */
  async volume(selector: string, startMs: number, endMs: number): Promise<number | null> {
    const base = new URL(this.baseUrl);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    const url = new URL("loki/api/v1/index/stats", base);
    url.searchParams.set("query", selector);
    url.searchParams.set("start", msToNs(startMs));
    url.searchParams.set("end", msToNs(endMs));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: this.headers });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        this.warn(`http:${res.status}:${body}`, { status: res.status, body, selector }, "loki index stats failed");
        return null;
      }
      const parsed = (await res.json()) as LokiIndexStats;
      return typeof parsed.bytes === "number" && Number.isFinite(parsed.bytes) ? parsed.bytes : null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.warn(`fetch:${message}`, { error: message, url: url.origin }, "loki unreachable");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
