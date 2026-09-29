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
 *
 * What each upstream answered comes from the per-try lines `triesOf` reads
 * (router-log.ts) - the same ones the Errors tab's request list shows.
 *
 * The counters can't do this job: a rejected transaction counts as a success
 * on `requests_success_total` (the router got a reply), and node errors on a
 * broadcast are not counted per upstream at all. See `router-log.ts` for how
 * the lines are read.
 */
import type { RouterTopology, TransactionLookup, TransactionsReport, TxLogRow, TxOutcome } from "@sr/shared";
import { readEnd, type ReadRange } from "./read-range.js";
import type { LokiClient } from "./loki-client.js";
import type { ConfigurationService } from "./configuration.js";
import {
  escapeRe,
  inRawString,
  linesForGuids,
  linesOfRequest,
  REQUEST_ID,
  methodOf,
  parseAll,
  providerOf,
  scrubUrls,
  str,
  TRY_MSG,
  triesOf,
  upstreamIndex,
  withoutGuid,
  type RouterLine,
  type UpstreamInfo,
} from "./router-log.js";

export const MSG = {
  received: "Consumer received a new",
  ...TRY_MSG,
  noResults: "failed relay, insufficient results",
  finished: "relay finished",
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
} as const;

/** Transactions one read returns; `more` says when the range holds older ones. */
export const TX_READ_CAP = 500;

/** A transaction's reply can land this long after the line that found it. */
const REPLY_SPAN_MS = 60_000;

/**
 * One row per transaction - a request the spec marks `stateful:"1"`, or one
 * calling a transaction method - newest first. `lookup` resolves an upstream
 * from the mounted config: the lines name the chain only on an error.
 */
export function buildTxRows(
  lines: RouterLine[],
  lookup: (upstream: string) => UpstreamInfo | null,
): TxLogRow[] {
  const byGuid = new Map<string, RouterLine[]>();
  for (const l of lines) byGuid.set(l.guid, [...(byGuid.get(l.guid) ?? []), l]);

  const rows: TxLogRow[] = [];
  for (const [guid, unordered] of byGuid) {
    // Time order, not arrival order: each log level is its own stream.
    const group = [...unordered].sort((a, b) => a.tsMs - b.tsMs);
    const choosing = group.find((l) => l.message === MSG.choosing);
    const received = group.find((l) => l.message.startsWith(MSG.received));
    const method = methodOf(received);
    if (!choosing || !(str(choosing.f.stateful) === "1" || TX_METHOD_SET.has(method))) continue;

    const finished = group.find((l) => l.message === MSG.finished);
    const nodeErrors = group.filter((l) => l.message === MSG.nodeErrorReply || l.message === MSG.nodeError);
    const relayErrors = group.filter(
      (l) => (l.message === MSG.sendFailed || l.message === MSG.noResults) && str(l.f.error_name),
    );
    const start = received ?? choosing;
    const attempts = triesOf(group, start.tsMs, finished);
    const sentTo = [...new Set(attempts.map((a) => a.upstream))];
    const answeredBy = finished ? str(finished.f.served_by) || null : null;
    const upstreams = sentTo.map(lookup);

    // The client got the answering upstream's reply; with a single upstream,
    // its error line is that reply.
    const replyError =
      nodeErrors.find((l) => providerOf(l.f.provider) === answeredBy) ??
      (sentTo.length === 1 ? nodeErrors[0] : undefined);
    const routerError = finished ? withoutGuid(str(finished.f.error)) : "";
    const replyDecides =
      method === REPLY_DECIDES_PATH ||
      upstreams.some((u) => u?.interfaces.some((i) => REPLY_DECIDES_INTERFACES.has(i)));

    let outcome: TxOutcome = "accepted";
    let error: TxLogRow["error"] = null;
    let note: string | null = null;
    if (!finished) {
      outcome = "unknown";
      note = NOTE.noEnd;
    } else if (routerError || str(finished.f.has_reply) === "false") {
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

    rows.push({
      guid,
      time: Math.round(start.tsMs),
      spec:
        str(nodeErrors[0]?.f.chain_id) ||
        str(relayErrors[0]?.f.chain_id) ||
        upstreams.find((u) => u)?.spec ||
        null,
      method,
      attempts,
      answeredBy,
      replyMs: finished ? Math.round(finished.tsMs - start.tsMs) : null,
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

function emptyReport(available: boolean): TransactionsReport {
  return { available, total: 0, accepted: 0, rejected: 0, failed: 0, successRate: null, rows: [], more: false, nextBefore: null };
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
    if (!loki || !REQUEST_ID.test(guid)) return { available: !!loki, found: false, row: null };
    const lines = await linesOfRequest(loki, this.selector, guid, range.startMs, range.endMs);
    if (lines === null) return { available: false, found: false, row: null };
    const index = upstreamIndex(this.routers());
    return { available: true, found: lines.length > 0, row: buildTxRows(lines, (u) => index.get(u) ?? null)[0] ?? null };
  }

  /**
   * The newest transactions in `range`, ending at `before` when given (the
   * previous read's `nextBefore`). One on the seam between two reads can come
   * back in both; the client keeps it once, by GUID.
   */
  async report(range: ReadRange, spec?: string, routerId?: string, before?: number): Promise<TransactionsReport> {
    const loki = this.loki;
    if (!loki) return emptyReport(false);
    const startMs = range.startMs;
    const endMs = readEnd(range, before);
    if (endMs <= startMs) return emptyReport(true);

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
    if (byFlag === null || byMethod === null) return emptyReport(false);

    const found = parseAll([...byFlag, ...byMethod]);
    const newest = new Map<string, number>();
    for (const l of found) newest.set(l.guid, Math.max(newest.get(l.guid) ?? 0, l.tsMs));
    const picked = [...newest].sort((a, b) => b[1] - a[1]).slice(0, this.cap);
    if (!picked.length) return emptyReport(true);
    const kept = new Set(picked.map(([g]) => g));
    const keptTimes = found.filter((l) => kept.has(l.guid)).map((l) => l.tsMs);
    const oldest = Math.min(...keptTimes);
    const more = byFlag.length >= this.cap || byMethod.length >= this.cap || newest.size > this.cap;

    // Every line of those requests. The received line comes a few ms before
    // the choice, and the reply can land after the range closed.
    const lines = await linesForGuids(
      loki,
      this.selector,
      [...kept],
      oldest - 5_000,
      Object.values(MSG),
      30,
      Math.min(Date.now(), Math.max(...keptTimes) + REPLY_SPAN_MS),
    );
    if (lines === null) return emptyReport(false);

    const index = upstreamIndex(this.routers());
    let rows = buildTxRows(lines, (u) => index.get(u) ?? null);
    if (spec) rows = rows.filter((r) => r.spec === spec);
    if (routerId) {
      const own = new Set(names ?? []);
      rows = rows.filter((r) => r.attempts.some((a) => own.has(a.upstream)));
    }
    // The oldest kept line itself, fraction and all: the next read ends there,
    // so it moves strictly back and skips nothing in that millisecond.
    return { available: true, ...summarize(rows), rows, more, nextBefore: more ? oldest : null };
  }
}
