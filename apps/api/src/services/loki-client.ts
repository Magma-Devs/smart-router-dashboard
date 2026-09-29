/**
 * Minimal Loki reader: `query_range` for the lines the Transactions and Errors
 * tabs rebuild requests from, and an instant `count` for the Failed requests
 * card.
 *
 * Returns `null` when the logs could not be read - distinct from `[]`, "no
 * matching lines" - so the caller can say which. Failures are logged at warn,
 * one line per distinct failure per minute, like the Prometheus client.
 */
import { config } from "../config.js";
import type { PromLogger } from "./prometheus-client.js";

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

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = config.loki.timeoutMs,
    private readonly logger?: PromLogger,
  ) {}

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
      const res = await fetch(url, { signal: controller.signal });
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
      const res = await fetch(url, { signal: controller.signal });
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
}
