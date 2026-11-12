"use client";

/* Transaction-log tab - every transaction the router sent, one row each: the
 * chain and method, every upstream it went to and what each answered, whose
 * reply went back, how long that took, and how it ended. Live data:
 * /api/transactions, which rebuilds each transaction from the router's own
 * log lines in Loki - Prometheus holds totals, never one request. Five filters
 * narrow the rows: the result, the customer, the method, the error type and
 * an upstream it went to. A transaction's hash links to the chain's explorer
 * where its transaction page is known. The tab follows the page's
 * window or exact times picked here - the cards too, since they count the
 * list - and "Load older" reads on past one read's cap. Between the cards and
 * the list, the window's transactions over time (TransactionsChart). The chips and
 * details are shared with the Errors tab's request list (request-log.tsx).
 * Value and finality are not here yet: the logs cut long transactions short,
 * and finality needs the chain. */

import { Fragment, useEffect, useMemo, useState } from "react";
import { WINDOWS, explainRouterError, type MetricWindow, type TransactionLookup, type TransactionsReport, type TxLogRow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useLogReads } from "@/hooks/use-log-reads";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Refreshing, SkelLine, SkelRows, SkelValue } from "@/components/gateway/Skel";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Tip } from "@/components/gateway/Tip";
import { TT } from "@/lib/tooltips";
import { fmtComma, fmtPct } from "@/lib/format";
import { linkRequest, requestFromUrl } from "@/lib/request-in-url";
import {
  appGot,
  customerOptions,
  hasCustomer,
  LOOKUP_REFUSED,
  MatchesNote,
  TxHash,
  errorTypeOptions,
  FilterSelect,
  NewRowsStrip,
  useHeldRows,
  TimeColumnHead,
  WhenCell,
  stickyListHeader,
  useListHeadHeight,
  filterSelectStyle,
  Flow,
  fmtTook,
  hasErrorType,
  IdSearch,
  LOG_SKEL_COLS,
  LogStrip,
  LookupFrame,
  NotFound,
  OlderRowsLoading,
  Pager,
  ReadingStrip,
  TimeRangeControl,
  chainWords,
  chainsTitle,
  onRowKey,
  rangeIsLive,
  unreadableWords,
  UnreadStrip,
  type ExactRange,
  ResultCell,
} from "./request-log";
import { TransactionsChart, TX_RESULT } from "./TransactionsChart";
import { RequestBreakdown, type BreakdownProps, type FinalAnswer } from "./request-breakdown";

const PER_PAGE = 25;
const ALL = "all";

/** The filter row's dropdowns: capped, so a long name can't push the row onto two lines. */
const narrowSelect: React.CSSProperties = { ...filterSelectStyle, maxWidth: 200 };

/** The cards' numbers over the rows loaded so far - every read appended, each
 *  transaction once. */
function summarize(rows: TxLogRow[]) {
  const count = (o: TxLogRow["outcome"]) => rows.filter((r) => r.outcome === o).length;
  return { total: rows.length, accepted: count("accepted"), rejected: count("rejected"), failed: count("failed"), failedOnChain: count("failed-on-chain"), unknown: count("unknown") };
}

/** The list's results, as the chart above it draws them. */
const OUTCOME: Record<TxLogRow["outcome"], { label: string; color: string }> = TX_RESULT;

/** A row's result word: the chart's, except where the send reply says the chain ran it (Sui). */
function resultOf(r: TxLogRow): { label: string; color: string } {
  return r.outcome === "accepted" && r.txStatus === "success" ? { label: "Executed", color: "var(--ok)" } : OUTCOME[r.outcome];
}

/** A refusal whose own code says the chain may already have the transaction ("nonce too low", "already known"): that code's entry. */
function mayBeOnChain(r: TxLogRow) {
  if (r.outcome !== "rejected") return null;
  for (const c of [r.error?.code, ...r.attempts.map((a) => a.code)]) {
    const entry = explainRouterError(c);
    if (entry?.mayHaveGoneThrough) return entry;
  }
  return null;
}

/** What the client should do next, under a row's result. */
function nextOf(r: TxLogRow): string | null {
  if (r.outcome === "accepted") return r.txStatus === "success" ? null : "Not confirmed on chain yet.";
  // The error's own next step, in the words the opened row shows.
  if (r.outcome === "rejected") { const entry = mayBeOnChain(r); return entry ? `May already be on chain. ${entry.action || "Check the chain before sending again."}` : null; }
  if (r.outcome === "unknown") return "May have been sent. Look up the hash before signing a new one.";
  if (r.outcome === "failed") return "Nothing reached a provider, so it didn't go through.";
  return null;
}
const OUTCOME_ORDER: TxLogRow["outcome"][] = ["accepted", "rejected", "failed-on-chain", "failed", "unknown"];

/** Every upstream's answer in full, when a row is opened. A rejection is the
 *  answering upstream's own error, so it shows on that upstream's line. */
/** The response's status for a transaction: the word, its colour, and a detail where the code doesn't carry one. */
export function txStatusOf(r: TxLogRow): BreakdownProps["status"] {
  const { label, color } = resultOf(r);
  // A refusal that may be on chain says so in its own chip and next step below.
  return { label, color: r.outcome === "unknown" ? "var(--text-3)" : color, detail: r.outcome === "rejected" ? null : nextOf(r) };
}

/** What each result means, on hover over its tag. */
const OUTCOME_HINT: Record<TxLogRow["outcome"], string> = {
  accepted: "A provider took the transaction. It is not confirmed on chain: the provider can still drop or replace it, and the dashboard can't see whether it reaches a block. Open the hash on the explorer to check.",
  rejected: "A provider refused this send, for example nonce too low or insufficient funds. Usually a problem with the transaction itself. It doesn't prove the transaction isn't on chain: nonce too low can mean it already is.",
  "failed-on-chain": "The chain ran the transaction and it failed.",
  failed: "The router refused it before sending it to any provider, so nothing reached the chain.",
  unknown: "The dashboard can't tell whether the transaction went out: a provider may have received it and passed it on.",
}

/** An opened row: the transaction, every provider it went to, and the response to the client, in plain words. */
function Details({ row }: { row: TxLogRow }) {
  const replied = row.attempts.find((a) => a.replied);
  const final: FinalAnswer =
    row.outcome === "failed" || (row.outcome === "unknown" && row.error && !replied) ? { from: "router", code: row.error?.code ?? null }
      : replied ? { from: "provider", attempt: replied, code: row.error?.code ?? null }
        : null;
  const extra: { label: string; value: React.ReactNode }[] = [];
  if (row.outcome === "failed-on-chain" && row.txError) extra.push({ label: "Chain error", value: <span className="gw-mono" style={{ wordBreak: "break-word" }}>{row.txError}</span> });
  if (row.note) extra.push({ label: "Note", value: row.note });
  if (row.txHash) extra.push({ label: "Hash", value: <TxHash hash={row.txHash} spec={row.spec} full /> });
  return (
    <RequestBreakdown spec={row.spec} chain={chainWords(row)} chainTitle={chainsTitle(row)} method={row.method === "unknown" ? "method not in the logs" : row.method}
      time={row.time} guid={row.guid} tookMs={row.replyMs} facts={row} attempts={row.attempts}
      final={final} status={txStatusOf(row)} isWrite extra={extra} />
  );
}

/** One transaction looked up by its request ID - the same row the log shows, opened. */
function TxLookupPanel({ id, rangeQ, rangeWords, onClose }: { id: string; rangeQ: string; rangeWords: string; onClose: () => void }) {
  const [wide, setWide] = useState(false);
  const { data, error, isLoading } = useApi<TransactionLookup>(`/api/transactions/${encodeURIComponent(id)}?${wide ? "window=30d" : rangeQ}`, 0);
  const row = data?.row ?? null;
  const o = row ? resultOf(row) : null;
  return (
    <LookupFrame id={id} found={row?.guid} onClose={onClose}
      tag={o && <span className="gw-tag" style={{ fontSize: 10, color: o.color, borderColor: "currentColor" }}>{o.label}</span>}>
      {isLoading ? (
        <SkelLine w="50%" />
      ) : error && !data ? (
        <div style={{ color: "var(--text-4)" }}>{LOOKUP_REFUSED}</div>
      ) : data && !data.available ? (
        <div style={{ color: "var(--text-4)" }}>{unreadableWords(data.reason)}</div>
      ) : data?.found && !row ? (
        <div style={{ color: "var(--text-4)" }}>This request is in the router&apos;s logs, but it isn&apos;t a transaction - look it up on the Errors tab.</div>
      ) : !row ? (
        <NotFound id={id} rangeWords={rangeWords} wide={wide} onWiden={() => setWide(true)} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <MatchesNote matches={data?.matches} />
          <Details row={row} />
        </div>
      )}
    </LookupFrame>
  );
}

/** How much of the window the reads on screen cover, in words: "12 minutes", "3 hours". */
function readSpan(endMs: number | undefined, fromMs: number | null): string {
  if (endMs == null || fromMs == null) return "part";
  const min = Math.max(1, Math.round((endMs - fromMs) / 60_000));
  return min < 120 ? `${min} minute${min === 1 ? "" : "s"}` : `${Math.round(min / 60)} hours`;
}

export function TransactionLog({ chainFilter, win }: { chainFilter: string | null; win: MetricWindow }) {
  const [outcome, setOutcome] = useState<TxLogRow["outcome"] | typeof ALL>(ALL);
  const [customer, setCustomer] = useState(ALL);
  const [method, setMethod] = useState(ALL);
  const [errType, setErrType] = useState(ALL);
  const [upstream, setUpstream] = useState(ALL);
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [range, setRange] = useState<ExactRange | null>(null);
  // A picked range that has closed can't change: read it once, don't poll it.
  const [live, setLive] = useState(true);
  // A request named in the URL opens looked up.
  const [lookupId, setLookupId] = useState<string | null>(requestFromUrl);
  // Back / Forward: the look-up follows the URL.
  useEffect(() => {
    const onPop = () => setLookupId(requestFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The URL names the request last opened or found that is still in view.
  const find = (id: string | null) => { setLookupId(id); linkRequest(id ?? open); };
  const toggleRow = (guid: string) => { const next = open === guid ? null : guid; setOpen(next); linkRequest(next ?? lookupId); };

  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  // Rows are matched to a config router by the upstreams they went to.
  const { routerIdQ } = useRouterFilter();

  // Another chain or router is another list: what was open on the last one closes.
  const scopeKey = `${chainFilter ?? ""}|${routerIdQ}`;
  const [shownScope, setShownScope] = useState(scopeKey);
  if (shownScope !== scopeKey) { setShownScope(scopeKey); setOpen(null); setLookupId(null); setPage(0); }
  useEffect(() => { if (!open && !lookupId) linkRequest(null); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const rangeQ = range ? `from=${Math.round(range.from)}&to=${Math.round(range.to)}` : `window=${win}`;
  const log = useLogReads<TxLogRow, TransactionsReport>(`/api/transactions?${rangeQ}${specQ}${routerIdQ}`, live);
  const data = log.head;
  const isLoading = log.first.isLoading;
  const held = useHeldRows(log.rows, open);
  const [headRef, headVar] = useListHeadHeight();
  const allRows = held.rows;
  const sum = useMemo(() => summarize(allRows), [allRows]);
  const when = range ? "in the times you picked" : `in the last ${WINDOWS[win].label}`;
  const methods = useMemo(() => [...new Set(allRows.map((r) => r.method))].sort(), [allRows]);
  const errTypes = useMemo(() => errorTypeOptions(allRows), [allRows]);
  // The upstreams the transactions went to, each with its count of transactions.
  const upstreams = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of allRows) for (const u of new Set(r.attempts.map((a) => a.upstream))) n.set(u, (n.get(u) ?? 0) + 1);
    return [...n].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => ({ name, count }));
  }, [allRows]);
  // The result options count within the other filters, so a number is what picking it would list.
  const customers = useMemo(() => customerOptions(allRows), [allRows]);
  const byOthers = allRows.filter((r) =>
    (customer === ALL || hasCustomer(r, customer)) &&
    (method === ALL || r.method === method) &&
    (errType === ALL || hasErrorType(r, errType)) &&
    (upstream === ALL || r.attempts.some((a) => a.upstream === upstream)));
  const rows = outcome === ALL ? byOthers : byOthers.filter((r) => r.outcome === outcome);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(curPage * PER_PAGE, (curPage + 1) * PER_PAGE);

  const header = (
    <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
      <TimeRangeControl
        range={range}
        onChange={(r) => { setRange(r); setLive(rangeIsLive(r)); setPage(0); }}
        windowLabel={WINDOWS[win].label}
        windowMs={WINDOWS[win].rangeSeconds * 1000}
      />
    </div>
  );

  const cantRead = (title: string, body: React.ReactNode) => (
    <div style={{ paddingTop: 8 }}>
      {header}
      <div className="gw-card" style={{ padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 13, color: "var(--text-3)" }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--text-4)", maxWidth: 520, lineHeight: 1.6 }}>{body}</span>
      </div>
    </div>
  );
  if (data && !data.available) {
    return data.reason === "unreachable"
      ? cantRead("The router's logs didn't answer in time.", <>Try again, or pick a shorter range.</>)
      : cantRead("The Transactions tab can't read the router's logs.", <>
          It reads them from Loki (the log store). Set <span className="gw-mono">LOKI_URL</span> on the API to your Loki -
          the compose <span className="gw-mono">logs</span> profile runs one - and check that it is up.
        </>);
  }
  // Never zeros for a read that didn't happen.
  if (log.first.error && !data) {
    return cantRead("The transactions couldn't be loaded.", <>The API didn&apos;t answer. The tab tries again on its next refresh.</>);
  }

  const share = (n: number) => (sum.total ? `${fmtPct(n / sum.total, 1)} of all` : "none yet");
  const kpis: { label: string; tipKey: string; value: string; sub: React.ReactNode }[] = [
    { label: "Transactions", tipKey: "txTotal", value: fmtComma(sum.total),
      // Not the whole window yet: say how much of it the count covers, never a bare "0+".
      sub: log.more
        ? <>in the newest {readSpan(data?.range?.endMs, log.readFrom)} of the window - load older ones below</>
        : <>sent through the router {when}</> },
    { label: "Sent", tipKey: "txSent", value: fmtComma(sum.accepted),
      sub: <>{share(sum.accepted)} · not confirmed on chain{sum.failedOnChain ? <> · {fmtComma(sum.failedOnChain)} failed on chain</> : null}</> },
    { label: "Refused", tipKey: "txRefused", value: fmtComma(sum.rejected),
      sub: <>{share(sum.rejected)} · usually the transaction itself</> },
    { label: "Outcome unknown", tipKey: "txUnknown", value: fmtComma(sum.unknown),
      sub: sum.unknown
        ? <>may have been sent{sum.failed ? <> · {fmtComma(sum.failed)} not sent</> : null}</>
        : <>none in these transactions{sum.failed ? <> · {fmtComma(sum.failed)} not sent</> : null}</> },
  ];

  return (
    <div style={{ paddingTop: 8 }}>
      {header}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12, marginBottom: 12 }}>
        {kpis.map((k) => (
          <div key={k.label} className="gw-card" style={{ padding: "13px 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              {k.label}<Tip text={TT[k.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, marginTop: 7 }}>
              {isLoading ? <SkelValue h={25} w={96} /> : k.value}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6, minHeight: "1.5em" }}>
              {isLoading ? <SkelLine w={176} /> : k.sub}
            </div>
          </div>
        ))}
      </div>

      <TransactionsChart win={win} specQ={specQ} routerIdQ={routerIdQ} exactRange={range !== null} />

      <div className="gw-card gw-log-card" style={{ padding: 0, overflow: "clip", ...headVar }}>
        <div ref={headRef} style={stickyListHeader}>
          <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
            Transactions<Tip text={TT.txLog!} />
            {data && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>{fmtComma(rows.length)}{rows.length !== allRows.length ? ` of ${fmtComma(allRows.length)}` : ""}</span>}
            <span style={{ marginLeft: 8, display: "inline-flex" }}><Refreshing show={log.refreshing} label="Reading newer transactions" /></span>
          </span>
          {/* Narrowing it down, and finding one transaction. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <FilterSelect aria-label="Result" value={outcome} onChange={(e) => reset(setOutcome)(e.target.value as TxLogRow["outcome"] | typeof ALL)} style={narrowSelect} disabled={!allRows.length && outcome === ALL}>
              <option value={ALL}>All results</option>
              {/* No counts before the first read lands: a 0 there would be a claim. */}
              {OUTCOME_ORDER.map((o) => <option key={o} value={o}>{OUTCOME[o].label}{data ? ` (${fmtComma(byOthers.filter((r) => r.outcome === o).length)})` : ""}</option>)}
            </FilterSelect>
            <FilterSelect aria-label="Customer" value={customer} onChange={(e) => reset(setCustomer)(e.target.value)} style={narrowSelect} disabled={!customers.length && customer === ALL}>
              <option value={ALL}>All customers</option>
              {customers.map((c) => <option key={c.key} value={c.key}>{c.label} ({fmtComma(c.count)})</option>)}
            </FilterSelect>
            <FilterSelect aria-label="Method" value={method} onChange={(e) => reset(setMethod)(e.target.value)} style={narrowSelect} disabled={!methods.length}>
              <option value={ALL}>All methods</option>
              {methods.map((m) => <option key={m} value={m}>{m === "unknown" ? "method not in the logs" : m}</option>)}
            </FilterSelect>
            <FilterSelect aria-label="Error type" value={errType} onChange={(e) => reset(setErrType)(e.target.value)} style={narrowSelect} disabled={!errTypes.length}>
              <option value={ALL}>All error types</option>
              {errTypes.map((t) => <option key={t.key} value={t.key}>{t.label} ({fmtComma(t.count)})</option>)}
            </FilterSelect>
            <FilterSelect aria-label="Provider" value={upstream} onChange={(e) => reset(setUpstream)(e.target.value)} style={narrowSelect} disabled={!upstreams.length && upstream === ALL}>
              <option value={ALL}>All providers</option>
              {upstream !== ALL && !upstreams.some((u) => u.name === upstream) && <option value={upstream}>{upstream}</option>}
              {upstreams.map((u) => <option key={u.name} value={u.name}>{u.name} ({fmtComma(u.count)})</option>)}
            </FilterSelect>
            <span style={{ flex: 1 }} />
            <IdSearch onFind={find} />
          </div>
        </div>
        {lookupId && (
          <TxLookupPanel key={lookupId + rangeQ} id={lookupId} rangeQ={rangeQ} rangeWords={range ? "of the times you picked" : `of the last ${WINDOWS[win].label}`}
            onClose={() => find(null)} />
        )}
        <ReadingStrip show={isLoading} rangeWords={when} />
        <UnreadStrip count={log.unread} noun="transaction" bound={!!chainFilter || !!routerIdQ} covers="the list and the numbers above" />
        {log.more && allRows.length > 0 && (
          <LogStrip>
            The latest {fmtComma(allRows.length)} transactions {when} - the numbers above cover these. Load older ones at the bottom.
          </LogStrip>
        )}
        <NewRowsStrip count={held.newCount} noun="transaction" onShow={held.showNew} />
        {/* Below 860px the columns would overlap: scroll sideways instead. */}
        <div className="gw-log-scroll">
          <table className="gw-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 860 }}>
            <colgroup>
              <col style={{ width: 166 }} />
              <col style={{ width: "20%" }} />
              <col />
              <col style={{ width: 170 }} />
              <col style={{ width: 124 }} />
            </colgroup>
            <thead>
              <tr>
                <th><TimeColumnHead /></th>
                <th>Chain · method</th>
                <th>Sent to</th>
                <th>Result</th>
                <th style={{ textAlign: "right" }}>Response time</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <SkelRows rows={6} cols={LOG_SKEL_COLS} />}
              {pageRows.map((r) => {
                const o = resultOf(r);
                const isOpen = open === r.guid;
                const toggle = () => toggleRow(r.guid);
                return (
                  <Fragment key={r.guid}>
                    <tr tabIndex={0} aria-expanded={isOpen} className={`gw-logrow${isOpen ? " is-open" : ""}`} onClick={toggle} onKeyDown={onRowKey(toggle)}>
                      <td style={{ maxWidth: 0, verticalAlign: "top" }}>
                        <svg className="gw-logrow-chev" viewBox="0 0 12 12" aria-hidden><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
<WhenCell time={r.time} customer={r.customer} />
                      </td>
                      <td style={{ maxWidth: 0, verticalAlign: "top" }}>
                        {/* The icon sits on the chain's line, not halfway down the cell. */}
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
                          {r.spec && <span style={{ display: "flex", flexShrink: 0, marginTop: 1 }}><ChainBadge spec={r.spec} size={16} /></span>}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12 }} title={chainsTitle(r)}>{chainWords(r)}</div>
                            {r.method === "unknown"
                              ? <div style={{ fontSize: 10.5, color: "var(--text-4)", fontStyle: "italic" }}>method not in the logs</div>
                              : <div className="gw-mono" title={r.method} style={{ fontSize: 10.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.method}</div>}
                            {r.txHash && <div style={{ marginTop: 3 }}><TxHash hash={r.txHash} spec={r.spec} /></div>}
                          </div>
                        </div>
                      </td>
                      <td style={{ maxWidth: 0 }}>
                        <Flow attempts={r.attempts} replyColor={OUTCOME[r.outcome].color} quietReplied={r.outcome === "rejected"} />
                      </td>
                      <td style={{ verticalAlign: "top", maxWidth: 0 }}>
                        <ResultCell label={o.label} color={o.color} hint={[r.outcome === "accepted" && r.txStatus === "success" ? "The chain ran the transaction and it succeeded: the send reply says so." : OUTCOME_HINT[r.outcome], r.note].filter(Boolean).join("\n\n")}
                          error={r.outcome === "failed-on-chain" ? r.txError ?? null : appGot({ result: r.outcome === "unknown" && r.error ? "failed" : r.outcome, attempts: r.attempts, error: r.error?.message ?? null })}
                          next={nextOf(r)} />
                      </td>
                      <td style={{ textAlign: "right", verticalAlign: "top" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtTook(r.replyMs)}</span></td>
                    </tr>
                    {isOpen && (
                      <tr className="gw-logrow-detail">
                        <td colSpan={5}><Details row={r} /></td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              <OlderRowsLoading show={log.loadingOlder && curPage === pageCount - 1} />
              {data && rows.length === 0 && !log.loadingOlder && (
                <tr><td colSpan={5} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>
                  {allRows.length ? "No transactions match these filters."
                    : log.unread ? `None of the transactions found ${when} came back from the logs in time.`
                    : log.more ? "No transactions in the part of this period read so far. Older ones may be: load them below."
                    : <>No transactions {when}.<div style={{ marginTop: 6, fontSize: 11 }}>Expected some? A router older than v1.6.1 records transactions only at the info log level.</div></>}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager
          page={curPage}
          pageCount={pageCount}
          total={rows.length}
          perPage={PER_PAGE}
          noun="transactions"
          onPage={setPage}
          more={log.more ? { loading: log.loadingOlder, failed: log.olderFailed, onLoad: log.loadOlder } : null}
        />
      </div>
    </div>
  );
}
