"use client";

/* Transaction-log tab - every transaction the router sent, one row each: the
 * chain and method, every upstream it went to and what each answered, whose
 * reply went back, how long that took, and how it ended. Live data:
 * /api/transactions, which rebuilds each transaction from the router's own
 * log lines in Loki - Prometheus holds totals, never one request. Two filters
 * narrow the rows: the method and the error type. The tab follows the page's
 * window or exact times picked here - the cards too, since they count the
 * list - and "Load older" reads on past one read's cap. The chips and
 * details are shared with the Errors tab's request list (request-log.tsx).
 * Value and finality are not here yet: the logs cut long transactions short,
 * and finality needs the chain. */

import { Fragment, useMemo, useState } from "react";
import { buildChainMetaByIndex, WINDOWS, type MetricWindow, type TransactionLookup, type TransactionsReport, type TxLogRow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useLogReads } from "@/hooks/use-log-reads";
import { useRouterFilter } from "@/hooks/use-router-options";
import { SkelLine, SkelRows, SkelValue } from "@/components/gateway/Skel";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Tip } from "@/components/gateway/Tip";
import { CopyButton } from "@/components/gateway/CopyButton";
import { TT } from "@/lib/tooltips";
import { errorDocsUrl } from "@/lib/error-docs";
import { fmtComma, fmtPct } from "@/lib/format";
import {
  AppGot,
  appGot,
  AttemptList,
  DetailLine,
  detailText,
  errorTypeOptions,
  filterSelectStyle,
  Flow,
  fmtTook,
  fmtWhen,
  hasErrorType,
  IdSearch,
  LOGS_UNREADABLE,
  LookupFrame,
  NotFound,
  Pager,
  TimeRangeControl,
  type ExactRange,
  ResponseSource,
} from "./request-log";

const PER_PAGE = 25;
const ALL = "all";

/** The cards' numbers over the rows loaded so far - every read appended, each
 *  transaction once. `unknown` counts in the total but not in the rate: its
 *  end can't be told. The api's own `summarize` over one read, over them all. */
function summarize(rows: TxLogRow[]) {
  const count = (o: TxLogRow["outcome"]) => rows.filter((r) => r.outcome === o).length;
  const accepted = count("accepted");
  const rejected = count("rejected");
  const failed = count("failed");
  const decided = accepted + rejected + failed;
  return { total: rows.length, accepted, rejected, failed, successRate: decided > 0 ? accepted / decided : null };
}

const OUTCOME: Record<TxLogRow["outcome"], { label: string; color: string }> = {
  accepted: { label: "Accepted", color: "var(--ok)" },
  rejected: { label: "Rejected", color: "var(--err)" },
  failed: { label: "Router error", color: "var(--err)" },
  unknown: { label: "Unknown", color: "var(--text-4)" },
};

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
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--text-4)" }}>
        Request ID <span className="gw-mono" style={{ color: "var(--text-3)" }}>{row.guid}</span> <CopyButton text={row.guid} />
      </div>
    </div>
  );
}

/** One transaction looked up by its request ID - the same row the log shows, opened. */
function TxLookupPanel({ id, rangeQ, rangeWords, onClose }: { id: string; rangeQ: string; rangeWords: string; onClose: () => void }) {
  const [wide, setWide] = useState(false);
  const { data, isLoading } = useApi<TransactionLookup>(`/api/transactions/${encodeURIComponent(id)}?${wide ? "window=30d" : rangeQ}`, 0);
  const row = data?.row ?? null;
  const o = row ? OUTCOME[row.outcome] : null;
  return (
    <LookupFrame id={id} onClose={onClose}
      tag={o && <span className="gw-tag" style={{ fontSize: 10, color: o.color, borderColor: "currentColor" }}>{o.label}</span>}>
      {isLoading ? (
        <SkelLine w="50%" />
      ) : data && !data.available ? (
        <div style={{ color: "var(--text-4)" }}>{LOGS_UNREADABLE}</div>
      ) : data?.found && !row ? (
        <div style={{ color: "var(--text-4)" }}>This request is in the router&apos;s logs, but it isn&apos;t a transaction - look it up on the Errors tab.</div>
      ) : !row ? (
        <NotFound rangeWords={rangeWords} wide={wide} onWiden={() => setWide(true)} />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-2)", flexWrap: "wrap" }}>
            <span className="gw-mono gw-tnum">{fmtWhen(row.time)}</span>
            {row.spec && <><ChainBadge spec={row.spec} size={14} /><span>{buildChainMetaByIndex(row.spec).name}</span></>}
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
  const [method, setMethod] = useState(ALL);
  const [errType, setErrType] = useState(ALL);
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [range, setRange] = useState<ExactRange | null>(null);
  const [lookupId, setLookupId] = useState<string | null>(null);

  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  // Rows are matched to a config router by the upstreams they went to.
  const { routerIdQ } = useRouterFilter();
  const rangeQ = range ? `from=${Math.round(range.from)}&to=${Math.round(range.to)}` : `window=${win}`;
  const log = useLogReads<TxLogRow, TransactionsReport>(`/api/transactions?${rangeQ}${specQ}${routerIdQ}`);
  const data = log.first.data;
  const isLoading = log.first.isLoading;
  const allRows = log.rows;
  const sum = useMemo(() => summarize(allRows), [allRows]);
  const when = range ? "in the times you picked" : `in the last ${WINDOWS[win].label}`;
  const methods = useMemo(() => [...new Set(allRows.map((r) => r.method))].sort(), [allRows]);
  const errTypes = useMemo(() => errorTypeOptions(allRows), [allRows]);
  const rows = allRows.filter((r) => (method === ALL || r.method === method) && (errType === ALL || hasErrorType(r, errType)));
  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(curPage * PER_PAGE, (curPage + 1) * PER_PAGE);

  const header = (
    <div style={{ marginBottom: 16, display: "flex", justifyContent: "flex-end" }}>
      <TimeRangeControl
        range={range}
        onChange={(r) => { setRange(r); setPage(0); }}
        windowLabel={WINDOWS[win].label}
        windowMs={WINDOWS[win].rangeSeconds * 1000}
      />
    </div>
  );

  if (data && !data.available) {
    return (
      <div style={{ paddingTop: 8 }}>
        {header}
        <div className="gw-card" style={{ padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 13, color: "var(--text-3)" }}>The Transactions tab can&apos;t read the router&apos;s logs.</span>
          <span style={{ fontSize: 12, color: "var(--text-4)", maxWidth: 520, lineHeight: 1.6 }}>
            It reads them from Loki (the log store). Set <span className="gw-mono">LOKI_URL</span> on the API to your Loki -
            the compose <span className="gw-mono">logs</span> profile runs one - and check that it is up.
          </span>
        </div>
      </div>
    );
  }

  const kpis: { label: string; tipKey: string; value: string; sub: React.ReactNode }[] = [
    { label: "Transactions", tipKey: "txTotal", value: fmtComma(sum.total) + (log.more ? "+" : ""),
      sub: log.more ? <>the latest {fmtComma(sum.total)} {when} - load older ones below</> : <>sent through the router {when}</> },
    { label: "Success rate", tipKey: "txSuccessRate", value: fmtPct(sum.successRate, 1),
      sub: <>{fmtComma(sum.accepted)} accepted by an upstream</> },
    { label: "Failed", tipKey: "txFailed", value: fmtComma(sum.rejected + sum.failed),
      sub: <>{fmtComma(sum.rejected)} rejected by the node · {fmtComma(sum.failed)} router error{sum.failed === 1 ? "" : "s"}</> },
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

      <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
            Transactions<Tip text={TT.txLog!} />
            {data && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>{fmtComma(rows.length)}{rows.length !== allRows.length ? ` of ${fmtComma(allRows.length)}` : ""}</span>}
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <IdSearch onFind={setLookupId} />
            <select aria-label="Method" value={method} onChange={(e) => { setMethod(e.target.value); setPage(0); }} style={filterSelectStyle} disabled={!methods.length}>
              <option value={ALL}>All methods</option>
              {methods.map((m) => <option key={m} value={m}>{m === "unknown" ? "method not in the logs" : m}</option>)}
            </select>
            <select aria-label="Error type" value={errType} onChange={(e) => { setErrType(e.target.value); setPage(0); }} style={filterSelectStyle} disabled={!errTypes.length}>
              <option value={ALL}>All error types</option>
              {errTypes.map((t) => <option key={t.key} value={t.key}>{t.label} ({fmtComma(t.count)})</option>)}
            </select>
          </div>
        </div>
        {lookupId && (
          <TxLookupPanel key={lookupId + rangeQ} id={lookupId} rangeQ={rangeQ} rangeWords={range ? "of the times you picked" : `of the last ${WINDOWS[win].label}`}
            onClose={() => setLookupId(null)} />
        )}
        {log.more && (
          <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--line)", fontSize: 11, color: "var(--text-4)" }}>
            The latest {fmtComma(allRows.length)} transactions {when} - the numbers above cover these. Load older ones at the bottom.
          </div>
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
                <th>Time sent</th>
                <th>Chain · method</th>
                <th>Sent to</th>
                <th>Result</th>
                <th style={{ textAlign: "right" }}>Response time</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <SkelRows rows={6} cols={[{ w: 90 }, { w: "70%" }, { w: "85%" }, { w: 90 }, { w: 50, align: "right" }]} />}
              {pageRows.map((r) => {
                const o = OUTCOME[r.outcome];
                const isOpen = open === r.guid;
                return (
                  <Fragment key={r.guid}>
                    <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : r.guid)}>
                      <td style={{ verticalAlign: "top" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtWhen(r.time)}</span></td>
                      <td style={{ maxWidth: 0, verticalAlign: "top" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                          {r.spec && <ChainBadge spec={r.spec} size={16} />}
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 12 }}>{r.spec ? buildChainMetaByIndex(r.spec).name : "—"}</div>
                            {r.method === "unknown"
                              ? <div style={{ fontSize: 10.5, color: "var(--text-4)", fontStyle: "italic" }}>method not in the logs</div>
                              : <div className="gw-mono" title={r.method} style={{ fontSize: 10.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.method}</div>}
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
                          <ResponseSource label={r.outcome === "accepted" ? "served by" : "returned by"} name={r.answeredBy} />
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
              {data && rows.length === 0 && (
                <tr><td colSpan={5} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>
                  {allRows.length ? "No transactions match these filters." : `No transactions ${when}.`}
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
