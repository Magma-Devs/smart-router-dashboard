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
import { WINDOWS, type MetricWindow, type TransactionLookup, type TransactionsReport, type TxLogRow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useLogReads } from "@/hooks/use-log-reads";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Refreshing, SkelLine, SkelRows, SkelValue } from "@/components/gateway/Skel";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Tip } from "@/components/gateway/Tip";
import { TT } from "@/lib/tooltips";
import { errorDocsUrl } from "@/lib/error-docs";
import { fmtComma, fmtPct } from "@/lib/format";
import { linkRequest, requestFromUrl } from "@/lib/request-in-url";
import {
  AppGot,
  appGot,
  AttemptList,
  CallFactsLine,
  CustomerCell,
  customerOptions,
  hasCustomer,
  LOOKUP_REFUSED,
  MatchesNote,
  TxHash,
  DetailLine,
  detailText,
  errorTypeOptions,
  filterSelectStyle,
  Flow,
  fmtTook,
  fmtWhen,
  hasErrorType,
  IdSearch,
  LOG_SKEL_COLS,
  LogStrip,
  LookupFrame,
  NotFound,
  OlderRowsLoading,
  Pager,
  ReadingStrip,
  RequestIdLine,
  TimeRangeControl,
  chainWords,
  chainsTitle,
  onRowKey,
  rangeIsLive,
  unreadableWords,
  UnreadStrip,
  type ExactRange,
  ResponseSource,
} from "./request-log";
import { TransactionsChart, TX_RESULT } from "./TransactionsChart";

const PER_PAGE = 25;
const ALL = "all";

/** The filter row's dropdowns: capped, so a long name can't push the row onto two lines. */
const narrowSelect: React.CSSProperties = { ...filterSelectStyle, maxWidth: 200 };

/** The cards' numbers over the rows loaded so far - every read appended, each
 *  transaction once. `unknown` counts in the total but not in the rate: its
 *  end can't be told. The api's own `summarize` over one read, over them all. */
function summarize(rows: TxLogRow[]) {
  const count = (o: TxLogRow["outcome"]) => rows.filter((r) => r.outcome === o).length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  const failed = count("failed");
  const failedOnChain = count("failed-on-chain");
  const decided = accepted + rejected + failed + failedOnChain;
  return { total: rows.length, accepted, rejected, failed, failedOnChain, successRate: decided > 0 ? accepted / decided : null };
}

/** The list's results, as the chart above it draws them. */
const OUTCOME: Record<TxLogRow["outcome"], { label: string; color: string }> = TX_RESULT;
const OUTCOME_ORDER: TxLogRow["outcome"][] = ["accepted", "rejected", "failed-on-chain", "failed", "unknown"];

/** Every upstream's answer in full, when a row is opened. A rejection is the
 *  answering upstream's own error, so it shows on that upstream's line. */
function Details({ row }: { row: TxLogRow }) {
  return (
    <div style={{ display: "grid", gap: 10, padding: "4px 4px 8px" }}>
      <AttemptList attempts={row.attempts} />
      {row.note && (
        <DetailLine>
          <div style={{ fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>
            <span style={{ color: "var(--text-2)" }}>Why the result is unknown: </span>{row.note}
          </div>
        </DetailLine>
      )}
      {row.outcome === "failed" && row.error && (
        <DetailLine at={row.replyMs != null ? `+${fmtComma(row.replyMs)} ms` : ""}>
          <div style={{ fontSize: 12, color: "var(--err)" }}>
            Router error returned to the client ·{" "}
            <a className="gw-mono" href={errorDocsUrl(row.error.code)} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-3)" }}>{row.error.code}</a>
          </div>
          <div className="gw-mono" style={detailText}>{row.error.message}</div>
        </DetailLine>
      )}
      {row.outcome === "failed-on-chain" && (
        <DetailLine at={row.replyMs != null ? `+${fmtComma(row.replyMs)} ms` : ""}>
          <div style={{ fontSize: 12, color: "var(--err)" }}>Failed on chain: the chain ran the transaction and it failed</div>
          {row.txError && <div className="gw-mono" style={detailText}>{row.txError}</div>}
        </DetailLine>
      )}
      {row.txHash && (
        <DetailLine>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--text-4)", flexWrap: "wrap" }}>
            Transaction hash <TxHash hash={row.txHash} spec={row.spec} refused={row.outcome === "rejected"} full />
            {row.txStatus === "success" && <span>· the chain ran it</span>}
            {row.outcome === "rejected" && <span>· refused by every node, so the chain most likely never saw it</span>}
          </div>
        </DetailLine>
      )}
      <CallFactsLine row={row} spec={row.spec} />
      <RequestIdLine id={row.guid} startMs={row.time} tookMs={row.replyMs} />
    </div>
  );
}

/** One transaction looked up by its request ID - the same row the log shows, opened. */
function TxLookupPanel({ id, rangeQ, rangeWords, onClose }: { id: string; rangeQ: string; rangeWords: string; onClose: () => void }) {
  const [wide, setWide] = useState(false);
  const { data, error, isLoading } = useApi<TransactionLookup>(`/api/transactions/${encodeURIComponent(id)}?${wide ? "window=30d" : rangeQ}`, 0);
  const row = data?.row ?? null;
  const o = row ? OUTCOME[row.outcome] : null;
  return (
    <LookupFrame id={id} onClose={onClose}
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
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-2)", flexWrap: "wrap" }}>
            <span className="gw-mono gw-tnum">{fmtWhen(row.time)}</span>
            {row.spec ? <><ChainBadge spec={row.spec} size={14} /><span>{chainWords(row)}</span></> : row.specs && <span title={chainsTitle(row)}>{chainWords(row)}</span>}
            <span className="gw-mono" style={{ color: "var(--text-3)" }}>{row.method === "unknown" ? "method not in the logs" : row.method}</span>
            <span style={{ color: "var(--text-4)" }}>responded in {fmtTook(row.replyMs)}</span>
          </div>
          <Flow attempts={row.attempts} replyColor={OUTCOME[row.outcome].color} />
          <AppGot text={appGot({ result: row.outcome, attempts: row.attempts, error: row.error?.message ?? null })} />
          <Details row={row} />
        </div>
      )}
    </LookupFrame>
  );
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
  const rangeQ = range ? `from=${Math.round(range.from)}&to=${Math.round(range.to)}` : `window=${win}`;
  // An open row holds the list still: a newer read would move it, or page it out of view.
  const held = live && open !== null;
  const log = useLogReads<TxLogRow, TransactionsReport>(`/api/transactions?${rangeQ}${specQ}${routerIdQ}`, live && !held);
  const data = log.head;
  const isLoading = log.first.isLoading;
  const allRows = log.rows;
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

  const kpis: { label: string; tipKey: string; value: string; sub: React.ReactNode }[] = [
    { label: "Transactions", tipKey: "txTotal", value: fmtComma(sum.total) + (log.more ? "+" : ""),
      sub: log.more
        ? sum.total ? <>the latest {fmtComma(sum.total)} {when} - load older ones below</> : <>none in the part read so far - load older ones below</>
        : <>sent through the router {when}</> },
    { label: "Success rate", tipKey: "txSuccessRate", value: fmtPct(sum.successRate, 1),
      sub: <>{fmtComma(sum.accepted)} accepted by an upstream</> },
    { label: "Failed", tipKey: "txFailed", value: fmtComma(sum.rejected + sum.failed + sum.failedOnChain),
      sub: <>{fmtComma(sum.rejected)} rejected by the node{sum.failedOnChain ? <> · {fmtComma(sum.failedOnChain)} failed on chain</> : null} · {fmtComma(sum.failed)} router error{sum.failed === 1 ? "" : "s"}</> },
  ];

  return (
    <div style={{ paddingTop: 8 }}>
      {header}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 12, marginBottom: 12 }}>
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

      <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "grid", gap: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
            Transactions<Tip text={TT.txLog!} />
            {data && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>{fmtComma(rows.length)}{rows.length !== allRows.length ? ` of ${fmtComma(allRows.length)}` : ""}</span>}
            <span style={{ marginLeft: 8, display: "inline-flex" }}><Refreshing show={log.refreshing} label="Reading newer transactions" /></span>
            {held && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>· paused while a row is open</span>}
          </span>
          {/* Narrowing it down, and finding one transaction. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <select aria-label="Result" value={outcome} onChange={(e) => reset(setOutcome)(e.target.value as TxLogRow["outcome"] | typeof ALL)} style={narrowSelect} disabled={!allRows.length && outcome === ALL}>
              <option value={ALL}>All results</option>
              {/* No counts before the first read lands: a 0 there would be a claim. */}
              {OUTCOME_ORDER.map((o) => <option key={o} value={o}>{OUTCOME[o].label}{data ? ` (${fmtComma(byOthers.filter((r) => r.outcome === o).length)})` : ""}</option>)}
            </select>
            <select aria-label="Customer" value={customer} onChange={(e) => reset(setCustomer)(e.target.value)} style={narrowSelect} disabled={!customers.length && customer === ALL}>
              <option value={ALL}>All customers</option>
              {customers.map((c) => <option key={c.key} value={c.key}>{c.label} ({fmtComma(c.count)})</option>)}
            </select>
            <select aria-label="Method" value={method} onChange={(e) => reset(setMethod)(e.target.value)} style={narrowSelect} disabled={!methods.length}>
              <option value={ALL}>All methods</option>
              {methods.map((m) => <option key={m} value={m}>{m === "unknown" ? "method not in the logs" : m}</option>)}
            </select>
            <select aria-label="Error type" value={errType} onChange={(e) => reset(setErrType)(e.target.value)} style={narrowSelect} disabled={!errTypes.length}>
              <option value={ALL}>All error types</option>
              {errTypes.map((t) => <option key={t.key} value={t.key}>{t.label} ({fmtComma(t.count)})</option>)}
            </select>
            <select aria-label="Upstream" value={upstream} onChange={(e) => reset(setUpstream)(e.target.value)} style={narrowSelect} disabled={!upstreams.length && upstream === ALL}>
              <option value={ALL}>All upstreams</option>
              {upstream !== ALL && !upstreams.some((u) => u.name === upstream) && <option value={upstream}>{upstream}</option>}
              {upstreams.map((u) => <option key={u.name} value={u.name}>{u.name} ({fmtComma(u.count)})</option>)}
            </select>
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
        {/* Below 860px the columns would overlap: scroll sideways instead. */}
        <div style={{ overflowX: "auto" }}>
          <table className="gw-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 860 }}>
            <colgroup>
              <col style={{ width: 150 }} />
              <col style={{ width: "20%" }} />
              <col />
              <col style={{ width: 170 }} />
              <col style={{ width: 124 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Time · customer</th>
                <th>Chain · method</th>
                <th>Sent to</th>
                <th>Result</th>
                <th style={{ textAlign: "right" }}>Response time</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <SkelRows rows={6} cols={LOG_SKEL_COLS} />}
              {pageRows.map((r) => {
                const o = OUTCOME[r.outcome];
                const isOpen = open === r.guid;
                const toggle = () => toggleRow(r.guid);
                return (
                  <Fragment key={r.guid}>
                    <tr tabIndex={0} aria-expanded={isOpen} style={{ cursor: "pointer" }} onClick={toggle} onKeyDown={onRowKey(toggle)}>
                      <td style={{ maxWidth: 0, verticalAlign: "top" }}>
                        <span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtWhen(r.time)}</span>
                        <CustomerCell customer={r.customer} />
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
                            {r.txHash && <div style={{ marginTop: 3 }}><TxHash hash={r.txHash} spec={r.spec} refused={r.outcome === "rejected"} /></div>}
                          </div>
                        </div>
                      </td>
                      <td style={{ maxWidth: 0 }}>
                        <Flow attempts={r.attempts} replyColor={OUTCOME[r.outcome].color} />
                        <AppGot text={appGot({ result: r.outcome, attempts: r.attempts, error: r.error?.message ?? null })} />
                      </td>
                      <td style={{ verticalAlign: "top" }} title={r.note ?? undefined}>
                        <span className="gw-tag" style={{ fontSize: 10, color: o.color, borderColor: "currentColor" }}>{o.label}</span>
                        {r.answeredBy && r.outcome !== "failed" && (
                          <ResponseSource label={r.outcome === "accepted" || r.outcome === "failed-on-chain" ? "served by" : "returned by"} name={r.answeredBy} />
                        )}
                      </td>
                      <td style={{ textAlign: "right", verticalAlign: "top" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtTook(r.replyMs)}</span></td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={5} style={{ background: "var(--bg-2)" }}><Details row={r} /></td>
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
                    : `No transactions ${when}. Before smart-router v1.6.1, a router logs them only at info level: one logging at warn shows none.`}
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
