"use client";

/* The Errors tab's request list - every request that hit an error, newest
 * first, from the router's logs (/api/error-requests): each try's upstream
 * and what it answered, what the app got, and why the router stopped.
 * Filters: the result, whether the error was retryable, the error type, the
 * customer, the method and the upstream (chain and router come from the page). An exact
 * time range zooms into an incident - a bar on the Upstreams tab opens the
 * list on its own - and "Load older" reads on past one read's cap. The chips
 * and details are shared with the Transactions tab (request-log.tsx). */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { WINDOWS, WRITE_UNKNOWN_NOTE, explainRouterError, type ErrorRequestRow, type ErrorRequestsReport, type MetricWindow, type RequestLookup } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useLogReads } from "@/hooks/use-log-reads";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Refreshing, SkelLine, SkelRows } from "@/components/gateway/Skel";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Tip } from "@/components/gateway/Tip";
import { TT } from "@/lib/tooltips";
import { fmtComma } from "@/lib/format";
import { linkRequest, requestFromUrl } from "@/lib/request-in-url";
import {
  AppGot,
  appGot,
  CustomerCell,
  customerOptions,
  hasCustomer,
  LOOKUP_REFUSED,
  MatchesNote,
  errorLabel,
  errorTypeOptions,
  filterSelectStyle,
  Flow,
  fmtTook,
  fmtWhen,
  hasErrorType,
  chainWords,
  chainsTitle,
  IdSearch,
  LOG_SKEL_COLS,
  ResponseSource,
  LookupFrame,
  NotFound,
  OlderRowsLoading,
  onRowKey,
  openRowShown,
  Pager,
  ReadingStrip,
  rangeIsLive,
  retryKinds,
  stopMarker,
  TimeRangeControl,
  unreadableWords,
  UnreadStrip,
  type ExactRange,
} from "./request-log";
import { RequestBreakdown, type BreakdownProps, type FinalAnswer } from "./request-breakdown";

const PER_PAGE = 25;
export const ALL = "all";

/** What the app got, in words anyone reads the same way - and, on hover, how. */
export const RESULT: Record<ErrorRequestRow["result"], { label: string; color: string; hint: string }> = {
  ok: {
    label: "Answered",
    color: "var(--ok)",
    hint: "Served by an upstream; no attempt failed.",
  },
  recovered: {
    label: "Recovered",
    color: "var(--ok)",
    hint: "An attempt failed; a later attempt at another upstream succeeded.",
  },
  "error-reply": {
    label: "Node error",
    color: "var(--warn)",
    hint: "Node error: the upstream returned an error response (for example invalid params, internal error, pruned data, no archive access). It was returned to the client unchanged.",
  },
  failed: {
    label: "Router error",
    color: "var(--err)",
    hint: "Router error: no upstream returned a usable response (timeouts, connection errors, rate limits, HTTP 5xx), so the router returned its own error, typically \"insufficient results\".",
  },
  // The Transactions tab's "Unknown", in its words: the same request reads the same on both tabs.
  "write-unknown": { label: "Unknown", color: "var(--text-4)", hint: `Unknown: ${WRITE_UNKNOWN_NOTE}` },
  unknown: { label: "No end logged", color: "var(--text-4)", hint: "No end logged: the request may still be in flight, or the client disconnected." },
};
const RESULT_ORDER: ErrorRequestRow["result"][] = ["recovered", "error-reply", "failed", "write-unknown", "unknown"];
/** Rare results: a pill only while the list holds one. */
const RARE: ReadonlySet<ErrorRequestRow["result"]> = new Set(["write-unknown", "unknown"]);

/** Did this upstream's own attempt fail - no response, or an error response?
 *  What the upstream filter keeps, and what its bar on the Upstreams tab
 *  counts: a request it took part in and answered fine isn't its error. */
const failedAt = (r: ErrorRequestRow, upstream: string) =>
  r.attempts.some((a) => a.upstream === upstream && a.outcome === "failed");

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The router's error, by its own name: "failed relay, insufficient
 *  results ErrMsg: …" is "Insufficient results". */
function routerReason(r: Pick<ErrorRequestRow, "error" | "exhausted">): string {
  const e = r.error ?? "";
  if (/insufficient results/i.test(e)) return "Insufficient results";
  if (r.exhausted || /exhausted/i.test(e)) return "Upstreams exhausted";
  if (/deadline exceeded|timed? ?out/i.test(e)) return "Timed out";
  const head = e.replace(/\s*ErrMsg:.*$/s, "").trim();
  return head ? sentence(head.length > 40 ? head.slice(0, 39) + "…" : head) : "Router error";
}

/**
 * The Result column: the error returned to the client, by its own name, and
 * its source - "Internal error · returned by eth-mevblocker", "Insufficient
 * results · returned by router". Node error vs. router error was a distinction nobody could see in
 * two category words; it is plain once the error is named and its sender
 * given. The colour (and the hover) still say which of the two it is.
 */
export function resultBadge(r: ErrorRequestRow): { text: string; from: { label: string; name: string } | null } {
  if (r.result === "error-reply") {
    const a = r.attempts.find((x) => x.replied);
    return { text: sentence(a ? errorLabel(a) : "error response"), from: r.resolvedBy ? { label: "returned by", name: r.resolvedBy } : null };
  }
  if (r.result === "failed") return { text: routerReason(r), from: { label: "returned by", name: "router" } };
  return { text: RESULT[r.result].label, from: r.resolvedBy && (r.result === "recovered" || r.result === "ok") ? { label: "served by", name: r.resolvedBy } : null };
}

/** The tag itself: the error's name in its category's colour, the category and its meaning on hover. */
function ResultTag({ row }: { row: ErrorRequestRow }) {
  const res = RESULT[row.result];
  const b = resultBadge(row);
  return (
    <span className="gw-tag" title={res.hint}
      style={{ fontSize: 10, color: res.color, borderColor: "currentColor", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}>
      {b.text}
    </span>
  );
}

type RetryFilter = typeof ALL | "retryable" | "not-retryable";

/** Why the router stopped retrying, when it stopped short of an answer. */
function retriesWords(r: ErrorRequestRow): string | null {
  if (r.exhausted) return "All providers tried";
  if (r.stopReason === "NonRetryableNodeError") return "Not retried: another provider would return the same error";
  if (r.stopReason === "ProcessingTimeout") return "Stopped at the router's time limit";
  return null;
}

/** The response's status: the word, its colour, and a detail where the code doesn't carry one. */
export function statusOf(r: ErrorRequestRow): BreakdownProps["status"] {
  const failed = r.attempts.filter((a) => a.outcome === "failed").length;
  switch (r.result) {
    case "ok": return { label: "Success", color: "var(--ok)" };
    case "recovered": return { label: "Success", color: "var(--ok)", detail: failed ? `after ${failed} failed ${failed === 1 ? "try" : "tries"}` : null };
    case "error-reply": return { label: "Error", color: "var(--err)" };
    case "failed": return { label: "Error", color: "var(--err)", detail: r.errorCode ? null : "No usable response from any provider" };
    case "write-unknown": return { label: "Unknown", color: "var(--text-3)", detail: "Write not confirmed" };
    case "unknown": return { label: "Not logged", color: "var(--text-3)" };
  }
}

/** An opened row: the request, every try, and the response to the client, in plain words. */
function Details({ row }: { row: ErrorRequestRow }) {
  const replied = row.attempts.find((a) => a.replied);
  const final: FinalAnswer =
    row.result === "failed" || row.result === "write-unknown" ? { from: "router", code: row.errorCode }
      : replied ? { from: "provider", attempt: replied }
        : null;
  const known = row.errorCode ? explainRouterError(row.errorCode) : null;
  const extra =
    row.result === "write-unknown" && !known ? [{ label: "Next step", value: "Check the chain before sending it again." }]
      : row.result === "unknown" ? [{ label: "Note", value: "Still running, or log lines are missing." }]
        : undefined;
  return (
    <RequestBreakdown spec={row.spec} chain={chainWords(row)} chainTitle={chainsTitle(row)} method={row.method === "unknown" ? "method not in the logs" : row.method}
      time={row.time} guid={row.guid} tookMs={row.totalMs} facts={row} attempts={row.attempts}
      final={final} status={statusOf(row)} retries={retriesWords(row)} isWrite={row.result === "write-unknown"} extra={extra} />
  );
}

/** One request looked up by its ID: its path, what the app got, and every try in full. */
function LookupPanel({ id, rangeQ, rangeWords, onClose }: { id: string; rangeQ: string; rangeWords: string; onClose: () => void }) {
  const [wide, setWide] = useState(false);
  const { data, error, isLoading } = useApi<RequestLookup>(`/api/requests/${encodeURIComponent(id)}?${wide ? "window=30d" : rangeQ}`, 0);
  const row = data?.row ?? null;
  return (
    <LookupFrame id={id} found={row?.guid} onClose={onClose}
      tag={row && <ResultTag row={row} />}>
      {isLoading ? (
        <SkelLine w="50%" />
      ) : error && !data ? (
        <div style={{ color: "var(--text-4)" }}>{LOOKUP_REFUSED}</div>
      ) : data && !data.available ? (
        <div style={{ color: "var(--text-4)" }}>{unreadableWords(data.reason)}</div>
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

function Seg<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { key: T; label: string; count?: number; color?: string; title?: string }[];
}) {
  return (
    <div className="gw-segctl">
      {options.map((o) => (
        <button key={o.key} title={o.title} className={value === o.key ? "on" : ""} onClick={() => onChange(o.key)} style={{ padding: "5px 11px", whiteSpace: "nowrap" }}>
          {o.color && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 999, background: o.color, marginRight: 6, verticalAlign: "middle" }} />}
          {o.label}
          {o.count != null && <span className="gw-tnum" style={{ marginLeft: 6, color: "var(--text-4)" }}>{fmtComma(o.count)}</span>}
        </button>
      ))}
    </div>
  );
}

/** The filter row's dropdowns: capped, so a long error name can't push the row onto two lines. */
const narrowSelect: React.CSSProperties = { ...filterSelectStyle, maxWidth: 200 };

/**
 * The list's times - the page window, or exact ones picked here or a bar's -
 * and its reads of them. Held by the tab, so the cards above count the rows
 * the list shows rather than reading the logs again.
 */
export function useErrorList({ chainFilter, win, upstream, initialRange = null }: {
  chainFilter: string | null;
  win: MetricWindow;
  upstream: string;
  initialRange?: ExactRange | null;
}) {
  const [range, setRange] = useState<ExactRange | null>(initialRange);
  // A picked range that has closed can't change: read it once, don't poll it.
  const [live, setLive] = useState(() => rangeIsLive(initialRange));
  // An open row on screen holds the list still (`openRowShown`); the table says when one is.
  const [openShown, setOpenShown] = useState(false);
  const held = live && openShown;
  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  const { routerIdQ } = useRouterFilter();
  const rangeQ = range ? `from=${Math.round(range.from)}&to=${Math.round(range.to)}` : `window=${win}`;
  // On a bar's times with an upstream picked, the read itself is narrowed to
  // that upstream, so the cap applies to the requests the bar counts.
  const onBarRange = initialRange != null && range != null && range.from === initialRange.from && range.to === initialRange.to;
  const barQ = onBarRange && upstream !== ALL ? `&upstream=${encodeURIComponent(upstream)}` : "";
  const log = useLogReads<ErrorRequestRow, ErrorRequestsReport>(`/api/error-requests?${rangeQ}${specQ}${routerIdQ}${barQ}`, live && !held);
  const pick = (r: ExactRange | null) => { setRange(r); setLive(rangeIsLive(r)); };
  return { log, range, pick, rangeQ, routerIdQ, onBarRange, barQ, held, setOpenShown };
}

export type ErrorList = ReturnType<typeof useErrorList>;

export function ErrorRequests({ chainFilter, win, upstream, onUpstream, initialRange = null, list }: {
  chainFilter: string | null;
  win: MetricWindow;
  /** Controlled from the tab, so a bar on the Upstreams tab can open its own requests. */
  upstream: string;
  onUpstream: (u: string) => void;
  /** Exact times to open on - a bar's - instead of the page window. */
  initialRange?: ExactRange | null;
  /** The list's reads, held by the tab (`useErrorList`). */
  list: ErrorList;
}) {
  const [result, setResult] = useState<ErrorRequestRow["result"] | typeof ALL>(ALL);
  const [retry, setRetry] = useState<RetryFilter>(ALL);
  const [errType, setErrType] = useState(ALL);
  const [customer, setCustomer] = useState(ALL);
  const [method, setMethod] = useState(ALL);
  const [open, setOpen] = useState<string | null>(null);
  // A request named in the URL opens looked up.
  const [lookupId, setLookupId] = useState<string | null>(requestFromUrl);
  const [page, setPage] = useState(0);
  // Back / Forward: the look-up follows the URL.
  useEffect(() => {
    const onPop = () => setLookupId(requestFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The URL names the request last opened or found that is still in view.
  const find = (id: string | null) => { setLookupId(id); linkRequest(id ?? open); };
  const toggleRow = (guid: string) => { const next = open === guid ? null : guid; setOpen(next); linkRequest(next ?? lookupId); };

  const { log, range, rangeQ, routerIdQ, onBarRange, barQ, held } = list;
  const { first, head, rows: allRows } = log;

  const methods = useMemo(() => [...new Set(allRows.map((r) => r.method))].sort(), [allRows]);
  // The upstreams an attempt failed at, each with its count of requests.
  const upstreams = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of allRows) {
      for (const u of new Set(r.attempts.filter((a) => a.outcome === "failed").map((a) => a.upstream))) n.set(u, (n.get(u) ?? 0) + 1);
    }
    return [...n].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, count]) => ({ name, count }));
  }, [allRows]);
  const errTypes = useMemo(() => errorTypeOptions(allRows), [allRows]);
  const customers = useMemo(() => customerOptions(allRows), [allRows]);

  // Each row of pills counts within every other filter, so a pill's number is
  // what picking it would list.
  const byDropdowns = allRows.filter((r) =>
    (customer === ALL || hasCustomer(r, customer)) &&
    (method === ALL || r.method === method) &&
    (upstream === ALL || failedAt(r, upstream)) &&
    (errType === ALL || hasErrorType(r, errType)));
  const narrowed = byDropdowns.filter((r) => {
    if (retry === ALL) return true;
    const k = retryKinds(r);
    return retry === "retryable" ? k.retryable : k.notRetryable;
  });
  const rows = result === ALL ? narrowed : narrowed.filter((r) => r.result === result);
  const byResult = (k: ErrorRequestRow["result"]) => narrowed.filter((r) => r.result === k).length;
  const kinds = (result === ALL ? byDropdowns : byDropdowns.filter((r) => r.result === result)).map(retryKinds);

  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(curPage * PER_PAGE, (curPage + 1) * PER_PAGE);
  // The tab holds the reads: tell it whether the open row is still on screen.
  const shown = openRowShown(open, pageRows);
  const { setOpenShown } = list;
  useEffect(() => setOpenShown(shown), [shown, setOpenShown]);
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };

  // Opened on a bar's requests: the list, not the cards above it, is what
  // the click was for.
  const listRef = useRef<HTMLDivElement>(null);
  const jumpKey = initialRange ? `${initialRange.from}-${initialRange.to}` : null;
  /* Still on a bar's times with only its upstream picked. The bar counts
     every failed try at that upstream, the router's own relays included -
     the ones it sends by itself when it starts and to check its upstreams -
     and this list leaves those out: no client sent them. An empty list here has
     to say so, or it reads as the bar being wrong. */
  const onBar = onBarRange && upstream !== ALL && result === ALL && retry === ALL && errType === ALL && customer === ALL && method === ALL;
  useEffect(() => {
    if (jumpKey) listRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [jumpKey]);

  const cantRead = (title: string, body: React.ReactNode) => (
    <div className="gw-card" style={{ padding: "40px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 13, color: "var(--text-3)" }}>{title}</span>
      <span style={{ fontSize: 12, color: "var(--text-4)", maxWidth: 520, lineHeight: 1.6 }}>{body}</span>
    </div>
  );
  if (head && !head.available) {
    return head.reason === "unreachable"
      ? cantRead("The router's logs didn't answer in time.", <>Try again, or pick a shorter range. The counts above come from Prometheus and work without them.</>)
      : cantRead("This list can't read the router's logs.", <>
          It reads them from Loki (the log store). Set <span className="gw-mono">LOKI_URL</span> on the API to your Loki - the compose{" "}
          <span className="gw-mono">logs</span> profile runs one - and check that it is up. The counts above come from Prometheus and work without it.
        </>);
  }
  if (first.error && !head) {
    return cantRead("The request list couldn't be loaded.", <>The API didn&apos;t answer. The list tries again on its next refresh.</>);
  }

  return (
    <div ref={listRef} className="gw-card" style={{ padding: 0, overflow: "hidden", scrollMarginTop: 16 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "grid", gap: 10 }}>
        {/* What the list holds: how many, what came of them, and the times it covers. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
            Requests with an error<Tip text={TT.errorRequests!} />
            {head && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>{fmtComma(rows.length)}{rows.length !== allRows.length ? ` of ${fmtComma(allRows.length)}` : ""}</span>}
            <span style={{ marginLeft: 8, display: "inline-flex" }}><Refreshing show={log.refreshing} label="Reading newer requests" /></span>
            {held && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>· paused while a row is open</span>}
          </span>
          <Seg
            value={result}
            onChange={reset(setResult)}
            options={[
              // No counts before the first read lands: a 0 there would be a claim.
              { key: ALL, label: "All", count: head ? narrowed.length : undefined },
              ...RESULT_ORDER.filter((k) => !RARE.has(k) || byResult(k) > 0)
                .map((k) => ({ key: k, label: RESULT[k].label, count: head ? byResult(k) : undefined, color: RESULT[k].color, title: RESULT[k].hint })),
            ]}
          />
          <span style={{ flex: 1 }} />
          <TimeRangeControl
            range={range}
            onChange={(r) => { list.pick(r); setPage(0); }}
            windowLabel={WINDOWS[win].label}
            windowMs={WINDOWS[win].rangeSeconds * 1000}
          />
        </div>
        {/* Narrowing it down, and finding one request. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <select aria-label="Retryable" value={retry} onChange={(e) => reset(setRetry)(e.target.value as RetryFilter)} style={narrowSelect}>
            <option value={ALL}>Retryable or not</option>
            <option value="retryable">Retryable ({fmtComma(kinds.filter((k) => k.retryable).length)})</option>
            <option value="not-retryable">Not retryable ({fmtComma(kinds.filter((k) => k.notRetryable).length)})</option>
          </select>
          <select aria-label="Error type" value={errType} onChange={(e) => reset(setErrType)(e.target.value)} style={narrowSelect} disabled={!errTypes.length}>
            <option value={ALL}>All error types</option>
            {errTypes.map((t) => <option key={t.key} value={t.key}>{t.label} ({fmtComma(t.count)})</option>)}
          </select>
          <select aria-label="Customer" value={customer} onChange={(e) => reset(setCustomer)(e.target.value)} style={narrowSelect} disabled={!customers.length && customer === ALL}>
            <option value={ALL}>All customers</option>
            {customers.map((c) => <option key={c.key} value={c.key}>{c.label} ({fmtComma(c.count)})</option>)}
          </select>
          <select aria-label="Method" value={method} onChange={(e) => reset(setMethod)(e.target.value)} style={narrowSelect} disabled={!methods.length}>
            <option value={ALL}>All methods</option>
            {methods.map((m) => <option key={m} value={m}>{m === "unknown" ? "method not in the logs" : m}</option>)}
          </select>
          <select aria-label="Upstream" value={upstream} onChange={(e) => { onUpstream(e.target.value); setPage(0); }} style={narrowSelect} disabled={!upstreams.length && upstream === ALL}>
            <option value={ALL}>All upstreams</option>
            {upstream !== ALL && !upstreams.some((u) => u.name === upstream) && <option value={upstream}>{upstream}</option>}
            {upstreams.map((u) => <option key={u.name} value={u.name}>{u.name} ({fmtComma(u.count)})</option>)}
          </select>
          <span style={{ flex: 1 }} />
          <IdSearch onFind={find} />
        </div>
        {range && (
          <div style={{ fontSize: 11, color: "var(--text-4)" }}>
            This list covers the times you picked. The cards above still cover the last {WINDOWS[win].label}.
          </div>
        )}
      </div>
      <ReadingStrip show={first.isLoading} rangeWords={range ? "for the times you picked" : `for the last ${WINDOWS[win].label}`} />
      <UnreadStrip count={log.unread} noun="request" bound={!!chainFilter || !!routerIdQ || !!barQ} covers="the list" />
      {lookupId && (
        <LookupPanel key={lookupId + rangeQ} id={lookupId} rangeQ={rangeQ} rangeWords={range ? "of the times you picked" : `of the last ${WINDOWS[win].label}`}
          onClose={() => find(null)} />
      )}

      {/* Below 860px the columns would overlap: scroll sideways instead. */}
      <div style={{ overflowX: "auto" }}>
        <table className="gw-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 860 }}>
          <colgroup>
            <col style={{ width: 150 }} />
            <col style={{ width: "20%" }} />
            <col />
            <col style={{ width: 170 }} />
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Time · customer</th>
              <th>Chain · method</th>
              <th>What happened</th>
              <th>Result</th>
              <th style={{ textAlign: "right" }}>Took</th>
            </tr>
          </thead>
          <tbody>
            {first.isLoading && <SkelRows rows={6} cols={LOG_SKEL_COLS} />}
            {pageRows.map((r) => {
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
                        </div>
                      </div>
                    </td>
                    <td style={{ maxWidth: 0 }}>
                      <Flow attempts={r.attempts} end={stopMarker(r)} replyColor={RESULT[r.result].color} quietReplied={r.result === "error-reply"} />
                      <AppGot text={appGot(r)} />
                    </td>
                    <td style={{ verticalAlign: "top" }}>
                      <ResultTag row={r} />
                      {resultBadge(r).from && <ResponseSource {...resultBadge(r).from!} />}
                    </td>
                    <td style={{ textAlign: "right", verticalAlign: "top" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtTook(r.totalMs)}</span></td>
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
            {head && rows.length === 0 && !log.loadingOlder && (
              <tr><td colSpan={5} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>
                {!allRows.length && log.unread ? "None of the requests found in this range came back from the logs in time."
                  : onBar
                  ? <>No client requests failed at <span className="gw-mono">{upstream}</span> in this period. The bar also counts the router&apos;s internal relays (startup and health checks), which this list excludes.</>
                  : allRows.length ? "No requests match these filters."
                  : log.more ? "No requests with errors in the part of this period read so far."
                  : range ? "No requests with errors in this period." : `No requests with errors in the last ${WINDOWS[win].label}.`}
                {log.more ? " Older ones may: load them below." : ""}
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
        noun="requests"
        onPage={setPage}
        more={log.more ? { loading: log.loadingOlder, failed: log.olderFailed, onLoad: log.loadOlder } : null}
      />
    </div>
  );
}
