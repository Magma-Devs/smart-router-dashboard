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
import { WINDOWS, WRITE_UNKNOWN_NOTE, buildChainMetaByIndex, explainRouterError, type ErrorRequestRow, type ErrorRequestsReport, type MetricWindow, type RequestLookup } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useLogReads } from "@/hooks/use-log-reads";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Refreshing, SkelLine, SkelRows } from "@/components/gateway/Skel";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { Tip } from "@/components/gateway/Tip";
import { TT } from "@/lib/tooltips";
import { fmtComma } from "@/lib/format";
import { linkRequest, requestFromUrl } from "@/lib/request-in-url";
import { groupBuckets, groupErrors, type ErrorGroup } from "@/lib/error-groups";
import {
  appGot,
  customerOptions,
  hasCustomer,
  LOOKUP_REFUSED,
  MatchesNote,
  errorLabel,
  errorTypeOptions,
  FilterSelect,
  NewRowsStrip,
  useHeldRows,
  WhenCell,
  stickyListHeader,
  useListHeadHeight,
  filterSelectStyle,
  Flow,
  fmtTook,
  hasErrorType,
  chainWords,
  chainsTitle,
  IdSearch,
  LOG_SKEL_COLS,
  ResultCell,
  LookupFrame,
  NotFound,
  OlderRowsLoading,
  onRowKey,
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
    hint: "Served by a provider; no attempt failed.",
  },
  recovered: {
    label: "Recovered",
    color: "var(--ok)",
    hint: "An attempt failed; a later attempt at another provider succeeded.",
  },
  "error-reply": {
    label: "Provider error",
    color: "var(--warn)",
    hint: "Provider error: the provider answered with an error (for example invalid params, internal error, pruned data, no archive access). It was returned to the client unchanged.",
  },
  failed: {
    label: "Router error",
    color: "var(--err)",
    hint: "Router error: no provider returned a usable response (timeouts, connection errors, rate limits, HTTP 5xx), so the router returned its own error, typically \"insufficient results\".",
  },
  // The Transactions tab's "Outcome unknown", in its words: the same request reads the same on both tabs.
  "write-unknown": { label: "Outcome unknown", color: "var(--text-4)", hint: `Outcome unknown: ${WRITE_UNKNOWN_NOTE}` },
  unknown: { label: "No end logged", color: "var(--text-4)", hint: "No end logged: the request may still be in flight, or the client disconnected." },
};
const RESULT_ORDER: ErrorRequestRow["result"][] = ["recovered", "error-reply", "failed", "write-unknown", "unknown"];
/** The list's opening filter, before anyone picks one: the requests whose
 *  error reached the client when there are any, else every request. Someone
 *  debugging asks first what the client saw, and a list that opens on
 *  hundreds of recovered requests buries it. */
const AUTO = "auto";
/** The pill for every result the client received as an error or without a clear end. */
const REACHED = "reached";
const REACHED_CLIENT: ReadonlySet<ErrorRequestRow["result"]> = new Set(["error-reply", "failed", "write-unknown"]);
type ResultPick = ErrorRequestRow["result"] | typeof ALL | typeof REACHED;
/** Rare results: a pill only while the list holds one. */
const RARE: ReadonlySet<ErrorRequestRow["result"]> = new Set(["write-unknown", "unknown"]);

/**
 * The result the list shows before anyone picks one: the requests that
 * reached the client when there are any, else every request. Opened from a
 * bar on the Upstreams tab, every request: the bar counts each failed try at
 * its provider, recovered or not, and the click promised its requests.
 */
export function openingResult(reachedCount: number, fromBar: boolean): typeof ALL | typeof REACHED {
  return reachedCount > 0 && !fromBar ? REACHED : ALL;
}

/**
 * The line above a list none of whose requests reached the client. Under a
 * filter it speaks for the filtered requests only. It calls the requests
 * recovered only when they were: one with no end in the logs may still be
 * running, or its client may have gone.
 */
export function nothingReachedWords(rows: readonly Pick<ErrorRequestRow, "result">[], filtered: boolean, period: string): string {
  const head = filtered ? `None of these requests reached the client ${period}.` : `No error reached the client ${period}.`;
  const noEnd = rows.filter((r) => r.result === "unknown").length;
  if (!noEnd) return `${head} The requests below hit an error on the way and were recovered.`;
  if (noEnd === rows.length) return `${head} The requests below hit an error on the way, and the logs show no end for them.`;
  return `${head} The requests below hit an error on the way: ${fmtComma(noEnd)} with no end in the logs, the rest recovered.`;
}

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
 * The error the client got, once, under the Result tag: the provider's own
 * words for a provider error ("pending state is not supported"), the router's
 * by its own name for a router error ("Insufficient results"). Who sent it is
 * the chip marked "→ client"; the opened row has the full text and what the
 * error means. Null when the client got an answer.
 */
export function resultError(r: ErrorRequestRow): string | null {
  if (r.result === "error-reply") {
    const a = r.attempts.find((x) => x.replied);
    return appGot(r) ?? (a ? errorLabel(a) : null);
  }
  if (r.result === "failed") return routerReason(r);
  if (r.result === "write-unknown") return r.error;
  return null;
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
  // The list's own words, so a row reads the same opened and closed.
  const { label, color } = RESULT[r.result];
  if (r.result === "write-unknown") return { label, color: "var(--text-3)", detail: "May have been sent. Look up the hash before signing a new one." };
  return { label, color: r.result === "unknown" ? "var(--text-3)" : color };
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

/** The kind of result as a tag, its meaning on hover. */
function ResultTag({ row }: { row: ErrorRequestRow }) {
  const res = RESULT[row.result];
  return <span className="gw-tag" title={res.hint} style={{ fontSize: 10, color: res.color, borderColor: "currentColor" }}>{res.label}</span>;
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
export function useErrorList({ chainFilter, win, upstream, initialRange = null, onPick }: {
  chainFilter: string | null;
  win: MetricWindow;
  upstream: string;
  initialRange?: ExactRange | null;
  /** Told when the list's times are picked or cleared - the page keeps them in its URL. */
  onPick?: (r: ExactRange | null) => void;
}) {
  const [range, setRange] = useState<ExactRange | null>(initialRange);
  // A picked range that has closed can't change: read it once, don't poll it.
  const [live, setLive] = useState(() => rangeIsLive(initialRange));
  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  const { routerIdQ } = useRouterFilter();
  const rangeQ = range ? `from=${Math.round(range.from)}&to=${Math.round(range.to)}` : `window=${win}`;
  // On a bar's times with an upstream picked, the read itself is narrowed to
  // that upstream, so the cap applies to the requests the bar counts.
  const onBarRange = initialRange != null && range != null && range.from === initialRange.from && range.to === initialRange.to;
  const barQ = onBarRange && upstream !== ALL ? `&upstream=${encodeURIComponent(upstream)}` : "";
  const log = useLogReads<ErrorRequestRow, ErrorRequestsReport>(`/api/error-requests?${rangeQ}${specQ}${routerIdQ}${barQ}`, live);
  const pick = (r: ExactRange | null) => { setRange(r); setLive(rangeIsLive(r)); onPick?.(r); };
  return { log, range, pick, rangeQ, routerIdQ, onBarRange, barQ };
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
  const [picked, setResult] = useState<ResultPick | typeof AUTO>(AUTO);
  const [retry, setRetry] = useState<RetryFilter>(ALL);
  const [errType, setErrType] = useState(ALL);
  const [customer, setCustomer] = useState(ALL);
  const [method, setMethod] = useState(ALL);
  const [open, setOpen] = useState<string | null>(null);
  // A request named in the URL opens looked up.
  const [lookupId, setLookupId] = useState<string | null>(requestFromUrl);
  const [page, setPage] = useState(0);
  /* Grouped (the default) or every request; and the one group opened, by key. */
  const [grouped, setGrouped] = useState(true);
  const [groupKey, setGroupKey] = useState<string | null>(null);
  // Back / Forward: the look-up follows the URL.
  useEffect(() => {
    const onPop = () => setLookupId(requestFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  // The URL names the request last opened or found that is still in view.
  const find = (id: string | null) => { setLookupId(id); linkRequest(id ?? open); };
  const toggleRow = (guid: string) => { const next = open === guid ? null : guid; setOpen(next); linkRequest(next ?? lookupId); };

  const { log, range, rangeQ, routerIdQ, onBarRange, barQ } = list;

  // Another chain or router is another list: what was open on the last one closes.
  const scopeKey = `${chainFilter ?? ""}|${routerIdQ}`;
  const [shownScope, setShownScope] = useState(scopeKey);
  if (shownScope !== scopeKey) { setShownScope(scopeKey); setOpen(null); setLookupId(null); setPage(0); }
  useEffect(() => { if (!open && !lookupId) linkRequest(null); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const { first, head } = log;
  const held = useHeldRows(log.rows, open);
  const [headRef, headVar] = useListHeadHeight();
  const allRows = held.rows;

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
  const reachedCount = narrowed.filter((r) => REACHED_CLIENT.has(r.result)).length;
  // On a bar's times with its provider picked, the list opens on every request the bar counts.
  const fromBar = onBarRange && upstream !== ALL;
  const result: ResultPick = picked === AUTO ? openingResult(reachedCount, fromBar) : picked;
  const inResult = (r: ErrorRequestRow) => result === ALL || (result === REACHED ? REACHED_CLIENT.has(r.result) : r.result === result);
  const filtered = narrowed.filter(inResult);
  // 300 rows at most: grouping them on each render costs less than a memo's bookkeeping.
  const groups = groupErrors(filtered);
  const openGroup = groupKey ? groups.find((g) => g.key === groupKey) ?? null : null;
  // An opened group lists its own requests; a filter that empties it shows the rest again.
  const rows = openGroup ? openGroup.rows : filtered;
  const showGroups = grouped && !openGroup && rows.length > 0;
  /* Under the opening filter, recovered requests are hidden: a provider the
     router kept working around is still worth a line. */
  const hiddenRecovered = result === REACHED ? narrowed.filter((r) => r.result === "recovered") : [];
  const byResult = (k: ErrorRequestRow["result"]) => narrowed.filter((r) => r.result === k).length;
  const kinds = byDropdowns.filter(inResult).map(retryKinds);
  /* Nothing reached the client, and nobody has picked a result: the list
     says so above the requests it then shows. */
  const allRecovered = !!head && picked === AUTO && reachedCount === 0 && narrowed.length > 0;
  const dropdowns = retry !== ALL || errType !== ALL || customer !== ALL || method !== ALL || upstream !== ALL;

  const pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const curPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(curPage * PER_PAGE, (curPage + 1) * PER_PAGE);
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
  const onBar = onBarRange && upstream !== ALL && (result === ALL || picked === AUTO) && retry === ALL && errType === ALL && customer === ALL && method === ALL;
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
    <div ref={listRef} className="gw-card gw-log-card" style={{ padding: 0, overflow: "clip", scrollMarginTop: 72, ...headVar }}>
      <div ref={headRef} style={stickyListHeader}>
        {/* What the list holds: how many, what came of them, and the times it covers. */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
            Requests with an error<Tip text={TT.errorRequests!} />
            {head && <span style={{ fontWeight: 400, color: "var(--text-4)", marginLeft: 8 }}>{fmtComma(rows.length)}{rows.length !== allRows.length ? ` of ${fmtComma(allRows.length)}` : ""}</span>}
            <span style={{ marginLeft: 8, display: "inline-flex" }}><Refreshing show={log.refreshing} label="Reading newer requests" /></span>
          </span>
          <Seg
            value={result}
            onChange={reset(setResult)}
            options={[
              // No counts before the first read lands: a 0 there would be a claim.
              { key: ALL, label: "All", count: head ? narrowed.length : undefined },
              { key: REACHED, label: "Reached the client", count: head ? reachedCount : undefined, color: reachedCount ? "var(--err)" : "var(--ok)",
                title: "Reached the client: the client received an error, or a write whose outcome is unknown. Provider error, Router error and Outcome unknown together." },
              ...RESULT_ORDER.filter((k) => !RARE.has(k) || byResult(k) > 0)
                .map((k) => ({ key: k, label: RESULT[k].label, count: head ? byResult(k) : undefined, color: RESULT[k].color, title: RESULT[k].hint })),
            ]}
          />
          <span style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "var(--text-4)" }}>View</span>
          <Seg
            value={grouped ? "grouped" : "every"}
            onChange={(v) => { setGrouped(v === "grouped"); setGroupKey(null); setPage(0); }}
            options={[
              { key: "grouped", label: "Grouped", title: "One line per way requests failed: the error, who caused it, how many, when." },
              { key: "every", label: "Every request", title: "Every request on its own line, newest first." },
            ]}
          />
          </span>
          <TimeRangeControl
            range={range}
            onChange={(r) => { list.pick(r); setPage(0); }}
            windowLabel={WINDOWS[win].label}
            windowMs={WINDOWS[win].rangeSeconds * 1000}
          />
        </div>
        {/* Narrowing it down, and finding one request. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <FilterSelect aria-label="Retryable" value={retry} onChange={(e) => reset(setRetry)(e.target.value as RetryFilter)} style={narrowSelect}>
            <option value={ALL}>Retryable or not</option>
            <option value="retryable">Retryable ({fmtComma(kinds.filter((k) => k.retryable).length)})</option>
            <option value="not-retryable">Not retryable ({fmtComma(kinds.filter((k) => k.notRetryable).length)})</option>
          </FilterSelect>
          <FilterSelect aria-label="Error type" value={errType} onChange={(e) => reset(setErrType)(e.target.value)} style={narrowSelect} disabled={!errTypes.length}>
            <option value={ALL}>All error types</option>
            {errTypes.map((t) => <option key={t.key} value={t.key}>{t.label} ({fmtComma(t.count)})</option>)}
          </FilterSelect>
          <FilterSelect aria-label="Customer" value={customer} onChange={(e) => reset(setCustomer)(e.target.value)} style={narrowSelect} disabled={!customers.length && customer === ALL}>
            <option value={ALL}>All customers</option>
            {customers.map((c) => <option key={c.key} value={c.key}>{c.label} ({fmtComma(c.count)})</option>)}
          </FilterSelect>
          <FilterSelect aria-label="Method" value={method} onChange={(e) => reset(setMethod)(e.target.value)} style={narrowSelect} disabled={!methods.length}>
            <option value={ALL}>All methods</option>
            {methods.map((m) => <option key={m} value={m}>{m === "unknown" ? "method not in the logs" : m}</option>)}
          </FilterSelect>
          <FilterSelect aria-label="Provider" value={upstream} onChange={(e) => { onUpstream(e.target.value); setPage(0); }} style={narrowSelect} disabled={!upstreams.length && upstream === ALL}>
            <option value={ALL}>All providers</option>
            {upstream !== ALL && !upstreams.some((u) => u.name === upstream) && <option value={upstream}>{upstream}</option>}
            {upstreams.map((u) => <option key={u.name} value={u.name}>{u.name} ({fmtComma(u.count)})</option>)}
          </FilterSelect>
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

      {allRecovered && (
        <div style={{ padding: "9px 16px", fontSize: 12, color: "var(--text-2)", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
          {nothingReachedWords(narrowed, dropdowns, range ? "in this period" : `in the last ${WINDOWS[win].label}`)}
        </div>
      )}
      <NewRowsStrip count={held.newCount} noun="request" onShow={held.showNew} />
      {/* Below 860px the columns would overlap: scroll sideways instead. */}
      {openGroup && (
        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <span style={{ color: "var(--text-3)" }}>One group:</span>
          <span style={{ color: "var(--text)", fontWeight: 600 }}>{groupTitle(openGroup)}</span>
          <span className="gw-tnum" style={{ color: "var(--text-4)" }}>{fmtComma(openGroup.count)} request{openGroup.count === 1 ? "" : "s"}</span>
          <button className="gw-btn" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5 }} onClick={() => { setGroupKey(null); setPage(0); }}>← All groups</button>
        </div>
      )}
      {showGroups ? (
        <ErrorGroupsTable groups={groups} rows={rows} partial={log.more} windowLabel={range ? null : WINDOWS[win].label}
          hiddenRecovered={hiddenRecovered.length} hiddenRecoveredGroups={hiddenRecovered.length ? groupErrors(hiddenRecovered).length : 0}
          onShowRecovered={() => { setResult(ALL); setPage(0); }}
          onOpen={(k) => { setGroupKey(k); setPage(0); setOpen(null); }} />
      ) : (
      <>
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
              <th>Time · customer</th>
              <th>Chain · method</th>
              <th>What happened</th>
              <th>Result</th>
              <th style={{ textAlign: "right" }}>Response time</th>
            </tr>
          </thead>
          <tbody>
            {first.isLoading && <SkelRows rows={6} cols={LOG_SKEL_COLS} />}
            {pageRows.map((r) => {
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
                        </div>
                      </div>
                    </td>
                    <td style={{ maxWidth: 0 }}>
                      <Flow attempts={r.attempts} end={stopMarker(r)} replyColor={RESULT[r.result].color} quietReplied={r.result === "error-reply"} />
                    </td>
                    <td style={{ verticalAlign: "top", maxWidth: 0 }}>
                      <ResultCell {...RESULT[r.result]} error={resultError(r)} />
                    </td>
                    <td style={{ textAlign: "right", verticalAlign: "top" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12 }}>{fmtTook(r.totalMs)}</span></td>
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
      </>
      )}
      {!showGroups && <Pager
        page={curPage}
        pageCount={pageCount}
        total={rows.length}
        perPage={PER_PAGE}
        noun="requests"
        onPage={setPage}
        more={log.more ? { loading: log.loadingOlder, failed: log.olderFailed, onLoad: log.loadOlder } : null}
      />}
    </div>
  );
}

/** Who caused a group's error, in a few words: a provider's name, "The request", "All providers (2)". */
function causeWords(g: ErrorGroup): string {
  switch (g.cause) {
    case "request": return "The request";
    case "every-provider": return `All providers (${g.providerCount})`;
    case "all-failed": return `All providers (${g.providerCount})`;
    case "provider": return g.provider === "Cached" ? "Cache" : g.provider ?? "—";
    default: return "—";
  }
}

const CAUSE_HINT: Partial<Record<ErrorGroup["cause"], string>> = {
  request: "The router's code says the request itself caused it (invalid params, nonce too low, already known…): sending it to another provider would not help.",
  "every-provider": "Every provider the router tried gave this same error.",
  "all-failed": "Every provider the router tried failed, each in its own way: nothing usable came back.",
};

/** "Data not held at blockfrost on Cardano" - a group in one line. */
function groupTitle(g: ErrorGroup): string {
  const who = g.cause === "request" ? ", caused by the request" : g.cause === "provider" ? ` at ${g.provider === "Cached" ? "the cache" : g.provider}` : g.cause === "none" ? "" : " at every provider";
  const on = g.spec ? ` on ${buildChainMetaByIndex(g.spec).name}` : "";
  return `${g.errorLabel.charAt(0).toUpperCase()}${g.errorLabel.slice(1)}${who}${on}`;
}

const timeOf = (ms: number, secs = false) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", ...(secs ? { second: "2-digit" } : {}), hour12: false });

/** How long a span is, in words: "51 seconds", "4 minutes", "3 hours". */
function spanWords(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 120) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m} minutes`;
  return `${Math.round(m / 60)} hours`;
}

const BUCKETS = 24;

/**
 * The Errors list grouped: one line per way requests failed, the most first
 * ("every provider failed" pinned above). Each line says what the error was,
 * who caused it, how many requests, when, and whether the client received
 * it. The bars share one time span, so a burst shows as a burst and two at
 * the same minute line up. A click opens the group's requests in the list.
 */
function ErrorGroupsTable({ groups, rows, partial, windowLabel, hiddenRecovered, hiddenRecoveredGroups, onShowRecovered, onOpen }: {
  groups: ErrorGroup[];
  rows: ErrorRequestRow[];
  /** The list holds only the newest requests of the period: the groups cover those. */
  partial: boolean;
  /** The page window's words ("12 hours"), or null on picked times. */
  windowLabel: string | null;
  /** Recovered requests the opening filter hides, and how many groups they make. */
  hiddenRecovered: number;
  hiddenRecoveredGroups: number;
  onShowRecovered: () => void;
  onOpen: (key: string) => void;
}) {
  const times = rows.map((r) => r.time).filter(Number.isFinite);
  const from = Math.min(...times);
  const to = Math.max(...times);
  const short = to - from < 15 * 60_000;
  const peak = Math.max(1, ...groups.map((g) => Math.max(...groupBuckets(g.rows, from, to, BUCKETS))));
  return (
    <div>
      {/* What the groups cover, before anything else: the list reads the newest
          requests first, and on a busy deployment 300 of them is a minute. */}
      <div style={{ padding: "9px 16px", borderTop: "1px solid var(--line)", fontSize: 12, color: partial ? "var(--text)" : "var(--text-2)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {partial && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 }} />}
        <span>
          {fmtComma(rows.length)} request{rows.length === 1 ? "" : "s"} in {fmtComma(groups.length)} group{groups.length === 1 ? "" : "s"},
          {" "}from {timeOf(from, short)} to {timeOf(to, short)}
          {partial ? <> - the newest {spanWords(to - from)}{windowLabel ? ` of the last ${windowLabel}` : " of the times you picked"}. Load older requests below the list to group more.</> : "."}
        </span>
      </div>
      <div className="gw-log-scroll">
        <table className="gw-table" style={{ tableLayout: "fixed", width: "100%", minWidth: 860 }}>
          <colgroup>
            <col style={{ width: "34%" }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 280 }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>Error</th>
              <th>Caused by</th>
              <th style={{ textAlign: "right" }}>Requests</th>
              <th>When <span style={{ fontWeight: 400, color: "var(--text-4)", textTransform: "none", letterSpacing: 0 }}>{timeOf(from, short)} - {timeOf(to, short)}</span></th>
              <th>Client</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const bars = groupBuckets(g.rows, from, to, BUCKETS);
              const open = () => onOpen(g.key);
              const methods = g.methods.length === 1 ? g.methods[0]!.method : `${g.methods.length} methods`;
              return (
                <tr key={g.key} tabIndex={0} className="gw-logrow" onClick={open} onKeyDown={onRowKey(open)} title="Show these requests">
                  <td style={{ maxWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {g.spec && <span style={{ display: "flex", flexShrink: 0 }}><ChainBadge spec={g.spec} size={16} /></span>}
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={g.errorLabel}>
                          {g.errorLabel.charAt(0).toUpperCase() + g.errorLabel.slice(1)}
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          title={g.methods.map((m) => `${m.method}: ${fmtComma(m.count)}`).join("\n")}>
                          {g.spec ? buildChainMetaByIndex(g.spec).name : "chain not in the logs"} · <span className={g.methods.length === 1 ? "gw-mono" : undefined}>{methods}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td style={{ maxWidth: 0 }}>
                    <span className={g.cause === "provider" ? "gw-mono" : undefined} title={CAUSE_HINT[g.cause]}
                      style={{ fontSize: 12, color: "var(--text)", fontWeight: g.cause === "all-failed" ? 600 : 400 }}>{causeWords(g)}</span>
                  </td>
                  <td className="gw-tnum" style={{ textAlign: "right", fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{fmtComma(g.count)}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "flex-end", gap: 1, height: 20, borderBottom: "1px solid var(--line)" }} aria-hidden>
                      {bars.map((b, k) => (
                        <span key={k} style={{ flex: 1, height: b ? Math.max(3, Math.round((b / peak) * 20)) : 0, background: b ? "var(--text-3)" : "transparent", opacity: 0.7, borderRadius: 1 }} />
                      ))}
                    </div>
                  </td>
                  <td>
                    <span title={g.noEnd ? RESULT.unknown.hint : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-2)" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: g.reached ? "var(--err)" : g.noEnd ? "var(--text-4)" : "var(--ok)", flexShrink: 0 }} />
                      {g.reached ? "Reached the client" : g.noEnd ? RESULT.unknown.label : "Recovered"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hiddenRecovered > 0 && (
        <div style={{ padding: "9px 16px", fontSize: 12, color: "var(--text-2)", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
          Also {fmtComma(hiddenRecovered)} recovered request{hiddenRecovered === 1 ? "" : "s"} in {fmtComma(hiddenRecoveredGroups)} group{hiddenRecoveredGroups === 1 ? "" : "s"}: a provider failed and the router answered from another.
          <button className="gw-btn" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5 }} onClick={onShowRecovered}>Show them</button>
        </div>
      )}
    </div>
  );
}
