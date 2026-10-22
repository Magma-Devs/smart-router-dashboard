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
 *   write outcome unknown                     a write no upstream settled: the
 *                                             router can't tell whether it reached
 *                                             a node (`write-unknown`)
 *   [-] failed sending init relay             one of the router's own relays
 *
 * A router on smart-router #543 or later ends each request in one `relay_end`
 * event instead (relay-end.ts), which holds every try: such a request is read
 * from it alone, and found by it too, at any log level. It is listed when a
 * try or the request failed - what the event read finds - so the list does not
 * change with the log level: a hedge nothing failed in is not on it. A request
 * the router couldn't parse, and a subscription request, write the event but
 * never wrote the old lines: neither is listed or counted, as the
 * server-errors alert counts neither.
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
import {
  attemptsOf,
  callFactsOf,
  FAILED_OUTCOMES,
  FAILED_PIPELINE,
  isRelayEnd,
  PARSED_PIPELINE,
  isSubscription,
  methodOf as methodOfEvent,
  parsed,
  RELAY_END,
  retried as retriedEvent,
  startMs,
  WRONG_OUTCOMES,
} from "./relay-end.js";
import { LOG_READ_BUDGET_BYTES, readEnd, readOnFrom, readStart, type ReadRange } from "./read-range.js";
import type { LokiClient } from "./loki-client.js";
import type { PrometheusClient } from "./prometheus-client.js";
import type { ConfigurationService } from "./configuration.js";
import {
  chainOf,
  END_MSG,
  escapeRe,
  inRawString,
  LABEL_TOKEN,
  lastWhere,
  listenerPattern,
  linesForGuids,
  linesOfLookup,
  LOOKUP_ID,
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
  writeUnknown: END_MSG.writeUnknown,
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

const FAILED_SET: ReadonlySet<string> = new Set(FAILED_OUTCOMES);

export { LOOKUP_ID } from "./router-log.js";

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
    const event = lastWhere(ordered, isRelayEnd);
    if (event) {
      const row = rowOfEvent(event, guid, index, every);
      if (row) rows.push(row);
      continue;
    }
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
    // The router's own verdict on a write: "status unclear", whatever else it wrote.
    if (ordered.some((l) => l.message === ERROR_MSG.writeUnknown)) result = "write-unknown";
    else if (!finished) result = gaveUp ? "failed" : "unknown";
    else if (routerError || str(finished.f.has_reply) === "false") result = "failed";
    else if (replied?.outcome === "failed") result = "error-reply";

    const decidedRetry = ordered.some((l) => l.message === ERROR_MSG.decide && str(l.f.action) === "retry");
    // An answer with nothing failed on the way isn't a recovery.
    if (result === "recovered" && !attempts.some((a) => a.outcome === "failed")) result = "ok";
    // Nothing went wrong after all: every "failure" was a try called off.
    if (!every && !attempts.some((a) => a.outcome === "failed") && result !== "failed" && result !== "write-unknown" && !decidedRetry) continue;

    const sentBatches = new Set(attempts.filter((a) => a.outcome !== "skipped").map((a) => a.batch));
    const end = finished ?? gaveUp;
    rows.push({
      guid,
      time: Math.round(t0),
      ...chainOf(ordered, namesOf(ordered, attempts), index),
      method: methodOf(received, ordered),
      attempts,
      result,
      resolvedBy: result === "failed" || result === "write-unknown" ? null : str(finished?.f.served_by) || null,
      retried: sentBatches.size > 1,
      stopReason: str(finished?.f.stop_reason) || null,
      exhausted:
        str(finished?.f.stop_reason) === "AllProvidersExhausted" ||
        ordered.some((l) => l.message.startsWith(ERROR_MSG.exhausted)),
      totalMs: end ? Math.round(end.tsMs - t0) : null,
      error: result === "failed" || result === "write-unknown" ? scrubUrls(routerError || "no upstream replied") : null,
      errorCode: null,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/** A request's row from its `relay_end` alone; null when the list leaves it out. */
function rowOfEvent(e: RouterLine, guid: string, index: UpstreamIndex, every: boolean): ErrorRequestRow | null {
  if (!every && (!parsed(e) || isSubscription(e))) return null;
  const attempts = attemptsOf(e);
  const outcome = str(e.f.outcome);
  let result: ErrorRequestRow["result"] = "unknown"; // an outcome schema 1 doesn't have
  // A write no upstream settled: the Transactions tab's `unknown`. Still a
  // server error - the Failed requests card counts it, as the alert does.
  if (outcome === "write_unknown") result = "write-unknown";
  else if (FAILED_SET.has(outcome)) result = "failed";
  else if (outcome === "node_error") result = "error-reply";
  else if (outcome === "ok") result = attempts.some((a) => a.outcome === "failed") ? "recovered" : "ok";
  // Listed by what its finder reads - a failed try or request - so the list
  // does not change with the router's log level.
  if (!every && !attempts.some((a) => a.outcome === "failed") && !FAILED_SET.has(outcome)) return null;

  const chain = str(e.f.chain);
  const latency = typeof e.f.latency_ms === "number" ? Math.round(e.f.latency_ms) : null;
  const stopReason = str(e.f.stop_reason) || null;
  return {
    guid,
    time: Math.round(startMs(e)),
    ...(chain ? { spec: chain } : chainOf([e], attempts.map((a) => a.upstream), index)),
    method: methodOfEvent(e),
    attempts,
    result,
    resolvedBy: result === "failed" || result === "write-unknown" ? null : str(e.f.served_by) || null,
    retried: retriedEvent(e),
    stopReason,
    exhausted: stopReason === "AllProvidersExhausted",
    totalMs: latency,
    error: FAILED_SET.has(outcome) ? scrubUrls(withoutGuid(str(e.f.error)) || "no upstream replied") : null,
    errorCode: str(e.f.error_code) || null,
    ...callFactsOf(e),
  };
}

/**
 * The lines the router writes, one per client request it could not serve:
 * nothing came back (`noAnswer`) or nothing usable did (`gaveUp`). A request
 * writes one or the other, never both. Other lines quote them in their error
 * field, so each is matched as the `message`, not anywhere in the line. A
 * write whose outcome is unknown after a partial reply is in neither. A router
 * on #543 writes neither: its failed requests are `relay_end` events.
 */
export const GAVE_UP = `failed (getting|processing) responses from RPC endpoints`;

/** How long a failed-request count is kept before Loki is asked again - a failed read too. */
export const COUNT_TTL_MS = 30_000;

/** Counts kept at most: one per window, chain and router in use. */
const COUNT_KEEP = 256;

/**
 * The same counts, recorded once a minute by the fleet Loki's ruler into the
 * tenant's org in the metrics store (devops-magmadevs,
 * components/smart-router-fleet-loki/configs/recording-rules.yaml): one
 * sample a minute per `cluster`, `chain` (the router's network, lower case:
 * the spec lower-cased) and `service_name` (`<tenant>-<router id>`). The
 * failures are the server-errors alert's count: the `relay_end` leg is
 * FAILED_PIPELINE exactly, and the older lines' leg (a final line with an
 * error, or no result or reply) counted 1,305 where GAVE_UP counted 1,299 over
 * the same 15 minutes on the largest tenant (2026-10-20). Reading them costs
 * the same at a month as at five minutes; reading the logs costs the window.
 */
export const RECORDED_OUTCOMES = {
  requests: "smartrouter_final_requests:count1m",
  failures: "smartrouter_final_failures:count1m",
} as const;

/** The newest recorded count may be this old before the counts are read from the logs instead. */
const RECORDED_STALE_SEC = 300;

/** How long one look at the recorded counts' age and history is trusted. */
const RECORDED_PROBE_MS = 60_000;

/** The recorded counts' history is read on an hourly grid, so it is known to within an hour. */
const HISTORY_GRID_SEC = 3600;

interface RecordedState {
  fresh: boolean;
  /** Seconds from the oldest recorded count to now; null when unknown. */
  historySec: number | null;
}

const unavailable = <R extends string>(reason: R) => ({ available: false as const, reason });

export class ErrorRequestsService {
  constructor(
    private readonly loki: LokiClient | null,
    private readonly selector: string,
    private readonly configSvc?: ConfigurationService,
    private readonly cap: number = ERROR_READ_CAP,
    /** The metrics store holding RECORDED_OUTCOMES; null reads the count from the logs. */
    private readonly prom: Pick<PrometheusClient, "scalar"> | null = null,
  ) {}

  private routers(): RouterTopology[] {
    return this.configSvc?.getRouters() ?? [];
  }

  private probed: { at: number; state: Promise<RecordedState> } | null = null;

  /**
   * Whether the recorded counts are there and fresh, and how far back they
   * reach - looked at once a minute at most. They exist only where the fleet
   * Loki's ruler records them (not in compose, not on a store whose deployment
   * scope label they don't carry), and only from the day it started.
   */
  private recordedState(): Promise<RecordedState> {
    const prom = this.prom;
    if (!prom) return Promise.resolve({ fresh: false, historySec: null });
    if (this.probed && Date.now() - this.probed.at < RECORDED_PROBE_MS) return this.probed.state;
    const requests = RECORDED_OUTCOMES.requests;
    const state = Promise.all([
      prom.scalar(`time() - max(timestamp(${requests}))`).catch(() => null),
      prom.scalar(`time() - min(min_over_time(timestamp(${requests})[30d:1h]))`).catch(() => null),
    ]).then(([ageSec, historySec]) => ({
      fresh: ageSec !== null && ageSec <= RECORDED_STALE_SEC,
      historySec: historySec !== null && Number.isFinite(historySec) ? historySec : null,
    }));
    this.probed = { at: Date.now(), state };
    return state;
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
   * How many client requests the router could not serve in `window`.
   * Prometheus can't give this number: the router's request counters move
   * once per ATTEMPT (and count its own relays), and its one per-request
   * series, the end-to-end latency histogram, is only observed when a request
   * succeeds. So it is the router's logs, read one of two ways:
   *
   * - The recorded counts (RECORDED_OUTCOMES), at any window, when they are
   *   fresh. They carry the router, so a router on a chain others serve too
   *   has its own count. Older than the window: `since` says where they start.
   * - Otherwise the lines themselves, counted by Loki: one GAVE_UP line or one
   *   failed `relay_end` (FAILED_PIPELINE) per request - #543 writes no
   *   GAVE_UP line. Only while the window fits LOG_READ_BUDGET_BYTES: a count
   *   reads the whole window at once, and a heavier one answers `too-large`.
   *   The lines don't say which router wrote them, so a router sharing its
   *   chain answers `shared-chain`.
   *
   * Kept COUNT_TTL_MS per window, chain and router, one read in flight per key.
   */
  async failedCount(window: MetricWindow, spec?: string, routerId?: string): Promise<FailedRequests> {
    if (spec != null && !LABEL_TOKEN.test(spec)) return { available: true, value: 0 };
    const routers = this.routers();
    let chain = spec;
    let router: RouterTopology | undefined;
    if (routerId) {
      router = routers.find((r) => r.id === routerId);
      if (!router || (spec != null && spec !== router.spec)) return { available: true, value: 0 };
      chain = router.spec;
    }
    // A chain the values file doesn't serve has no listener to log it.
    if (chain != null && routers.length && !routers.some((r) => r.spec === chain)) return { available: true, value: 0 };

    const key = `${window}|${chain ?? ""}|${router?.id ?? ""}`;
    const kept = this.counted.get(key);
    if (kept && Date.now() - kept.at < COUNT_TTL_MS) return kept.result;
    const pending = this.counting.get(key);
    if (pending) return pending;

    const read = this.countFailed(WINDOWS[window].rangeSeconds, chain, router, routers)
      .then((result) => {
        this.keep(key, result);
        return result;
      })
      .finally(() => this.counting.delete(key));
    this.counting.set(key, read);
    return read;
  }

  private async countFailed(seconds: number, chain: string | undefined, router: RouterTopology | undefined, routers: RouterTopology[]): Promise<FailedRequests> {
    const recorded = await this.recordedState();
    if (recorded.fresh && this.prom) return this.countRecorded(this.prom, seconds, recorded.historySec, chain, router, routers);

    const loki = this.loki;
    if (!loki) return { ...unavailable("unconfigured"), value: null };
    if (router && routers.some((r) => r.id !== router.id && r.spec === router.spec)) return { ...unavailable("shared-chain"), value: null };
    const now = Date.now();
    const bytes = await loki.volume(this.selector, now - seconds * 1000, now);
    if (bytes === null) return { ...unavailable("unreachable"), value: null };
    if (bytes > LOG_READ_BUDGET_BYTES) return { ...unavailable("too-large"), value: null };

    const r = `${seconds}s`;
    const byChain = chain ? ` | ep=~\`${escapeRe(chain)}(jsonrpc|rest|tendermintrpc|grpc)\`` : "";
    const eventChain = chain ? ` |= \`"chain":"${chain}"\`` : "";
    // Each leg summed on its own, then added: `or vector(0)` keeps a leg with
    // no lines from emptying the total.
    const lines = `sum(count_over_time(${this.selector} |~ \`${GAVE_UP}\` | json msg="message", ep="endpoint" | msg=~\`${GAVE_UP}\`${byChain} [${r}]))`;
    const events = `sum(count_over_time(${this.selector}${eventChain} ${FAILED_PIPELINE} [${r}]))`;
    const value = await loki.count(`(${lines} or vector(0)) + (${events} or vector(0))`);
    return value === null ? { ...unavailable("unreachable"), value: null } : { available: true, value };
  }

  private async countRecorded(
    prom: Pick<PrometheusClient, "scalar">,
    seconds: number,
    historySec: number | null,
    chain: string | undefined,
    router: RouterTopology | undefined,
    routers: RouterTopology[],
  ): Promise<FailedRequests> {
    const matchers: string[] = [];
    if (chain) matchers.push(`chain="${chain.toLowerCase()}"`);
    if (router) {
      // `service_name` is `<tenant>-<router id>`, and the tenant isn't known
      // here: the id is matched as its end. Another router of the chain whose
      // id ends in this one's would be counted with it - so then it isn't split.
      const id = router.id;
      if (!LABEL_TOKEN.test(id) || routers.some((r) => r.id !== id && r.spec === router.spec && r.id.endsWith(`-${id}`))) {
        return { ...unavailable("shared-chain"), value: null };
      }
      matchers.push(`service_name=~".+-${id}"`);
    }
    // `or vector(0)`: an answer always has a sample, so none means the store didn't answer.
    const value = await prom
      .scalar(`sum(sum_over_time(${RECORDED_OUTCOMES.failures}{${matchers.join(", ")}}[${seconds}s])) or vector(0)`)
      .catch(() => null);
    if (value === null) return { ...unavailable("unreachable"), value: null };
    const short = historySec !== null && historySec + HISTORY_GRID_SEC < seconds;
    return {
      available: true,
      value: Math.round(value),
      ...(short ? { since: new Date(Date.now() - historySec * 1000).toISOString() } : {}),
    };
  }

  /**
   * One request by its ID, its transaction hash or the caller's request id,
   * whatever happened to it: every line the router wrote for it, as the same
   * row the list shows. A value several requests carry answers with the
   * newest and how many there are. A request ID that carries its second
   * (v1.6.1 on) is read in its own minutes first; any other value reads every
   * line in `range` - a month is a heavy read, so the caller widens the range
   * on purpose rather than by default (`linesOfLookup`).
   */
  async lookup(id: string, range: ReadRange): Promise<RequestLookup> {
    const loki = this.loki;
    if (!loki) return { ...unavailable("unconfigured"), row: null };
    if (!LOOKUP_ID.test(id)) return { available: true, row: null };
    const lines = await linesOfLookup(loki, this.selector, id, range);
    if (lines === null) return { ...unavailable("unreachable"), row: null };
    const rows = buildErrorRows(lines, new UpstreamIndex(this.routers()), true);
    return { available: true, row: rows[0] ?? null, ...(rows.length > 1 ? { matches: rows.length } : {}) };
  }

  /**
   * The newest requests with an error in `range`, ending at `before` when
   * given (the previous read's `nextBefore`). A request whose lines straddle
   * two reads can come back in both; the client keeps it once, by GUID.
   * `upstream` keeps the requests whose try at that upstream failed - what
   * an errors-over-time bar counts - and narrows the read to it, so the cap
   * applies to what was asked for. One read scans at most
   * LOG_READ_BUDGET_BYTES of logs (`readStart`): on a busy deployment a long
   * range is read in parts, newest first, one per "Load older".
   */
  async report(range: ReadRange, spec?: string, routerId?: string, before?: number, upstream?: string): Promise<ErrorRequestsReport> {
    const read = { startMs: range.startMs, endMs: range.endMs };
    const none = (available: boolean, reason?: LogUnavailable): ErrorRequestsReport =>
      ({ available, ...(reason ? { reason } : { range: read }), rows: [], more: false, nextBefore: null });
    const loki = this.loki;
    if (!loki) return none(false, "unconfigured");
    const endMs = readEnd(range, before);
    if (endMs <= range.startMs) return none(true);
    const startMs = await readStart(loki, this.selector, range, endMs);
    // The part of the range older than this read is the next one's.
    const unreadCut = startMs > range.startMs ? [startMs] : [];

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
    // A relay_end is one line per request and names its chain and its tries' upstreams.
    const eventNarrow = upstream
      ? inRawString(upstream) ? ` |= \`"upstream":"${upstream}"\`` : ""
      : chain && LABEL_TOKEN.test(chain) ? ` |= \`"chain":"${chain}"\`` : "";
    const limit = this.cap * 4;
    const [found, events] = await Promise.all([
      loki.queryRange(
        `${this.selector} |~ \`${FOUND_BY.map(escapeRe).join("|")}\` !~ \`PROTOCOL_CONTEXT_CANCELED|context canceled\`${narrow}`,
        startMs,
        endMs,
        limit,
        "backward",
      ),
      loki.queryRange(
        `${this.selector} |= \`${RELAY_END}\` != \`"selection":"subscription"\` |~ \`"outcome":"(${WRONG_OUTCOMES.join("|")})"\`${eventNarrow} ${PARSED_PIPELINE}`,
        startMs,
        endMs,
        this.cap,
        "backward",
      ),
    ]);
    if (found === null || events === null) return none(false, "unreachable");

    const newestFirst = parseAll([...found, ...events]).sort((a, b) => b.tsMs - a.tsMs);
    const newestOf = new Map<string, number>();
    for (const l of newestFirst) if (!newestOf.has(l.guid)) newestOf.set(l.guid, l.tsMs);
    if (!newestOf.size) {
      return unreadCut.length
        ? { available: true, rows: [], more: true, nextBefore: readOnFrom([], this.cap, unreadCut, endMs), range: read }
        : none(true);
    }
    const ranked = [...newestOf];
    const kept = new Set(ranked.slice(0, this.cap).map(([g]) => g));
    const cutOf = (read: { tsMs: number }[], cap: number) => (read.length >= cap ? [Math.min(...read.map((l) => l.tsMs))] : []);
    const nextBefore = readOnFrom(ranked, this.cap, [...cutOf(found, limit), ...cutOf(events, this.cap), ...unreadCut], endMs);

    // A request found by its relay_end needs nothing more; one found by its
    // lines needs the rest of them - and its relay_end, when it has one.
    const ends = newestFirst.filter((l) => isRelayEnd(l) && kept.has(l.guid));
    const inHand = new Set(ends.map((l) => l.guid));
    const toRead = [...kept].filter((g) => !inHand.has(g));
    const reading = new Set(toRead);
    const toReadTimes = newestFirst.filter((l) => reading.has(l.guid)).map((l) => l.tsMs);
    const guidLines = toRead.length
      ? await linesForGuids(
          loki,
          this.selector,
          toRead,
          Math.min(...toReadTimes) - REQUEST_SPAN_MS,
          [...Object.values(ERROR_MSG), RELAY_END],
          40,
          Math.min(Date.now(), Math.max(...toReadTimes) + REQUEST_SPAN_MS),
        )
      : { lines: [], unread: [] };
    if (guidLines === null) return none(false, "unreachable");

    let rows = buildErrorRows([...guidLines.lines, ...ends], new UpstreamIndex(routers));
    if (spec) rows = rows.filter((r) => onChain(r, spec));
    if (routerId) rows = router ? rows.filter((r) => ownRow(r, router, routers)) : [];
    if (upstream) rows = rows.filter((r) => r.attempts.some((a) => a.upstream === upstream && a.outcome === "failed"));
    const unread = guidLines.unread.length ? { unread: guidLines.unread.length } : {};
    return { available: true, rows, ...unread, more: nextBefore !== null, nextBefore, range: read };
  }
}
