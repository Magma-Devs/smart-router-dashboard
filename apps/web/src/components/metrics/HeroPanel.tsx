"use client";

/* HeroPanel - the Metrics·Overview cards: what the router did for
 * reliability over the window. Six cards, each a number a client can check:
 *
 *   Requests answered   answered ÷ (answered + failed), written so it never
 *                       reads 100% while a request failed
 *   Downtime avoided    how long a provider was failing while its chain kept
 *                       answering (/api/metrics/downtime-avoided)
 *   Saved by retry      failed at one provider, answered on a retry
 *   Failed requests     the client got the router's error
 *   Out-of-date answers blocked   a provider behind the chain, asked again
 *   Answered from cache share of reads with no provider call
 *
 * Under a number, one short fact at most (what it is a share of, how many
 * incidents): what a card means is in its tooltip, not under it.
 *
 * Live from /api/metrics/dashboard-summary; null values render "—" in the
 * design's muted colour with an honest sub-line, never an invented number.
 * "Failed requests" is counted from the router's logs
 * (/api/error-requests/count) - the log store's recorded counts of them, or
 * the lines themselves: no metric counts it, so without them it says so, and
 * "Requests answered" with it. */

import type { DowntimeAvoidedReport, FailedRequests, HeroSummary, MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useRouterFilter } from "@/hooks/use-router-options";
import { Tip } from "@/components/gateway/Tip";
import { SkelValue, SkelLine } from "@/components/gateway/Skel";
import { TT } from "@/lib/tooltips";
import { fmtNum } from "@/lib/format";
import { fmtDay } from "@/lib/datetime";
import { answeredWords, incidentsWords, spanWords } from "@/lib/reliability";

interface Card {
  key: string;
  label: string;
  tipKey: string;
  value: React.ReactNode;
  color: string;
  sub: React.ReactNode;
  /** Its own read is still out: a ghost in place of the value. */
  loading?: boolean;
  /** Its own read is refreshing: dimmed on its own. */
  dim?: boolean;
}

export function HeroPanel({ tw, spec }: { tw: MetricWindow; spec?: string | null }) {
  const { scopeQ } = useFilters();
  const { routerIdQ } = useRouterFilter();
  const specQ = spec ? `&spec=${encodeURIComponent(spec)}` : "";
  const { data, isLoading } = useApi<HeroSummary>(`/api/metrics/dashboard-summary?window=${tw}${specQ}${scopeQ}`);
  // Skeletons only with nothing to show. On a window change the previous
  // window's values stay up, dimmed, until the next ones land.
  const showSkeleton = isLoading && !data;
  const refreshing = isLoading && !!data;

  const retries = data?.retriesRecovered.value ?? null;   // count (null until family fires)
  const cachePct = data?.cacheOffloadPct.value ?? null;   // ratio 0..1 (null until family fires)
  const reqServed = data?.requestsServed.value ?? null;
  const stale = data?.staleCaught.value ?? null;
  // Once a minute: the count moves slowly, and without recorded counts it
  // scans the window's logs. With the served count scoped to a router, the
  // failed count is scoped to it too.
  const failed = useApi<FailedRequests>(`/api/error-requests/count?window=${tw}${specQ}${scopeQ ? routerIdQ : ""}`, 60_000);
  const failedSkeleton = failed.isLoading && !failed.data;
  const failedRefreshing = failed.isLoading && !!failed.data;
  const failedN = failed.data?.available ? failed.data.value : null;
  // Recorded counts that start inside the window count from there.
  const failedSince = failed.data?.available && failed.data.since ? fmtDay(failed.data.since) : null;
  // Why the failed count can't be read, in the card's words; null when it can.
  const failedWhy = failed.error && !failed.data ? "couldn't load the count"
    : failed.data && !failed.data.available
      ? failed.data.reason === "shared-chain" ? "not split per router on a chain several routers serve"
      : failed.data.reason === "unreachable" ? "the router's logs didn't answer in time"
      : failed.data.reason === "too-large" ? "too many log lines to count in this window - pick a shorter one"
      : "requires the router's logs (LOKI_URL)"
    : null;
  // "Requests served" counts the requests the router answered; the ones it
  // gave up on aren't in it, so together they are every request - over the
  // same stretch only, so not when the failed count starts later.
  const answered = failedSince == null && failedN != null && reqServed != null ? answeredWords(reqServed, failedN) : null;

  const downtime = useApi<DowntimeAvoidedReport>(`/api/metrics/downtime-avoided?window=${tw}${specQ}${routerIdQ}${scopeQ}`, 60_000);
  // Only an answer in the report's shape: an api without the route answers something else.
  const dt = downtime.data && typeof downtime.data.seconds === "number" ? downtime.data : undefined;
  const dtSkeleton = downtime.isLoading && !dt;

  const cards: Card[] = [
    { key: "answered", label: "Requests answered", tipKey: "requestsAnswered",
      value: answered ? answered.value : "—", color: answered ? "var(--ok)" : "var(--text-4)",
      sub: answered ? answered.sub
        : failedWhy ?? (failedSince ? `failed requests are counted since ${failedSince} only` : reqServed === 0 ? "no requests in this window" : <>&nbsp;</>),
      loading: failedSkeleton, dim: failedRefreshing },
    { key: "downtime", label: dt && !dt.strict ? "Provider trouble time" : "Downtime avoided", tipKey: dt && !dt.strict ? "providerTroubleTime" : "downtimeAvoided",
      value: dt?.available ? spanWords(dt.seconds) : "—",
      color: !dt?.available ? "var(--text-4)" : dt.strict && dt.seconds > 0 ? "var(--ok)" : "var(--text)",
      sub: downtime.error && !dt ? "couldn't load it"
        : !dt ? <>&nbsp;</>
        : !dt.available ? "the metrics store didn't answer"
        : dt.incidents ? incidentsWords(dt.incidents, dt.chains)
        // Provider trouble the chain did not answer through is trouble: the card says how long.
        : dt.notAvoidedSeconds > 0 ? `${spanWords(dt.notAvoidedSeconds)} not covered: clients got errors`
        : "no provider was failing",
      loading: dtSkeleton, dim: downtime.isLoading && !!dt },
    { key: "retries", label: "Saved by retry", tipKey: "successfulRetries",
      value: retries != null ? fmtNum(retries) : "—", color: retries != null ? "var(--ok)" : "var(--text-4)",
      sub: retries != null ? <>&nbsp;</> : "no retries recorded yet" },
    { key: "failed", label: "Failed requests", tipKey: "failedRequests",
      value: failedN != null ? fmtNum(failedN) : "—", color: failedN == null ? "var(--text-4)" : failedN > 0 ? "var(--err)" : "var(--ok)",
      sub: failedWhy
        ?? (failedSince ? `since ${failedSince}, when the counts start` : <>&nbsp;</>),
      loading: failedSkeleton, dim: failedRefreshing },
    { key: "stale", label: "Out-of-date answers blocked", tipKey: "staleDetected",
      value: stale != null ? fmtNum(stale) : "—", color: stale != null ? "var(--text)" : "var(--text-4)",
      sub: <>&nbsp;</> },
    { key: "cache", label: "Answered from cache", tipKey: "cacheOffload",
      value: cachePct != null ? `${Math.round(cachePct * 100)}%` : "—", color: cachePct != null ? "#38bdf8" : "var(--text-4)",
      sub: cachePct != null ? "of reads" : "cache not enabled on this build" },
  ];

  return (
    // Six in a row where they fit, else three, else two: never four and a stray two.
    <div className="gw-hero" style={{ marginBottom: 14 }}>
    <div className="gw-hero__grid" style={{ opacity: refreshing ? 0.55 : 1, transition: "opacity 0.2s" }}>
      {cards.map((c) => {
        const ghost = showSkeleton || c.loading;
        return (
          // A card with its own read (the log count, the downtime read) can land long after the summary: it dims on its own.
          <div key={c.key} className="gw-card" style={{ padding: "13px 16px", opacity: !refreshing && c.dim ? 0.55 : 1, transition: "opacity 0.2s" }}>
            <div style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
              {c.label}<Tip text={TT[c.tipKey]!} />
            </div>
            <div className="gw-tnum" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.05, color: c.color, marginTop: 7 }}>
              {ghost ? <SkelValue h={25} w={104} /> : c.value}
            </div>
            {/* The sub-line is a CLAIM about the deployment ("cache not enabled
                on this build"). It must not be made before the answer is in -
                until then it's a ghost, not a sentence. */}
            <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 6, minHeight: "1.5em", lineHeight: 1.45 }}>
              {ghost ? <SkelLine w={176} /> : c.sub}
            </div>
          </div>
        );
      })}
    </div>
    </div>
  );
}
