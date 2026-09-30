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
 *   failed getting responses from …           nothing came back; the router's last
 *                                             line for the request (no "relay finished")
 *   failed processing responses from …        nothing usable came back
 *   [-] failed sending init relay             one of the router's own relays
 */
import type {
  ErrorRequestRow,
  ErrorRequestsReport,
  FailedRequests,
  LogUnavailable,
  MetricWindow,
  RequestLookup,
  RouterTopology,
} from "@sr/shared";
import { WINDOWS } from "@sr/shared";
import { readEnd, readOnFrom, type ReadRange } from "./read-range.js";
import type { LokiClient } from "./loki-client.js";
import type { ConfigurationService } from "./configuration.js";
import {
  chainOf,
  END_MSG,
  escapeRe,
  inRawString,
  LABEL_TOKEN,
  lastWhere,
  listenerPattern,
  guidSpans,
  linesForGuids,
  linesOfRequest,
  REQUEST_ID,
  methodOf,
  namesOf,
  onChain,
  ownRow,
  parseAll,
  scrubUrls,
  str,
  TRY_MSG,
  triesOf,
  UpstreamIndex,
  withoutGuid,
  type RouterLine,
} from "./router-log.js";

export const ERROR_MSG = {
  received: "Consumer received a new",
  ...TRY_MSG,
  decide: "[StateMachine] policy.Decide",
  noResults: "failed relay, insufficient results",
  exhausted: "Circuit breaker: all providers exhausted",
  finished: "relay finished",
  noAnswer: END_MSG.noAnswer,
  gaveUp: END_MSG.gaveUp,
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
  ERROR_MSG.noAnswer,
  ERROR_MSG.gaveUp,
];

/** Requests one read returns; `more` says when the range holds older ones. */
export const ERROR_READ_CAP = 300;

export { REQUEST_ID } from "./router-log.js";

/** A request's lines can come this long before the first one that finds it
 *  (its arrival) or after it (a try the router gave up on at its deadline). */
const REQUEST_SPAN_MS = 60_000;

/**
 * One row per request that hit an error, newest first. `index` resolves a
 * request's chain from the mounted config when no line names it. `every`
 * keeps every request the lines hold - what a look-up by ID wants, for a
 * request that went fine as much as one that didn't.
 */
export function buildErrorRows(lines: RouterLine[], index: UpstreamIndex, every = false): ErrorRequestRow[] {
  const byGuid = new Map<string, RouterLine[]>();
  for (const l of lines) byGuid.set(l.guid, [...(byGuid.get(l.guid) ?? []), l]);

  const rows: ErrorRequestRow[] = [];
  for (const [guid, group] of byGuid) {
    const ordered = [...group].sort((a, b) => a.tsMs - b.tsMs);
    const received = ordered.find((l) => l.message.startsWith(ERROR_MSG.received));
    const finished = lastWhere(ordered, (l) => l.message === ERROR_MSG.finished);
    // With nothing back at all the router's last line is `noAnswer`: it
    // returns before writing "relay finished".
    const gaveUp = lastWhere(ordered, (l) => l.message === ERROR_MSG.noAnswer || l.message === ERROR_MSG.gaveUp);
    // The router's own relays (its health checks, the first relays of a chain)
    // log neither an arrival nor an end, and no app waits on them.
    if (!every && (ordered.some((l) => l.message === ERROR_MSG.initRelay) || (!received && !finished && !gaveUp))) continue;
    const t0 = (received ?? ordered[0]!).tsMs;
    const attempts = triesOf(ordered, t0, finished);
    const replied = attempts.find((a) => a.replied);
    const routerError = withoutGuid(str((finished ?? gaveUp)?.f.error));

    let result: ErrorRequestRow["result"] = "recovered";
    if (!finished) result = gaveUp ? "failed" : "unknown";
    else if (routerError || str(finished.f.has_reply) === "false") result = "failed";
    else if (replied?.outcome === "failed") result = "error-reply";

    const decidedRetry = ordered.some((l) => l.message === ERROR_MSG.decide && str(l.f.action) === "retry");
    // An answer with nothing failed on the way isn't a recovery.
    if (result === "recovered" && !attempts.some((a) => a.outcome === "failed")) result = "ok";
    // Nothing went wrong after all: every "failure" was a try called off.
    if (!every && !attempts.some((a) => a.outcome === "failed") && result !== "failed" && !decidedRetry) continue;

    const sentBatches = new Set(attempts.filter((a) => a.outcome !== "skipped").map((a) => a.batch));
    const end = finished ?? gaveUp;
    rows.push({
      guid,
      time: Math.round(t0),
      ...chainOf(ordered, namesOf(ordered, attempts), index),
      method: methodOf(received, ordered),
      attempts,
      result,
      resolvedBy: result === "failed" ? null : str(finished?.f.served_by) || null,
      retried: sentBatches.size > 1,
      stopReason: str(finished?.f.stop_reason) || null,
      exhausted:
        str(finished?.f.stop_reason) === "AllProvidersExhausted" ||
        ordered.some((l) => l.message.startsWith(ERROR_MSG.exhausted)),
      totalMs: end ? Math.round(end.tsMs - t0) : null,
      error: result === "failed" ? scrubUrls(routerError || "no upstream replied") : null,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/**
 * The lines the router writes, one per client request it could not serve:
 * nothing came back (`noAnswer`) or nothing usable did (`gaveUp`). A request
 * writes one or the other, never both. Other lines quote them in their error
 * field, so each is matched as the `message`, not anywhere in the line. A
 * write whose outcome is unknown after a partial reply is in neither.
 */
export const GAVE_UP = `failed (getting|processing) responses from RPC endpoints`;

/** How long a failed-request count is kept before Loki is asked again - a failed read too. */
export const COUNT_TTL_MS = 30_000;

/** Counts kept at most: one per window and chain in use. */
const COUNT_KEEP = 256;

const unavailable = <R extends string>(reason: R) => ({ available: false as const, reason });

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

  private readonly counted = new Map<string, { at: number; result: FailedRequests }>();
  private readonly counting = new Map<string, Promise<FailedRequests>>();

  private keep(key: string, result: FailedRequests): void {
    this.counted.delete(key);
    this.counted.set(key, { at: Date.now(), result });
    if (this.counted.size > COUNT_KEEP) this.counted.delete(this.counted.keys().next().value!);
  }

  /**
   * How many client requests the router could not serve in `window`: one
   * GAVE_UP line each, counted by Loki. Prometheus can't give this number:
   * the router's request counters move once per ATTEMPT (and count its own
   * relays), and its one per-request series, the end-to-end latency
   * histogram, is only observed when a request succeeds. A chain narrows it
   * by the listener that logged it (`<spec><interface>`).
   *
   * A config router narrows it to its chain. The lines don't say which
   * router wrote them, so on a chain several routers serve the count can't
   * be split, and says so. Kept COUNT_TTL_MS per window and chain, one read
   * in flight per key: the count scans the whole window of logs.
   */
  async failedCount(window: MetricWindow, spec?: string, routerId?: string): Promise<FailedRequests> {
    const loki = this.loki;
    if (!loki) return { ...unavailable("unconfigured"), value: null };
    if (spec != null && !LABEL_TOKEN.test(spec)) return { available: true, value: 0 };
    const routers = this.routers();
    let chain = spec;
    if (routerId) {
      const router = routers.find((r) => r.id === routerId);
      if (!router || (spec != null && spec !== router.spec)) return { available: true, value: 0 };
      if (routers.some((r) => r.id !== router.id && r.spec === router.spec)) return { ...unavailable("shared-chain"), value: null };
      chain = router.spec;
    }
    // A chain the values file doesn't serve has no listener to log it.
    if (chain != null && routers.length && !routers.some((r) => r.spec === chain)) return { available: true, value: 0 };

    const key = `${window}|${chain ?? ""}`;
    const kept = this.counted.get(key);
    if (kept && Date.now() - kept.at < COUNT_TTL_MS) return kept.result;
    const pending = this.counting.get(key);
    if (pending) return pending;

    const r = `${WINDOWS[window].rangeSeconds}s`;
    const byChain = chain ? ` | ep=~\`${escapeRe(chain)}(jsonrpc|rest|tendermintrpc|grpc)\`` : "";
    const read = loki
      .count(`sum(count_over_time(${this.selector} |~ \`${GAVE_UP}\` | json msg="message", ep="endpoint" | msg=~\`${GAVE_UP}\`${byChain} [${r}]))`)
      .then((value): FailedRequests => {
        const result: FailedRequests = value === null ? { ...unavailable("unreachable"), value: null } : { available: true, value };
        this.keep(key, result);
        return result;
      })
      .finally(() => this.counting.delete(key));
    this.counting.set(key, read);
    return read;
  }

  /**
   * One request by its ID, whatever happened to it: every line the router
   * wrote for it in `range`, as the same row the list shows. Reads every line
   * in the range for the ID - a month is a heavy read, so the caller widens
   * the range on purpose rather than by default.
   */
  async lookup(guid: string, range: ReadRange): Promise<RequestLookup> {
    const loki = this.loki;
    if (!loki) return { ...unavailable("unconfigured"), row: null };
    if (!REQUEST_ID.test(guid)) return { available: true, row: null };
    const lines = await linesOfRequest(loki, this.selector, guid, range.startMs, range.endMs);
    if (lines === null) return { ...unavailable("unreachable"), row: null };
    const rows = buildErrorRows(lines, new UpstreamIndex(this.routers()), true);
    return { available: true, row: rows[0] ?? null };
  }

  /**
   * The newest requests with an error in `range`, ending at `before` when
   * given (the previous read's `nextBefore`). A request whose lines straddle
   * two reads can come back in both; the client keeps it once, by GUID.
   * `upstream` keeps the requests whose try at that upstream failed - what
   * an errors-over-time bar counts - and narrows the read to it, so the cap
   * applies to what was asked for.
   */
  async report(range: ReadRange, spec?: string, routerId?: string, before?: number, upstream?: string): Promise<ErrorRequestsReport> {
    const read = { startMs: range.startMs, endMs: range.endMs };
    const none = (available: boolean, reason?: LogUnavailable): ErrorRequestsReport =>
      ({ available, ...(reason ? { reason } : { range: read }), rows: [], more: false, nextBefore: null });
    const loki = this.loki;
    if (!loki) return none(false, "unconfigured");
    const endMs = readEnd(range, before);
    if (endMs <= range.startMs) return none(true);

    // A request writes several of these lines, so read a few per request.
    // Called-off tries are left out here: they alone don't make an error.
    // A chain, router or upstream narrows the read to those names, so the
    // cap applies to what was asked for.
    const routers = this.routers();
    const router = routerId ? routers.find((r) => r.id === routerId) : undefined;
    const names = upstream ? [upstream] : this.upstreamsFor(spec, routerId);
    // A request no upstream could be chosen for names none: its end line names the chain's listener.
    const chain = upstream ? undefined : (router?.spec ?? spec);
    const alts = [
      ...(names?.filter(inRawString).map(escapeRe) ?? []),
      ...(names && chain && LABEL_TOKEN.test(chain) ? [listenerPattern(chain)] : []),
    ];
    const narrow = alts.length ? ` |~ \`${alts.join("|")}\`` : "";
    const limit = this.cap * 4;
    const found = await loki.queryRange(
      `${this.selector} |~ \`${FOUND_BY.map(escapeRe).join("|")}\` !~ \`PROTOCOL_CONTEXT_CANCELED|context canceled\`${narrow}`,
      range.startMs,
      endMs,
      limit,
      "backward",
    );
    if (found === null) return none(false, "unreachable");

    const newestFirst = parseAll(found).sort((a, b) => b.tsMs - a.tsMs);
    const newestOf = new Map<string, number>();
    for (const l of newestFirst) if (!newestOf.has(l.guid)) newestOf.set(l.guid, l.tsMs);
    if (!newestOf.size) return none(true);
    const ranked = [...newestOf];
    const kept = new Set(ranked.slice(0, this.cap).map(([g]) => g));
    const cuts = found.length >= limit ? [Math.min(...found.map((l) => l.tsMs))] : [];
    const nextBefore = readOnFrom(ranked, this.cap, cuts, endMs);

    const guidLines = await linesForGuids(loki, this.selector, guidSpans(newestFirst, kept, REQUEST_SPAN_MS, REQUEST_SPAN_MS), Object.values(ERROR_MSG), 40);
    if (guidLines === null) return none(false, "unreachable");

    let rows = buildErrorRows(guidLines.lines, new UpstreamIndex(routers));
    if (spec) rows = rows.filter((r) => onChain(r, spec));
    if (routerId) rows = router ? rows.filter((r) => ownRow(r, router, routers)) : [];
    if (upstream) rows = rows.filter((r) => r.attempts.some((a) => a.upstream === upstream && a.outcome === "failed"));
    const unread = guidLines.unread.length ? { unread: guidLines.unread.length } : {};
    return { available: true, rows, ...unread, more: nextBefore !== null, nextBefore, range: read };
  }
}
