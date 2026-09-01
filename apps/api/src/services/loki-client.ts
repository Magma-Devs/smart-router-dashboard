/**
 * Thin Loki HTTP client — the log-side counterpart to `prometheus-client.ts`,
 * and deliberately the same shape: global `fetch`, one timeout, and an empty
 * result is a valid answer rather than a throw.
 *
 * It knows exactly one query (`buildTraceQuery`), because that is all this
 * feature does with logs.
 */
import { buildTraceQuery, TRACE_SEARCH_WINDOWS_SEC, type TraceLogLine } from "@sr/shared";
import { config } from "../config.js";

/** Loki's `query_range` payload, narrowed to the parts we read. */
interface LokiStream {
  stream?: Record<string, string>;
  /** [unixNanosecondsAsString, rawLine][] */
  values?: [string, string][];
}
interface LokiResponse {
  status?: string;
  data?: { resultType?: string; result?: LokiStream[] };
}

/** The log store is unreachable or unhappy — distinct from "found nothing". */
export class LokiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LokiUnavailableError";
  }
}

export class LokiClient {
  constructor(
    private readonly baseUrl: string | undefined = config.loki.url,
    private readonly timeoutMs: number = config.loki.timeoutMs,
    private readonly selector: string = config.loki.routerSelector,
  ) {}

  /** False when no LOKI_URL is set. The route turns this into a 503 that says
   *  "no log store configured" — which must never read as "relay not found". */
  get configured(): boolean {
    return typeof this.baseUrl === "string" && this.baseUrl.length > 0;
  }

  private async queryRange(query: string, startNs: bigint, endNs: bigint, limit: number): Promise<LokiStream[]> {
    const base = this.baseUrl!;
    const url = new URL("/loki/api/v1/query_range", base.endsWith("/") ? base : `${base}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("start", startNs.toString());
    url.searchParams.set("end", endNs.toString());
    url.searchParams.set("limit", String(limit));
    // Oldest first: the trail reads as a story, and a `limit` cut then drops
    // the END of the relay rather than its beginning.
    url.searchParams.set("direction", "forward");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new LokiUnavailableError(
          `Loki answered ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        );
      }
      const json = (await res.json()) as LokiResponse;
      return json.data?.result ?? [];
    } catch (e) {
      if (e instanceof LokiUnavailableError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new LokiUnavailableError(`Loki did not answer within ${this.timeoutMs}ms.`);
      }
      throw new LokiUnavailableError(
        `Could not reach the log store: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Every line carrying this GUID, oldest first.
   *
   * Widens the search window until it finds something rather than scanning the
   * full retention every time: a relay fired thirty seconds ago is the common
   * case, and a seven-day scan to find it is pure waste. Returns whichever
   * window first produced lines — and the widest window's empty result when
   * none did, so the caller can report how far back it actually looked.
   */
  async linesForGuid(guid: string, limit: number): Promise<{ lines: TraceLogLine[]; fromMs: number; toMs: number }> {
    const query = buildTraceQuery(guid, this.selector);
    const nowMs = Date.now();
    const endNs = BigInt(nowMs) * 1_000_000n;

    let widest = { lines: [] as TraceLogLine[], fromMs: nowMs, toMs: nowMs };
    for (const windowSec of TRACE_SEARCH_WINDOWS_SEC) {
      const fromMs = nowMs - windowSec * 1000;
      const streams = await this.queryRange(query, BigInt(fromMs) * 1_000_000n, endNs, limit);
      const lines = flatten(streams);
      widest = { lines, fromMs, toMs: nowMs };
      if (lines.length > 0) return widest;
    }
    return widest;
  }
}

/**
 * Flatten Loki's per-stream grouping into one time-ordered list.
 *
 * Loki orders within a stream, not across them — and a relay's lines land in
 * several streams whenever the level changes mid-relay, which is exactly what
 * happens when something goes wrong. So they have to be merged here.
 *
 * ⚠ Sort on the NANOSECOND string, not on the millisecond we expose. A router
 * relay writes most of its trail inside one or two milliseconds — measured on a
 * real 30-line trace: groups of 7, 6 and 5 lines sharing a millisecond, and 19
 * of 30 positions differing between the two sorts, with the relay's own entry
 * line landing fourth. Milliseconds are too coarse to order the exact stretch
 * where the story is densest, and `trace-explain.ts` promises the model these
 * are oldest-first.
 */
function flatten(streams: LokiStream[]): TraceLogLine[] {
  const withKey: { ns: bigint; row: TraceLogLine }[] = [];
  for (const s of streams) {
    const level = s.stream?.level ?? null;
    for (const [ns, line] of s.values ?? []) {
      // Nanoseconds overflow a JS number, so they arrive (and sort) as BigInt.
      // Milliseconds is all the UI needs and stays exact.
      const big = BigInt(ns);
      withKey.push({ ns: big, row: { tMs: Number(big / 1_000_000n), line, level } });
    }
  }
  withKey.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  // The ns key stays internal — the wire type is unchanged.
  return withKey.map((w) => w.row);
}
