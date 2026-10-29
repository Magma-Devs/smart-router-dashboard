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

import { useState } from "react";
import type { ErrorsReport, MetricWindow, RetriesReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { fmtComma, fmtNum, fmtPct } from "@/lib/format";
import { TT } from "@/lib/tooltips";
import { ALL, ErrorRequests, useErrorList } from "./ErrorRequests";
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
  // The request list's reads, held here: the "Still failed" card counts its rows.
  const list = useErrorList({ chainFilter, win, upstream, initialRange, onPick: (r) => report(upstream, r) });
  const pickUpstream = (u: string) => { setUpstream(u); report(u, list.range); };

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
  const kpis: { label: string; tipKey: string; value: string; color: string; sub: React.ReactNode; loading: boolean }[] = [
    { label: "Failed attempts", tipKey: "failedTries", value: fmtComma(total), color: total ? "var(--text)" : "var(--ok)", loading: isLoading,
      sub: <>&nbsp;</> },
    { label: "Retried requests", tipKey: "retriedRequests", value: fmtNum(c?.retried), color: emitted ? "var(--text)" : "var(--text-4)", loading: counts.isLoading,
      sub: !emitted ? "no retries recorded yet"
        : <>{fmtPct(c?.retryRate)} of all requests</> },
    { label: "Recovered", tipKey: "retryRecovered", value: fmtNum(c?.recovered), color: emitted ? "var(--ok)" : "var(--text-4)", loading: counts.isLoading,
      sub: emitted && c?.recoveryRate != null ? <>{fmtPct(c.recoveryRate, 1)} of retried requests received a response</> : <>&nbsp;</> },
    { label: "Still failed", tipKey: "retryFailed", value: fmtNum(c?.failed), loading: counts.isLoading,
      color: c?.failed ? "var(--err)" : failedNote ? "var(--text)" : emitted ? "var(--ok)" : "var(--text-4)",
      sub: failedNote ?? (emitted ? <>failed after all retries</> : <>&nbsp;</>) },
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

      <ErrorRequests chainFilter={chainFilter} win={win} upstream={upstream} onUpstream={pickUpstream}
        initialRange={initialRange} list={list} />
    </div>
  );
}
