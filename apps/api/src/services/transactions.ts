/**
 * Transactions tab - rebuilt from the router's own log lines (Loki), because
 * Prometheus holds totals, never one request. The lines it reads, per GUID:
 *
 *   Consumer received a new …          when, and the method (JSON-RPC body or
 *                                      REST path). Tendermint RPC writes none.
 *   Choosing providers                 `stateful:"1"` = the spec calls it a
 *                                      write; `chosenProviders` = where it went
 *   received node error reply from …,  one per upstream that answered with an
 *   Relay received a node error        error: `error_name`, `chain_error_message`
 *                                      (1.5.x routers write only the second)
 *   could not send relay to provider,  the router got no usable reply -
 *   failed relay, insufficient results `error_name` says why
 *   relay finished                     `served_by` = whose reply the client got;
 *                                      `error` = a failure of the router's own
 *   failed getting responses from …    nothing came back; no "relay finished"
 *   write outcome unknown              the router can't tell whether the write
 *                                      reached a node
 *
 * What each upstream answered comes from the per-try lines `triesOf` reads
 * (router-log.ts) - the same ones the Errors tab's request list shows.
 *
 * The counters can't do this job: a rejected transaction counts as a success
 * on `requests_success_total` (the router got a reply), and node errors on a
 * broadcast are not counted per upstream at all.
 */
import type { LogUnavailable, RouterTopology, TransactionLookup, TransactionsReport, TxLogRow, TxOutcome } from "@sr/shared";
import { readEnd, readOnFrom, type ReadRange } from "./read-range.js";
import type { LokiClient } from "./loki-client.js";
import type { ConfigurationService } from "./configuration.js";
import {
  chainOf,
  END_MSG,
  escapeRe,
  inRawString,
  linesForGuids,
  linesOfRequest,
  REQUEST_ID,
  methodOf,
  namesOf,
  onChain,
  ownRow,
  parseAll,
  providerOf,
  scrubUrls,
  str,
  TRY_MSG,
  triesOf,
  UpstreamIndex,
  withoutGuid,
  type RouterLine,
} from "./router-log.js";

export const MSG = {
  received: "Consumer received a new",
  ...TRY_MSG,
  noResults: "failed relay, insufficient results",
  finished: "relay finished",
  noAnswer: END_MSG.noAnswer,
  writeUnknown: END_MSG.writeUnknown,
} as const;

/**
 * Methods that submit a transaction, found by name as well as by the spec's
 * `stateful` flag: not every spec sets it - HYPERLIQUID's
 * `eth_sendRawTransaction` logs `stateful:"0"`.
 */
export const TX_METHODS = [
  "eth_sendRawTransaction",
  "eth_sendTransaction",
  "sendTransaction",
  "sendrawtransaction",
  "broadcast_tx_sync",
  "broadcast_tx_async",
  "broadcast_tx_commit",
] as const;
const TX_METHOD_SET: ReadonlySet<string> = new Set(TX_METHODS);

/**
 * Where a refused transaction still gets a normal reply, with the refusal as
 * a code inside it: Cosmos SDK chains (CheckTx `code`, over Tendermint RPC,
 * gRPC and this REST path). The router doesn't log replies, so without a node
 * error line the outcome can't be told.
 */
const REPLY_DECIDES_INTERFACES: ReadonlySet<string> = new Set(["tendermintrpc", "grpc"]);
const REPLY_DECIDES_PATH = "/cosmos/tx/v1beta1/txs";

export const NOTE = {
  noEnd: "The logs show no end. It may still be in flight, or some of its log lines are missing.",
  replyNotLogged:
    "The node replied, but on this chain a refused transaction also gets a normal reply. The router doesn't log what the reply said, so the dashboard can't tell.",
  writeUnknown:
    "No upstream gave a definite answer, so the router can't tell whether the transaction reached a node. Check the chain before sending it again.",
} as const;

/** Transactions one read returns; `more` says when the range holds older ones. */
export const TX_READ_CAP = 500;

/** A transaction's reply can land this long after the line that found it. */
const REPLY_SPAN_MS = 60_000;

/**
 * One row per transaction - a request the spec marks `stateful:"1"`, or one
 * calling a transaction method - newest first. `index` resolves a request's
 * chain from the mounted config when no line names it.
 */
export function buildTxRows(lines: RouterLine[], index: UpstreamIndex): TxLogRow[] {
  const byGuid = new Map<string, RouterLine[]>();
  for (const l of lines) byGuid.set(l.guid, [...(byGuid.get(l.guid) ?? []), l]);

  const rows: TxLogRow[] = [];
  for (const [guid, unordered] of byGuid) {
    // Time order, not arrival order: each log level can be its own stream.
    const group = [...unordered].sort((a, b) => a.tsMs - b.tsMs);
    const choosing = group.find((l) => l.message === MSG.choosing);
    const received = group.find((l) => l.message.startsWith(MSG.received));
    const method = methodOf(received);
    // No "Choosing providers" when no upstream could be chosen: the method alone makes it a transaction.
    if (!(str(choosing?.f.stateful) === "1" || TX_METHOD_SET.has(method))) continue;

    const finished = group.find((l) => l.message === MSG.finished);
    const noAnswer = group.find((l) => l.message === MSG.noAnswer);
    const writeUnknown = group.some((l) => l.message === MSG.writeUnknown);
    const nodeErrors = group.filter((l) => l.message === MSG.nodeErrorReply || l.message === MSG.nodeError);
    const relayErrors = group.filter(
      (l) => (l.message === MSG.sendFailed || l.message === MSG.noResults) && str(l.f.error_name),
    );
    const start = (received ?? choosing)!;
    const attempts = triesOf(group, start.tsMs, finished);
    const sentTo = [...new Set(attempts.map((a) => a.upstream))];
    const answeredBy = finished ? str(finished.f.served_by) || null : null;
    const chain = chainOf(group, namesOf(group, attempts), index);
    const chains = chain.spec ? [chain.spec] : (chain.specs ?? []);
    const interfaces = sentTo.flatMap((u) => chains.flatMap((s) => index.info(s, u)?.interfaces ?? []));

    // The client got the answering upstream's reply; with a single upstream,
    // its error line is that reply.
    const replyError =
      nodeErrors.find((l) => providerOf(l.f.provider) === answeredBy) ??
      (sentTo.length === 1 ? nodeErrors[0] : undefined);
    const routerError = withoutGuid(str((finished ?? noAnswer)?.f.error));
    const replyDecides = method === REPLY_DECIDES_PATH || interfaces.some((i) => REPLY_DECIDES_INTERFACES.has(i));

    let outcome: TxOutcome = "accepted";
    let error: TxLogRow["error"] = null;
    let note: string | null = null;
    if (writeUnknown) {
      // The router's own verdict: it answered the client "status unclear".
      outcome = "unknown";
      note = NOTE.writeUnknown;
    } else if (!finished && !noAnswer) {
      outcome = "unknown";
      note = NOTE.noEnd;
    } else if (!finished || routerError || str(finished.f.has_reply) === "false") {
      outcome = "failed";
      error = {
        code: str(relayErrors[0]?.f.error_name) || "NO_REPLY",
        message: scrubUrls(routerError || "no upstream replied"),
      };
    } else if (replyError) {
      outcome = "rejected";
      error = {
        code: str(replyError.f.error_name) || "NODE_ERROR",
        message: scrubUrls(str(replyError.f.chain_error_message) || str(replyError.f.error) || str(replyError.f.Error)),
      };
    } else if (replyDecides) {
      outcome = "unknown";
      note = NOTE.replyNotLogged;
      // It replied, but not "accepted": the reply is where the verdict is.
      const served = attempts.find((a) => a.replied && a.outcome === "ok");
      if (served) {
        served.outcome = "no-result";
        served.note = "Responded; the response body isn't in the logs.";
      }
    }

    const end = finished ?? noAnswer;
    rows.push({
      guid,
      time: Math.round(start.tsMs),
      ...chain,
      method,
      attempts,
      answeredBy,
      replyMs: end ? Math.round(end.tsMs - start.tsMs) : null,
      outcome,
      error,
      note,
    });
  }
  return rows.sort((a, b) => b.time - a.time);
}

/** Totals and success rate over the rows. `unknown` rows are counted in
 *  `total` but left out of the rate: their end can't be told. */
export function summarize(
  rows: TxLogRow[],
): Pick<TransactionsReport, "total" | "accepted" | "rejected" | "failed" | "successRate"> {
  const count = (o: TxOutcome) => rows.filter((r) => r.outcome === o).length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  const failed = count("failed");
  const decided = accepted + rejected + failed;
  return {
    total: rows.length,
    accepted,
    rejected,
    failed,
    successRate: decided > 0 ? accepted / decided : null,
  };
}

function emptyReport(available: boolean, reason?: LogUnavailable): TransactionsReport {
  return { available, ...(reason ? { reason } : {}), total: 0, accepted: 0, rejected: 0, failed: 0, successRate: null, rows: [], more: false, nextBefore: null };
}

export class TransactionsService {
  constructor(
    private readonly loki: LokiClient | null,
    private readonly selector: string,
    private readonly configSvc?: ConfigurationService,
    private readonly cap: number = TX_READ_CAP,
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

  /**
   * One transaction by its request ID: every line the router wrote for it in
   * `range`, as the same row the log shows. `found` without a row: the ID is
   * a request that isn't a transaction.
   */
  async lookup(guid: string, range: ReadRange): Promise<TransactionLookup> {
    const loki = this.loki;
    if (!loki) return { available: false, reason: "unconfigured", found: false, row: null };
    if (!REQUEST_ID.test(guid)) return { available: true, found: false, row: null };
    const lines = await linesOfRequest(loki, this.selector, guid, range.startMs, range.endMs);
    if (lines === null) return { available: false, reason: "unreachable", found: false, row: null };
    const row = buildTxRows(lines, new UpstreamIndex(this.routers()))[0] ?? null;
    return { available: true, found: lines.length > 0, row };
  }

  /**
   * The newest transactions in `range`, ending at `before` when given (the
   * previous read's `nextBefore`). One on the seam between two reads can come
   * back in both; the client keeps it once, by GUID.
   */
  async report(range: ReadRange, spec?: string, routerId?: string, before?: number): Promise<TransactionsReport> {
    const loki = this.loki;
    if (!loki) return emptyReport(false, "unconfigured");
    const read = { startMs: range.startMs, endMs: range.endMs };
    const startMs = range.startMs;
    const endMs = readEnd(range, before);
    if (endMs <= startMs) return { ...emptyReport(true), range: read };

    // Candidates, two ways. Writes by the spec: narrowed inside the query to
    // the chain's upstreams (a name inside `chosenProviders`, bounded by a
    // comma or the quote), so the cap applies to the chain asked for. And
    // transaction methods by name - those lines name no upstream, so they
    // are narrowed after the rows are built.
    const names = this.upstreamsFor(spec, routerId);
    const safe = names?.filter(inRawString);
    const narrow = safe?.length
      ? ` |~ \`"chosenProviders":"([^"]*,)?(${safe.map(escapeRe).join("|")})[,"]\``
      : "";
    const [byFlag, byMethod] = await Promise.all([
      loki.queryRange(`${this.selector} |= "${MSG.choosing}" |= \`"stateful":"1"\`${narrow}`, startMs, endMs, this.cap, "backward"),
      loki.queryRange(`${this.selector} |= "${MSG.received}" |~ \`(${TX_METHODS.join("|")})\``, startMs, endMs, this.cap, "backward"),
    ]);
    if (byFlag === null || byMethod === null) return emptyReport(false, "unreachable");

    const found = parseAll([...byFlag, ...byMethod]);
    const newest = new Map<string, number>();
    for (const l of found) newest.set(l.guid, Math.max(newest.get(l.guid) ?? 0, l.tsMs));
    const ranked = [...newest].sort((a, b) => b[1] - a[1]);
    const picked = ranked.slice(0, this.cap);
    if (!picked.length) return { ...emptyReport(true), range: read };
    const kept = new Set(picked.map(([g]) => g));
    const keptTimes = found.filter((l) => kept.has(l.guid)).map((l) => l.tsMs);
    const cutOf = (read: { tsMs: number }[]) => (read.length >= this.cap ? [Math.min(...read.map((l) => l.tsMs))] : []);
    const nextBefore = readOnFrom(ranked, this.cap, [...cutOf(byFlag), ...cutOf(byMethod)], endMs);

    // Every line of those requests. The received line comes a few ms before
    // the choice, and the reply can land after the range closed.
    const guidLines = await linesForGuids(
      loki,
      this.selector,
      [...kept],
      Math.min(...keptTimes) - 5_000,
      Object.values(MSG),
      30,
      Math.min(Date.now(), Math.max(...keptTimes) + REPLY_SPAN_MS),
    );
    if (guidLines === null) return emptyReport(false, "unreachable");

    const routers = this.routers();
    let rows = buildTxRows(guidLines.lines, new UpstreamIndex(routers));
    if (spec) rows = rows.filter((r) => onChain(r, spec));
    if (routerId) {
      const router = routers.find((r) => r.id === routerId);
      rows = router ? rows.filter((r) => ownRow(r, router, routers)) : [];
    }
    const unread = guidLines.unread.length ? { unread: guidLines.unread.length } : {};
    return { available: true, ...summarize(rows), rows, ...unread, more: nextBefore !== null, nextBefore, range: read };
  }
}
