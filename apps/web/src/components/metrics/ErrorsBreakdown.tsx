"use client";

/* Errors tab - what went wrong, where, and what the app got. The count cards
 * run from an upstream failing to the client seeing it: failed attempts
 * (/api/metrics/errors), then the router's retry counters
 * (/api/metrics/retries). Below them, every request that hit an error, one
 * row each, from the router's logs (ErrorRequests, /api/error-requests). Its
 * filters - the result, retryable or not, the error type, the method, the
 * upstream - answer what the Upstreams and Error types views used to, with
 * the requests themselves behind every count, so those views are gone. A bar
 * on the Upstreams tab's "Errors over time" opens the tab on its own
 * requests (ErrorsJump). */

import { useRef, useState } from "react";
import type { ErrorIncidentLine, ErrorsReport, MetricWindow, RetriesReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { fmtComma, fmtPct } from "@/lib/format";
import { TT } from "@/lib/tooltips";
import { ALL, ErrorRequests, useErrorList } from "./ErrorRequests";
import { ErrorIncidents, KIND, SHAPE, lineTitle } from "./ErrorIncidents";
import { rangeWords } from "./request-log";
import type { ExactRange } from "./request-log";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useRouterFilter } from "@/hooks/use-router-options";
import { SkelLine, SkelValue } from "@/components/gateway/Skel";
import { Tip } from "@/components/gateway/Tip";

/** One upstream's requests over exact times (unix ms) - what a click
 *  elsewhere opens this tab on. `spec` is its chain. */
export interface ErrorsJump {
  spec: string;
  upstream: string;
  from: number;
  to: number;
}

/** The list's upstream filter (null = all) and exact times (null = the window). */
export interface ErrorsFocus {
  upstream: string | null;
  range: ExactRange | null;
}

export function ErrorsBreakdown({ chainFilter, win, focus = null, onFocus }: {
  chainFilter: string | null;
  win: MetricWindow;
  /** Open on an upstream's requests, or exact times, instead of the window - a bar's, or a link's. */
  focus?: ErrorsFocus | null;
  /** Told when either changes here - the page keeps them in its URL. */
  onFocus?: (f: ErrorsFocus) => void;
}) {
  const [upstream, setUpstream] = useState(focus?.upstream ?? ALL);
  const initialRange = focus?.range ?? null;
  const report = (u: string, range: ExactRange | null) => onFocus?.({ upstream: u === ALL ? null : u, range });
  /* The timeline line the list is narrowed to, with the times it opened on.
     A line of several providers - chain-wide, or one that ran long - also
     narrows the list to its chain; one provider's, to that provider. Picking
     other times in the list lets go of the line and of its chain. */
  const [opened, setOpened] = useState<{ line: ErrorIncidentLine; range: ExactRange } | null>(null);
  const lineSpec = opened && opened.line.providers.length > 1 ? opened.line.chains[0]?.spec ?? null : null;
  const onPick = (r: ExactRange | null) => {
    report(upstream, r);
    setOpened((o) => (o && r && r.from === o.range.from && r.to === o.range.to ? o : null));
  };
  // The request list's reads, held here: the "Still failed" card counts its rows.
  const list = useErrorList({ chainFilter: chainFilter ?? lineSpec, win, upstream, initialRange, lineRange: opened?.range ?? null, onPick });
  const pickUpstream = (u: string) => { setUpstream(u); report(u, list.range); };
  // Bumped on each line opened: the list then groups that line's requests by error.
  const [groupNonce, setGroupNonce] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  // Still on the line's times: another range picked in the list is no longer the line.
  const onLine = opened && list.range && list.range.from === opened.range.from && list.range.to === opened.range.to ? opened : null;
  const openLine = (line: ErrorIncidentLine, stepSec: number) => {
    // A line still going runs to the click, not to its last full stretch: its newest requests are in the read.
    const range = { from: (line.start - stepSec) * 1000, to: line.ongoing ? Date.now() : Math.min(line.end * 1000, Date.now()) };
    const u = line.providers.length === 1 ? line.providers[0]! : ALL;
    setOpened({ line, range });
    list.pick(range);
    setUpstream(u);
    report(u, range);
    setGroupNonce((n) => n + 1);
    requestAnimationFrame(() => listRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const closeLine = () => {
    setOpened(null);
    list.pick(null);
    setUpstream(ALL);
    report(ALL, null);
    timelineRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  const { scopeQ } = useFilters();
  // The failed-tries card counts (chain × upstream) pairs, so the router
  // filter CAN narrow it - the api resolves the upstream against the values
  // file.
  const { routerIdQ } = useRouterFilter();
  const { data, isLoading } = useApi<ErrorsReport>(`/api/metrics/errors?window=${win}${specQ}${routerIdQ}${scopeQ}`);
  // Once a minute: each read counts retries back to their counters' births.
  const counts = useApi<RetriesReport>(`/api/metrics/retries?window=${win}${specQ}${scopeQ}`, 60_000);

  const total = data?.total ?? 0;

  const c = counts.data;
  const emitted = c?.emitted ?? false;
  // The router counts a retry only once two tries have come back, so a
  // request it couldn't retry (no upstream left, a try that never answered)
  // is only in the logs. When the list below shows more, the card says so -
  // while the list covers the cards' window: the rows it has loaded.
  // Only the ones it meant to retry: a transaction is never retried by design.
  const logs = list.range === null && list.log.head?.available ? list.log : null;
  const logFailed = (logs?.rows ?? []).filter((r) => r.result === "failed" && (r.retried || r.exhausted)).length;
  const failedNote = logs && logFailed > (c?.failed ?? 0)
    ? <span style={{ color: "var(--warn)" }}>{fmtComma(logFailed - (c?.failed ?? 0))}{logs.more ? "+" : ""} more in the list below that the retry counter misses: only one attempt returned</span>
    : null;
  /* What the client saw first, then what the router did about the rest: the
     order someone debugging asks in. One number format on all four. */
  const count = (v: number | null | undefined) => (v == null ? "—" : fmtComma(v));
  const kpis: { label: string; tipKey: string; value: string; color: string; sub: React.ReactNode; loading: boolean }[] = [
    { label: "Still failed", tipKey: "retryFailed", value: count(c?.failed), loading: counts.isLoading,
      // A zero here is not an all-clear, so it isn't green: the card counts
      // retried requests only, and a provider's error reply goes back to the
      // client without a retry - the list below shows those.
      color: c?.failed ? "var(--err)" : emitted || failedNote ? "var(--text)" : "var(--text-4)",
      sub: failedNote ?? (emitted ? (c?.failed ? <>returned to the client as an error after all retries</> : <>of the retried requests. Provider errors returned as they are: in the list</>) : <>&nbsp;</>) },
    { label: "Recovered", tipKey: "retryRecovered", value: count(c?.recovered), color: emitted ? "var(--ok)" : "var(--text-4)", loading: counts.isLoading,
      sub: emitted && c?.recoveryRate != null ? <>{fmtPct(c.recoveryRate, 1)} of retried requests received a response</> : <>&nbsp;</> },
    { label: "Retried requests", tipKey: "retriedRequests", value: count(c?.retried), color: emitted ? "var(--text)" : "var(--text-4)", loading: counts.isLoading,
      sub: !emitted ? "no retries recorded yet"
        : <>{fmtPct(c?.retryRate)} of all requests</> },
    { label: "Failed attempts", tipKey: "failedTries", value: fmtComma(total), color: total ? "var(--text)" : "var(--ok)", loading: isLoading,
      sub: <>attempts at a provider, not requests</> },
  ];

  return (
    <div style={{ paddingTop: 8 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 12, marginBottom: 16 }}>
        {kpis.map((k) => (
          <div key={k.label} className="gw-card" style={{ padding: "13px 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              {k.label}<Tip text={TT[k.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, color: k.color, marginTop: 7 }}>
              {k.loading ? <SkelValue h={25} w={96} /> : k.value}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6, minHeight: "1.5em" }}>
              {k.loading ? <SkelLine w={176} /> : k.sub}
            </div>
          </div>
        ))}
      </div>

      <div ref={timelineRef} style={{ scrollMarginTop: 72 }}>
        <ErrorIncidents chainFilter={chainFilter} win={win} openKey={onLine?.line.key ?? null} onOpen={openLine} />
      </div>

      <div ref={listRef} style={{ scrollMarginTop: 72 }}>
        {onLine && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 8, fontSize: 12, borderRadius: 8, border: "1px solid var(--line)" }}>
            <span style={{ color: KIND[onLine.line.kind].color }}>{SHAPE[onLine.line.shape].label}</span>
            <span style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lineTitle(onLine.line)}</span>
            <span className="gw-tnum" style={{ color: "var(--text-4)", whiteSpace: "nowrap" }}>{rangeWords(onLine.range)}</span>
            <button className="gw-btn" style={{ marginLeft: "auto", padding: "3px 10px", fontSize: 11.5, whiteSpace: "nowrap" }} onClick={closeLine}>← Back to the timeline</button>
          </div>
        )}
        <ErrorRequests chainFilter={chainFilter ?? lineSpec} win={win} upstream={upstream} onUpstream={pickUpstream}
          initialRange={initialRange} list={list} groupNonce={groupNonce} />
      </div>
    </div>
  );
}
