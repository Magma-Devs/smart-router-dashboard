"use client";

/* One provider over the window, every chain of it together: errors, rate-limit
 * hits, down minutes and average latency, in bars on the clock (the same bars
 * as the Upstreams tab's errors over time - a bar at t covers the step before
 * it, and the last one is still filling). One pointer moves across all four.
 * Live data: /api/metrics/provider-series. */

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

const REFRESH_MS = 60_000;
const ERR = "var(--err)";
const REPLY = "#f97316";
const WARN = "var(--warn)";

const empty = (text: string) => (
  <div style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)", textAlign: "center", padding: "0 16px" }}>{text}</div>
);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(2)}%` : "—");

export function ProviderCharts({ providerId, providerName, timeWindow }: {
  providerId: string;
  providerName: string;
  timeWindow: MetricWindow;
}) {
  const { scopeQ } = useFilters();
  const res = useApi<ProviderSeries>(`/api/metrics/provider-series?provider=${encodeURIComponent(providerId)}&window=${timeWindow}${scopeQ}`, REFRESH_MS);
  const d = res.data;
  const [hovT, setHovT] = useState<number | null>(null);

  const grid = d?.grid;
  const times = useMemo(() => gridTimes(grid), [grid]);
  const zero = (v: number[]) => v.map((x) => (Number.isFinite(x) ? x : 0));
  const [tries, failed, replies, holds, down, lat] = useMemo(() => {
    const series = [d?.tries ?? [], d?.failed ?? [], d?.errorReplies ?? [], d?.rateLimitHits ?? [], d?.downMinutes ?? [], d?.avgLatencyMs ?? []];
    return onGrid(times, grid, series);
  }, [times, grid, d]);
  const sum = (v: number[] | undefined) => (v ?? []).reduce((a, b) => (Number.isFinite(b) ? a + b : a), 0);
  const totals = { tries: sum(tries), failed: sum(failed), replies: sum(replies), holds: sum(holds), down: sum(down) };

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

  /* average latency: no answers in a bar is a gap, never 0 ms */
  const latVals = lat ?? [];
  const latAll = latVals.filter(Number.isFinite);
  const latTop = niceScale(0, Math.max(1, ...latAll) * 1.1).hi;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 12, marginBottom: 12 }}>
      <PMPanel title="Errors over time"
        tip={`**Failed**: requests ${providerName} didn't answer usefully - a timeout, a refused connection, a 429, an HTTP 5xx.\n\n**Error replies**: requests it answered with an error. The router counts these as served.\n\n${perBar}`}>
        {totals.failed + totals.replies > 0 ? (
          <ChartRow height={170}
            chart={<ColumnChart stacks={errStacks} id={"pve" + pid} integerY {...shared}
              tooltip={(i) => (
                <>
                  {when(i)}
                  {tipRow("Failed", ERR, `${fmtComma(failed?.[i] ?? 0)} · ${pct(failed?.[i] ?? 0, tries?.[i] ?? 0)}`)}
                  {d?.errorReplies && tipRow("Error replies", REPLY, `${fmtComma(replies?.[i] ?? 0)} · ${pct(replies?.[i] ?? 0, tries?.[i] ?? 0)}`)}
                  {tipRow("Requests", "var(--text-4)", fmtComma(tries?.[i] ?? 0))}
                </>
              )} />}
            legend={<LegendLine heading="This window" rows={errRows} />} />
        ) : d && totals.tries > 0 ? empty(`No failed requests and no error replies at ${providerName} in this window.`) : loadingOr(`No requests to ${providerName} in this window.`)}
      </PMPanel>

      <PMPanel title="Rate-limit hits"
        tip={`Times ${providerName} answered **"too many requests"** and the router held it off. A provider that limits your whole account counts every chain together.\n\n${perBar}`}>
        {d && !d.rateLimitHits ? empty("This router build doesn't count rate-limit hits yet.") : totals.holds > 0 ? (
          <ChartRow height={170}
            chart={<ColumnChart stacks={[{ name: "Rate-limit hits", values: zero(holds ?? []), color: WARN }]} id={"pvr" + pid} integerY {...shared}
              tooltip={(i) => <>{when(i)}{tipRow("Rate-limit hits", WARN, fmtComma(holds?.[i] ?? 0))}</>} />}
            legend={<LegendLine heading="This window" rows={[{ key: "h", name: "Rate-limit hits", color: WARN, mark: "box", value: fmtComma(totals.holds) }]} />} />
        ) : d ? empty(`${providerName} didn't rate-limit you in this window.`) : loadingOr("")}
      </PMPanel>

      <PMPanel title="Down minutes"
        tip={`Minutes, summed over its chains, where **half or more** of its requests on a chain failed. An error reply is an answer, so it doesn't make a minute down.\n\n${perBar} Read for windows of a day or less.`}>
        {d && !d.downMinutes ? empty("Down minutes aren't read for windows longer than a day - pick a day or less.") : totals.down > 0 ? (
          <ChartRow height={170}
            chart={<ColumnChart stacks={[{ name: "Down minutes", values: zero(down ?? []), color: ERR }]} id={"pvd" + pid} integerY {...shared}
              tooltip={(i) => <>{when(i)}{tipRow("Down minutes", ERR, fmtComma(down?.[i] ?? 0))}</>} />}
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
