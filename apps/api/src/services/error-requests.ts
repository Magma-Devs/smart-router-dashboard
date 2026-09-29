/**
 * The Errors tab's request list - every request that hit an error, rebuilt
 * from the router's log lines: which upstream each try went to, what it
 * answered, whose reply went back, and why the router stopped. The counters
 * can't say any of it: they carry only {spec, apiInterface, method}, and the
 * router records a retry only once two of a request's tries have come back.
 * One it wanted to retry with no upstream left, or whose other try never
 * answered, is not in them at all.
 *
 * A request is here when a try failed, when the router decided to retry it,
 * or when it gave up. A try the router called off ("context canceled") is not
 * a failure, and the router's own health and first relays are not requests:
 * no app sent them or waits on them. Lines read, besides the per-try lines
 * `triesOf` reads (router-log.ts):
 *
 *   Consumer received a new …                 when, and the method
 *   [StateMachine] policy.Decide              `action: retry`
 *   failed relay, insufficient results        the router got nothing usable
 *   Circuit breaker: all providers exhausted  it wanted another try, no upstream left
 *   relay finished                            `served_by`, `stop_reason`, `error`,
 *                                             `has_reply`
 *   [-] failed sending init relay             one of the router's own relays
 */
import { WINDOWS, type ErrorRequestRow, type ErrorRequestsReport, type FailedRequests, type MetricWindow, type RequestLookup, type RouterTopology } from "@sr/shared";
import { readEnd, type ReadRange } from "./read-range.js";
import type { LokiClient } from "./loki-client.js";
import type { ConfigurationService } from "./configuration.js";
import {
  escapeRe,
  inRawString,
  LABEL_TOKEN,
  lastWhere,
  linesForGuids,
  linesOfRequest,
  REQUEST_ID,
  methodOf,
  parseAll,
  scrubUrls,
  str,
  TRY_MSG,
  triesOf,
  upstreamIndex,
  withoutGuid,
  type RouterLine,
  type UpstreamInfo,
} from "./router-log.js";

export const ERROR_MSG = {
  received: "Consumer received a new",
  ...TRY_MSG,
  decide: "[StateMachine] policy.Decide",
  noResults: "failed relay, insufficient results",
  exhausted: "Circuit breaker: all providers exhausted",
  finished: "relay finished",
  initRelay: "[-] failed sending init relay",
} as const;

/** The lines that put a request on the list - each one says something went wrong. */
const FOUND_BY = [
  ERROR_MSG.nodeErrorReply,
  ERROR_MSG.nodeError,
  ERROR_MSG.sendFailed,
  ERROR_MSG.directFailed,
  ERROR_MSG.decide,
  ERROR_MSG.noResults,
];

/** Requests one read returns; `more` says when the range holds older ones. */
export const ERROR_READ_CAP = 300;

export { REQUEST_ID } from "./router-log.js";

/** A request's lines can come this long before the first one that finds it
 *  (its arrival) or after it (a try the router gave up on at its deadline). */
const REQUEST_SPAN_MS = 60_000;

/**
 * One row per request that hit an error, newest first. `lookup` resolves an
 * upstream from the mounted config: the lines name the chain only on an error.
 * `every` keeps every request the lines hold - what a look-up by ID wants, for
 * a request that went fine as much as one that didn't.
 */
export function buildErrorRows(
  lines: RouterLine[],
  lookup: (upstream: string) => UpstreamInfo | null,
  every = false,
): ErrorRequestRow[] {
  const byGuid = new Map<string, RouterLine[]>();
  for (const l of lines) byGuid.set(l.guid, [...(byGuid.get(l.guid) ?? []), l]);

  const rows: ErrorRequestRow[] = [];
  for (const [guid, group] of byGuid) {
    const ordered = [...group].sort((a, b) => a.tsMs - b.tsMs);
    const received = ordered.find((l) => l.message.startsWith(ERROR_MSG.received));
    const finished = lastWhere(ordered, (l) => l.message === ERROR_MSG.finished);
    // The router's own relays (its health checks, the first relays of a chain)
    // log neither an arrival nor an end, and no app waits on them.
    if (!every && (ordered.some((l) => l.message === ERROR_MSG.initRelay) || (!received && !finished))) continue;
    const t0 = (received ?? ordered[0]!).tsMs;
    const attempts = triesOf(ordered, t0, finished);
    const replied = attempts.find((a) => a.replied);
    const routerError = finished ? withoutGuid(str(finished.f.error)) : "";

    let result: ErrorRequestRow["result"] = "recovered";
    if (!finished) result = "unknown";
    else if (routerError || str(finished.f.has_reply) === "false") result = "failed";
    else if (replied?.outcome === "failed") result = "error-reply";

    const decidedRetry = ordered.some((l) => l.message === ERROR_MSG.decide && str(l.f.action) === "retry");
    // An answer with nothing failed on the way isn't a recovery.
    if (result === "recovered" && !attempts.some((a) => a.outcome === "failed")) result = "ok";
    // Nothing went wrong after all: every "failure" was a try called off.
    if (!every && !attempts.some((a) => a.outcome === "failed") && result !== "failed" && !decidedRetry) continue;

    const named = ordered.find((l) => str(l.f.chain_id));
    const sentBatches = new Set(attempts.filter((a) => a.outcome !== "skipped").map((a) => a.batch));
    rows.push({
      guid,
      time: Math.round(t0),
      spec: str(named?.f.chain_id) || attempts.map((a) => lookup(a.upstream)).find(Boolean)?.spec || null,
      method: methodOf(received, ordered),
      attempts,
      result,
      resolvedBy: result === "failed" ? null : str(finished?.f.served_by) || null,
      retried: sentBatches.size > 1,
      stopReason: str(finished?.f.stop_reason) || null,
      exhausted:
        str(finished?.f.stop_reason) === "AllProvidersExhausted" ||
        ordered.some((l) => l.message.startsWith(ERROR_MSG.exhausted)),
      totalMs: finished ? Math.round(finished.tsMs - t0) : null,
      error: result === "failed" ? scrubUrls(routerError || "no upstream replied") : null,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/**
 * The one line the router writes per request it gives up on - when no node
 * gave an answer it could use and it returns its own error (the `err != nil`
 * return at the end of SendParsedRelay). Other lines quote it in their error
 * field, so it is matched as the `message`, not anywhere in the line. The
 * router's own relays write "[-] failed sending init relay" instead.
 */
export const GAVE_UP_MSG = "failed processing responses from RPC endpoints";

/** How long a failed-request count is kept before Loki is asked again. */
export const COUNT_TTL_MS = 30_000;

export class ErrorRequestsService {
  constructor(
    private readonly loki: LokiClient | null,
    private readonly selector: string,
    private readonly configSvc?: ConfigurationService,
    private readonly cap: number = ERROR_READ_CAP,
  ) {}

  private routers(): RouterTopology[] {
    return this.configSvc?.getRouters() ?? [];
  }

  /** Upstreams the chain / config router declares; null when neither is asked for. */
  private upstreamsFor(spec?: string, routerId?: string): string[] | null {
    if (!spec && !routerId) return null;
    const routers = this.routers().filter((r) => (!spec || r.spec === spec) && (!routerId || r.id === routerId));
    return [...new Set(routers.flatMap((r) => r.nodes.map((n) => n.name)))];
  }

  /** The last count per window and chain, kept for COUNT_TTL_MS: the count
   *  scans the whole window of logs (a month, on the widest), and every open
   *  page asks for the same number. A failed read isn't kept. */
  private readonly counted = new Map<string, { at: number; result: FailedRequests }>();

  /**
   * How many client requests the router could not serve in `window`: one
   * GAVE_UP_MSG line each, counted by Loki. Prometheus can't give this
   * number: the router's request counters move once per ATTEMPT (and count
   * its own relays), and its one per-request series, the end-to-end latency
   * histogram, is only observed when a request succeeds. A chain narrows it
   * by the listener that logged it (`<spec><interface>`).
   */
  async failedCount(window: MetricWindow, spec?: string): Promise<FailedRequests> {
    const loki = this.loki;
    const none: FailedRequests = { available: false, value: null };
    if (!loki || (spec != null && !LABEL_TOKEN.test(spec))) return none;
    const key = `${window}|${spec ?? ""}`;
    const kept = this.counted.get(key);
    if (kept && Date.now() - kept.at < COUNT_TTL_MS) return kept.result;
    const r = `${WINDOWS[window].rangeSeconds}s`;
    const chain = spec ? ` | ep=~\`${escapeRe(spec)}(jsonrpc|rest|tendermintrpc|grpc)\`` : "";
    const value = await loki.count(
      `sum(count_over_time(${this.selector} |= \`${GAVE_UP_MSG}\` | json msg="message", ep="endpoint" | msg=\`${GAVE_UP_MSG}\`${chain} [${r}]))`,
    );
    if (value === null) return none;
    const result: FailedRequests = { available: true, value };
    this.counted.set(key, { at: Date.now(), result });
    return result;
  }

  /**
   * One request by its ID, whatever happened to it: every line the router
   * wrote for it in `range`, as the same row the list shows. Reads every line
   * in the range for the ID - a month is a heavy read, so the caller widens
   * the range on purpose rather than by default.
   */
  async lookup(guid: string, range: ReadRange): Promise<RequestLookup> {
    const loki = this.loki;
    if (!loki || !REQUEST_ID.test(guid)) return { available: !!loki, row: null };
    const lines = await linesOfRequest(loki, this.selector, guid, range.startMs, range.endMs);
    if (lines === null) return { available: false, row: null };
    const index = upstreamIndex(this.routers());
    const rows = buildErrorRows(lines, (u) => index.get(u) ?? null, true);
    return { available: true, row: rows[0] ?? null };
  }

  /**
   * The newest requests with an error in `range`, ending at `before` when
   * given (the previous read's `nextBefore`). A request whose lines straddle
   * two reads can come back in both; the client keeps it once, by GUID.
   */
  async report(range: ReadRange, spec?: string, routerId?: string, before?: number): Promise<ErrorRequestsReport> {
    const none = (available: boolean): ErrorRequestsReport => ({ available, rows: [], more: false, nextBefore: null });
    const loki = this.loki;
    if (!loki) return none(false);
    const endMs = readEnd(range, before);
    if (endMs <= range.startMs) return none(true);

    // A request writes several of these lines, so read a few per request.
    // Called-off tries are left out here: they alone don't make an error.
    // A chain or router narrows the read to its upstreams' names, so the cap
    // applies to what was asked for.
    const names = this.upstreamsFor(spec, routerId);
    const safe = names?.filter(inRawString);
    const narrow = safe?.length ? ` |~ \`${safe.map(escapeRe).join("|")}\`` : "";
    const limit = this.cap * 4;
    const found = await loki.queryRange(
      `${this.selector} |~ \`${FOUND_BY.map(escapeRe).join("|")}\` !~ \`PROTOCOL_CONTEXT_CANCELED|context canceled\`${narrow}`,
      range.startMs,
      endMs,
      limit,
      "backward",
    );
    if (found === null) return none(false);

    const newestFirst = parseAll(found).sort((a, b) => b.tsMs - a.tsMs);
    const guids = [...new Set(newestFirst.map((l) => l.guid))];
    if (!guids.length) return none(true);
    const kept = new Set(guids.slice(0, this.cap));
    const keptTimes = newestFirst.filter((l) => kept.has(l.guid)).map((l) => l.tsMs);
    const more = found.length >= limit || guids.length > this.cap;
    const oldest = Math.min(...keptTimes);

    const lines = await linesForGuids(
      loki,
      this.selector,
      [...kept],
      oldest - REQUEST_SPAN_MS,
      Object.values(ERROR_MSG),
      40,
      Math.min(Date.now(), Math.max(...keptTimes) + REQUEST_SPAN_MS),
    );
    if (lines === null) return none(false);

    const index = upstreamIndex(this.routers());
    let rows = buildErrorRows(lines, (u) => index.get(u) ?? null);
    if (spec) rows = rows.filter((r) => r.spec === spec);
    if (routerId) {
      const own = new Set(names ?? []);
      rows = rows.filter((r) => r.attempts.some((a) => own.has(a.upstream)));
    }
    // The oldest kept line itself, fraction and all: the next read ends there,
    // so it moves strictly back and skips nothing in that millisecond.
    return { available: true, rows, more, nextBefore: more ? oldest : null };
  }
}
