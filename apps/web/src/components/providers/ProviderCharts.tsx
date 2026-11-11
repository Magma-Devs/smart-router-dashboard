"use client";

/* One provider over the window, every chain of it together: errors, rate
 * limits, down minutes and average latency, in bars on the clock (the same
 * bars as the Upstreams tab's errors over time - a bar at t covers the step
 * before it, and the last one is still filling). One pointer moves across all
 * four, and a bar with failures in it opens the provider report on that
 * stretch, on the chain that failed most. Live data: /api/metrics/provider-series. */

import { useMemo, useState } from "react";
import { WINDOWS, type MetricWindow, type ProviderSeries } from "@sr/shared";
import { ColumnChart, LineChart, niceScale, type Layer } from "@/components/gateway/charts";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { fmtComma } from "@/lib/format";
import { PMPanel } from "@/components/metrics/upstream/PMPanel";
import {
  barSpanWords, ChartRow, dayOf, fmtMs, gridTimes, hhmm, LegendLine, onGrid, PAD_R, PAD_X, timeTicks, type LegendRow,
} from "@/components/metrics/upstream/PMBody";
import type { ReportTarget } from "./report-target";

const REFRESH_MS = 60_000;
const ERR = "var(--err)";
const REPLY = "#f97316";
const WARN = "var(--warn)";

const empty = (text: string) => (
  <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)", textAlign: "center", padding: "0 16px" }}>{text}</div>
);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : "—");

export function ProviderCharts({ providerId, providerName, timeWindow, onOpenReport }: {
  providerId: string;
  providerName: string;
  timeWindow: MetricWindow;
  /** A bar opens the provider report on that stretch, on the chain that failed most in it. */
  onOpenReport?: (target: ReportTarget) => void;
}) {
  const { scopeQ } = useFilters();
  const res = useApi<ProviderSeries>(`/api/metrics/provider-series?provider=${encodeURIComponent(providerId)}&window=${timeWindow}${scopeQ}`, REFRESH_MS);
  const d = res.data;
  const [hovT, setHovT] = useState<number | null>(null);

  const grid = d?.grid;
  const times = useMemo(() => gridTimes(grid), [grid]);
  const zero = (v: number[]) => v.map((x) => (Number.isFinite(x) ? x : 0));
  const [tries, failed, replies, holds, down, lat, limited] = useMemo(() => {
    const series = [
      d?.tries ?? [], d?.failed ?? [], d?.errorReplies ?? [], d?.rateLimitHits ?? [], d?.downMinutes ?? [], d?.avgLatencyMs ?? [],
      d?.rateLimitedMinutes ?? [],
    ];
    return onGrid(times, grid, series);
  }, [times, grid, d]);
  // Each chain's failures per bar: which chain a clicked bar's report opens on.
  const byChain = useMemo(() => {
    const chains = d?.failuresByChain ?? [];
    const rows = onGrid(times, grid, chains.map((c) => c.points));
    return chains.map((c, k) => ({ spec: c.spec, values: rows[k] ?? [] }));
  }, [times, grid, d]);
  const sum = (v: number[] | undefined) => (v ?? []).reduce((a, b) => (Number.isFinite(b) ? a + b : a), 0);
  const totals = { tries: sum(tries), failed: sum(failed), replies: sum(replies), holds: sum(holds), down: sum(down), limited: sum(limited) };

  const barSec = grid?.stepSec ?? 0;
  const asOf = d?.asOf ?? 0;
  const dom: [number, number] | undefined = d ? [asOf - WINDOWS[timeWindow].rangeSeconds, asOf] : undefined;
  const ticks = timeTicks(dom);
  const barWords = (i: number) => {
    const to = Math.min(times[i]!, asOf) * 1000;
    const from = (times[i]! - barSec) * 1000;
    const end = times[i]! > asOf ? "now" : hhmm(to);
    return `${dayOf(from)}, ${hhmm(from)} - ${end}`;
  };
  // The chains that failed in bar i, worst first.
  const failedChains = (i: number) =>
    byChain
      .map((c) => ({ spec: c.spec, n: c.values[i] ?? NaN }))
      .filter((c) => Number.isFinite(c.n) && c.n > 0)
      .sort((a, b) => b.n - a.n);
  const reportAt = onOpenReport
    ? (i: number) => {
        const ranked = failedChains(i);
        if (!ranked.length) return;
        const t = times[i]!;
        onOpenReport({
          providerId,
          providerName,
          spec: ranked[0]!.spec,
          range: { from: (t - barSec) * 1000, to: Math.min(t, asOf) * 1000 },
          chains: ranked.map((c) => c.spec),
        });
      }
    : undefined;
  const clickHint = (i: number) =>
    reportAt && failedChains(i).length ? (
      <div style={{ color: "var(--text-4)", marginTop: 6 }}>Click for a report on this stretch</div>
    ) : null;
  const shared = { xDomain: dom, xTicks: ticks, hoverAt: hovT, onHoverAt: setHovT, padX: PAD_X, padR: PAD_R, xs: times, barSpan: barSec } as const;
  const tipRow = (name: string, color: string, value: string) => (
    <div key={name} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, flexShrink: 0 }} />
      <span style={{ flex: 1, color: "var(--text-2)" }}>{name}</span>
      <span className="gw-mono gw-tnum" style={{ color: "var(--text)", fontWeight: 600 }}>{value}</span>
    </div>
  );
  const when = (i: number) => <div className="gw-mono" style={{ color: "var(--text-3)", marginBottom: 6 }}>{barWords(i)}</div>;
  const perBar = `One bar per ${barSpanWords(barSec || 600)}, on the clock; the last bar is still filling.`;
  const loadingOr = (text: string) => empty(res.isLoading ? "Loading…" : res.error && !d ? "Couldn't read this in time - it tries again on its next refresh." : text);
  const pid = providerId.replace(/[^a-zA-Z0-9_-]/g, "");

  /* errors: what it didn't answer usefully, and what it answered with an error */
  const errStacks: Layer[] = [
    { name: "Failed", values: zero(failed ?? []), color: ERR },
    ...(d?.errorReplies ? [{ name: "Error replies", values: zero(replies ?? []), color: REPLY }] : []),
  ];
  const errRows: LegendRow[] = [
    { key: "f", name: "Failed", color: ERR, mark: "box", value: `${fmtComma(totals.failed)} · ${pct(totals.failed, totals.tries)}` },
    ...(d?.errorReplies ? [{ key: "r", name: "Error replies", color: REPLY, mark: "box" as const, value: `${fmtComma(totals.replies)} · ${pct(totals.replies, totals.tries)}` }] : []),
  ];

  /* rate limits: rate-limited minutes where the router can put a hold-off on its chain, else the hits */
  const byMinute = !!d?.rateLimitedMinutes;
  const rateTip = byMinute
    ? `Minutes where half or more of ${providerName}'s requests got **"too many requests"**, and how many times it said so. They don't count as down: a rate limit is often your plan's limit, not the provider failing.\n\n${perBar} Minutes are read for windows of a day or less.`
    : `Times ${providerName} answered **"too many requests"** and the router held it off. A provider that limits your whole account counts every chain together.\n\n${perBar}`;

  /* average latency: no answers in a bar is a gap, never 0 ms */
  const latVals = lat ?? [];
  const latAll = latVals.filter(Number.isFinite);
  const latTop = niceScale(0, Math.max(1, ...latAll) * 1.1).hi;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 12, marginBottom: 12 }}>
      <PMPanel title="Errors over time"
        tip={`**Failed**: requests ${providerName} didn't answer usefully - a timeout, a refused connection, a 429, an HTTP 5xx.\n\n**Error replies**: requests it answered with an error. The router counts these as served.\n\n${perBar}${reportAt ? " Click a bar for a report on that stretch." : ""}`}>
        {totals.failed + totals.replies > 0 ? (
          <ChartRow height={170}
            chart={<ColumnChart stacks={errStacks} id={"pve" + pid} integerY {...shared} onBarClick={reportAt}
              tooltip={(i) => (
                <>
                  {when(i)}
                  {tipRow("Failed", ERR, `${fmtComma(failed?.[i] ?? 0)} · ${pct(failed?.[i] ?? 0, tries?.[i] ?? 0)}`)}
                  {d?.errorReplies && tipRow("Error replies", REPLY, `${fmtComma(replies?.[i] ?? 0)} · ${pct(replies?.[i] ?? 0, tries?.[i] ?? 0)}`)}
                  {tipRow("Requests", "var(--text-4)", fmtComma(tries?.[i] ?? 0))}
                  {clickHint(i)}
                </>
              )} />}
            legend={<LegendLine heading="This window" rows={errRows} />} />
        ) : d && totals.tries > 0 ? empty(`No failed requests and no error replies at ${providerName} in this window.`) : loadingOr(`No requests to ${providerName} in this window.`)}
      </PMPanel>

      <PMPanel title="Rate limits" tip={rateTip}>
        {d && !d.rateLimitHits ? empty("This router build doesn't count rate-limit hits yet.") : byMinute ? (
          totals.limited > 0 ? (
            <ChartRow height={170}
              chart={<ColumnChart stacks={[{ name: "Rate-limited minutes", values: zero(limited ?? []), color: WARN }]} id={"pvr" + pid} integerY {...shared} onBarClick={reportAt}
                tooltip={(i) => (
                  <>
                    {when(i)}
                    {tipRow("Rate-limited", WARN, `${fmtComma(limited?.[i] ?? 0)} min`)}
                    {tipRow("Rate-limit hits", "var(--text-4)", fmtComma(holds?.[i] ?? 0))}
                    {clickHint(i)}
                  </>
                )} />}
              legend={<LegendLine heading="This window" rows={[{ key: "l", name: "Rate-limited", color: WARN, mark: "box", value: `${fmtComma(totals.limited)} min · ${fmtComma(totals.holds)} hits` }]} />} />
          ) : totals.holds > 0 ? (
            empty(`${fmtComma(totals.holds)} rate-limit hits, but never half of a minute's requests - no rate-limited minute in this window.`)
          ) : d ? empty(`${providerName} didn't rate-limit you in this window.`) : loadingOr("")
        ) : totals.holds > 0 ? (
          <ChartRow height={170}
            chart={<ColumnChart stacks={[{ name: "Rate-limit hits", values: zero(holds ?? []), color: WARN }]} id={"pvr" + pid} integerY {...shared} onBarClick={reportAt}
              tooltip={(i) => <>{when(i)}{tipRow("Rate-limit hits", WARN, fmtComma(holds?.[i] ?? 0))}{clickHint(i)}</>} />}
            legend={<LegendLine heading="This window" rows={[{ key: "h", name: "Rate-limit hits", color: WARN, mark: "box", value: fmtComma(totals.holds) }]} />} />
        ) : d ? empty(`${providerName} didn't rate-limit you in this window.`) : loadingOr("")}
      </PMPanel>

      <PMPanel title="Down minutes"
        tip={`Minutes, summed over its chains, where **half or more** of its requests failed. **Rate limits don't count** - they are in Rate limits. An error reply is an answer, so it doesn't make a minute down either.\n\n${perBar} Read for windows of a day or less.`}>
        {d && !d.downMinutes ? empty("Down minutes aren't read for windows longer than a day - pick a day or less.") : totals.down > 0 ? (
          <ChartRow height={170}
            chart={<ColumnChart stacks={[{ name: "Down minutes", values: zero(down ?? []), color: ERR }]} id={"pvd" + pid} integerY {...shared} onBarClick={reportAt}
              tooltip={(i) => <>{when(i)}{tipRow("Down minutes", ERR, fmtComma(down?.[i] ?? 0))}{clickHint(i)}</>} />}
            legend={<LegendLine heading="This window" rows={[{ key: "d", name: "Down minutes", color: ERR, mark: "box", value: fmtComma(totals.down) }]} />} />
        ) : d ? empty(`${providerName} had no down minute in this window.`) : loadingOr("")}
      </PMPanel>

      <PMPanel title="Average latency"
        tip={`The average time ${providerName} took to answer, all its chains together, per bar. A gap is a bar with no answers.\n\nRead for windows of a day or less.`}>
        {d && !d.avgLatencyMs ? empty("Latency isn't read for windows longer than a day - pick a day or less.") : latAll.length ? (
          <ChartRow height={170}
            chart={<LineChart series={[{ values: latVals, color: "var(--brand)", width: 2.2, opacity: 1, fill: false, curve: "smooth" }]} id={"pvl" + pid}
              padY={16} yDomain={[0, latTop]} niceY yFmt={fmtMs} maxGap={1} hoverBox={false} pointLabels
              hover={{ title: (i) => barWords(i), rows: [{ name: "Average", bold: true }], fmt: fmtMs }}
              xDomain={dom} xTicks={ticks} hoverAt={hovT} onHoverAt={setHovT} padX={PAD_X} padR={PAD_R} xs={times} />}
            legend={<LegendLine rows={[{ key: "a", name: "Average", color: "var(--brand)", selected: true }]} />} />
        ) : d ? empty(`No answers from ${providerName} with a measured latency in this window.`) : loadingOr("")}
      </PMPanel>
    </div>
  );
}
