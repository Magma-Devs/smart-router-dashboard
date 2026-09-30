"use client";

/* PMBody - the selected upstream's charts in the Upstreams deep-dive, each
 * full width, one below the other, every upstream of the chain on the same
 * chart with the selected one bold, in the order an incident is read -
 * did it fail, how much traffic, how slow, was it in sync:
 *  - Errors over time: this upstream's, a bar per 10 or 30 minutes (longer on
 *    a window of days), on the clock. Hover a bar for its counts; click it to
 *    open those requests in the Errors tab, filtered to this upstream and
 *    that stretch of time;
 *  - Request volume (req/s), Latency (p95), Latest block - sampled at ~300
 *    points and laid out by TIME on the grid the api sampled them on, so a
 *    stretch with no data is a gap, never a straight ramp across it. Hover any
 *    of them for every upstream's value at that moment;
 *  - all four on ONE time axis, labelled at round times of day, so an error
 *    bar sits over the latency spike it belongs with - and one pointer: the
 *    moment under it, on any chart, draws every chart's crosshair;
 *  - the values at that moment beside the dots under the pointer, and a
 *    legend on one line under each chart naming the lines, so every chart
 *    keeps the full width. Pointing at a name brings its line forward.
 * The prototype's selection-score and disagreement-rate panels are gone:
 * neither was something an operator could act on here. */

import { useMemo, useState, type ReactNode } from "react";
import { chartSampling, WINDOWS, type ChartGrid, type MetricWindow, type TimePoint, type UpstreamDetail, type UpstreamMetrics, type UpstreamPeers } from "@sr/shared";
import { ColumnChart, LineChart, niceScale, type ChartHover, type Layer, type Series, type XTick } from "@/components/gateway/charts";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { fmtComma } from "@/lib/format";
import type { ErrorsJump } from "../ErrorsBreakdown";
import { PMPanel } from "./PMPanel";

/** Every chart's margins: on the left the widest axis labels' (a block
 *  height), on the right just room for the last tick - the legend sits under
 *  the chart. The four stack on one time axis, so they must share both, or
 *  the same moment lands at a different x in each. */
const PAD_X = 80;
const PAD_R = 16;

/** The peers' colours; the selected upstream is always the brand colour. */
const PEER_COLORS = ["#38bdf8", "#a78bfa", "#22c55e", "#eab308", "#ec4899", "#14b8a6", "#f97316", "#94a3b8"];

/** Every point of a grid, unix seconds: the chart's time axis. */
function gridTimes(grid: ChartGrid | undefined): number[] {
  if (!grid || grid.stepSec <= 0) return [];
  const out: number[] = [];
  for (let t = grid.start; t <= grid.end; t += grid.stepSec) out.push(t);
  return out;
}

/** Series laid on a grid by time - NaN where one has no point there, which
 *  the chart draws as a gap. A point lands on its nearest slot. */
function onGrid(times: number[], grid: ChartGrid | undefined, series: TimePoint[][]): number[][] {
  return series.map((s) => {
    const out: number[] = new Array(times.length).fill(NaN);
    if (!grid || !times.length) return out;
    for (const p of s) {
      if (p.v == null) continue;
      const k = Math.round((p.t - grid.start) / grid.stepSec);
      if (k >= 0 && k < out.length) out[k] = p.v;
    }
    return out;
  });
}

const whenOf = (t: number | undefined) =>
  t ? new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Tick spacings for a time axis: the clock's own, a minute to a week. */
const TICK_STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 259200, 604800];

/** Labels at round local times across [from, to] (unix seconds), seven at
 *  most: 00:00 · 06:00 · 12:00 · 18:00 across a day, a date a day across a
 *  week. The evenly spaced labels this replaced landed on 00:37 and 06:45. */
function timeTicks(dom: [number, number] | undefined): XTick[] | undefined {
  if (!dom) return undefined;
  const [from, to] = dom;
  const span = to - from;
  const step = TICK_STEPS.find((sec) => span / sec <= 7) ?? 604800;
  const tz = -new Date(to * 1000).getTimezoneOffset() * 60;
  const out: XTick[] = [];
  for (let t = Math.ceil((from + tz) / step) * step - tz; t <= to; t += step) {
    const d = new Date(t * 1000);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    out.push({ at: t, label: step >= 86400 || (span > 86400 && midnight) ? dayOf(t * 1000) : hhmm(t * 1000) });
  }
  return out;
}


/** The value at quantile q of some numbers (0 when there are none). */
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(q * (s.length - 1))]! : 0;
};

const fmtMs = (v: number) => `${fmtComma(Math.round(v))} ms`;
/** "the hour", "the 16 minutes", "the 150 seconds" - how long each point averages. */
const spanWords = (sec: number) =>
  sec % 3600 === 0 ? (sec === 3600 ? "the hour" : `the ${sec / 3600} hours`) : sec % 60 === 0 ? `the ${sec / 60} minutes` : `the ${sec} seconds`;
const fmtRps = (v: number) => (v === 0 ? "0" : v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : fmtComma(Math.round(v)));
/** "10 minutes", "an hour", "6 hours", "a day" - one bar's span. */
const barSpanWords = (sec: number) =>
  sec >= 86400 ? (sec === 86400 ? "a day" : `${sec / 86400} days`) : sec >= 3600 ? (sec === 3600 ? "an hour" : `${sec / 3600} hours`) : `${sec / 60} minutes`;

interface LegendRow {
  key: string;
  name: string;
  color: string;
  /** A count beside the name (the errors legend); the line legends name their lines only. */
  value?: string;
  selected?: boolean;
  /** A line for a line chart's series, a square for a bar chart's. */
  mark?: "line" | "box";
}

/**
 * The legend under a chart, one line left to right: which line is which. The
 * values themselves are read on the chart, beside the dots under the pointer
 * (LineChart pointLabels), where the eye already is. It starts where the plot
 * starts, and pointing at a name brings its line forward.
 */
function LegendLine({ heading, rows, foot, onFocus }: {
  heading?: string;
  rows: LegendRow[];
  foot?: ReactNode;
  onFocus?: (key: string | null) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 18, rowGap: 6, marginTop: 6, paddingLeft: PAD_X, paddingRight: PAD_R }}>
      {heading && <span className="gw-mono" style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{heading}</span>}
      {rows.map((r) => (
        <span key={r.key} onMouseEnter={onFocus ? () => onFocus(r.key) : undefined} onMouseLeave={onFocus ? () => onFocus(null) : undefined}
          style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span style={{ width: r.mark === "box" ? 9 : 12, height: r.mark === "box" ? 9 : r.selected ? 3 : 2, borderRadius: r.mark === "box" ? 2 : 1, background: r.color, flexShrink: 0 }} />
          <span className={r.mark === "box" ? undefined : "gw-mono"} style={{ fontSize: 11, color: r.selected ? "var(--text)" : "var(--text-2)", fontWeight: r.selected ? 600 : 400, whiteSpace: "nowrap" }}>{r.name}</span>
          {r.value != null && <span className="gw-mono gw-tnum" style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{r.value}</span>}
        </span>
      ))}
      {foot && <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-4)" }}>{foot}</span>}
    </div>
  );
}

/** A chart, and its legend on one line under it. */
function ChartRow({ height, chart, legend }: { height: number; chart: ReactNode; legend: ReactNode }) {
  return (
    <div>
      <div style={{ height }}>{chart}</div>
      {legend}
    </div>
  );
}

const empty = (text: string) => (
  <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-4)" }}>{text}</div>
);

export function PMBody({ pm, detail, name, timeWindow, onOpenErrors }: {
  pm: UpstreamMetrics;
  detail: UpstreamDetail | undefined;
  name: string;
  timeWindow: MetricWindow;
  /** Opens the Errors tab on one bar's requests; without it the bars only hover. */
  onOpenErrors?: (jump: ErrorsJump) => void;
}) {
  const pid = name.replace(/[^a-zA-Z0-9_-]/g, "");
  // The selected row's chain: `detail` can still be the previous upstream's while the new one loads.
  const spec = pm.spec || detail?.spec || "";
  const chainLabel = spec || "this chain";
  const { scopeQ } = useFilters();
  const peers = useApi<UpstreamPeers>(spec ? `/api/metrics/upstream-peers?spec=${encodeURIComponent(spec)}&window=${timeWindow}${scopeQ}` : null);
  /* One pointer for all four charts - the moment under it (unix seconds),
     whichever chart it is on - and the upstream a legend row points at. */
  const [hovT, setHovT] = useState<number | null>(null);
  const [focusUp, setFocusUp] = useState<string | null>(null);

  /* The selected upstream last, so its bold line is drawn on top of the rest. */
  const ordered = useMemo(() => {
    const ups = peers.data?.upstreams ?? [];
    return [...ups.filter((u) => u.upstream !== name), ...ups.filter((u) => u.upstream === name)];
  }, [peers.data, name]);
  const grid = peers.data?.grid;
  // A gap of up to 10 minutes is bridged; a longer one is drawn as a gap.
  const maxGap = grid ? Math.floor(600 / grid.stepSec) : 0;
  // An empty chart after a read that failed says so, rather than "no requests".
  const peersEmpty = (none: string) =>
    empty(peers.isLoading ? "Loading…" : peers.data && !peers.data.available ? "Couldn't read these series in time - try a shorter window." : none);
  const times = useMemo(() => gridTimes(grid), [grid]);
  const colorOf = (u: string, i: number) => (u === name ? "var(--brand)" : PEER_COLORS[i % PEER_COLORS.length]!);
  /* A line pointed at in a legend comes forward; the others fade. */
  const lineOf = (u: string, i: number, values: number[], curve: Series["curve"] = "smooth"): Series => {
    const faded = focusUp != null && focusUp !== u;
    return u === name
      ? { values, color: colorOf(u, i), width: 2.6, opacity: faded ? 0.25 : 1, fill: false, curve }
      : { values, color: colorOf(u, i), width: focusUp === u ? 2.2 : 1.4, opacity: faded ? 0.2 : focusUp === u ? 1 : 0.8, fill: false, curve };
  };
  /* The pointer snaps to the grid the lines are sampled on, so moving within
     one point doesn't redraw every chart. */
  const setHover = (t: number | null) =>
    setHovT(t == null || !grid ? t : grid.start + Math.round((t - grid.start) / grid.stepSec) * grid.stepSec);
  /* The legend's rows: this upstream first, then its peers - names only. */
  const ix = ordered.map((u, i) => ({ u, i }));
  const nameRows: LegendRow[] = [...ix.filter((x) => x.u.upstream === name), ...ix.filter((x) => x.u.upstream !== name)]
    .map(({ u, i }) => ({ key: u.upstream, name: u.upstream, color: colorOf(u.upstream, i), selected: u.upstream === name }));
  const hoverOf = (fmt: (v: number) => string, sub?: ChartHover["sub"]): ChartHover => ({
    title: (i) => whenOf(times[i]),
    rows: ordered.map((u) => ({ name: u.upstream, bold: u.upstream === name })),
    fmt,
    sub,
  });
  const averages = spanWords(chartSampling(timeWindow).lookbackSec);

  /* latency - p95 per upstream. The axis fits all of this upstream's line
     and the bulk of every upstream's points, not a peer's outlier: one stuck
     at eight seconds for an hour would otherwise flatten every other line
     against the floor. A peer that runs off the top is named under the
     chart, and the hover still reads its real value. */
  const lat = useMemo(() => onGrid(times, grid, ordered.map((u) => u.latencyP95)), [times, grid, ordered]);
  const latAll = lat.flat().filter(Number.isFinite);
  const selIdx = ordered.findIndex((u) => u.upstream === name);
  const selLat = selIdx >= 0 ? lat[selIdx]!.filter(Number.isFinite) : [];
  const latFit = Math.max(selLat.length ? Math.max(...selLat) : 0, quantile(latAll, 0.75), 1) * 1.1;
  const latTop = niceScale(0, latFit).hi;
  const latOver = ordered
    .map((u, i) => ({ name: u.upstream, max: Math.max(-Infinity, ...lat[i]!.filter(Number.isFinite)) }))
    .filter((x) => x.max > latTop);

  /* request volume - req/s per upstream, from zero */
  const rps = useMemo(() => onGrid(times, grid, ordered.map((u) => u.rps)), [times, grid, ordered]);
  const rpsAll = rps.flat().filter(Number.isFinite);
  const rpsHi = rpsAll.length ? Math.max(...rpsAll) : 0;

  /* latest block - the tip per upstream, straight segments (a height jumps;
     a smoothed curve would dip before the jump), on a tight axis: heights are
     huge numbers a few blocks apart, and an axis from zero stacks every line
     on the others. */
  const tips = useMemo(() => onGrid(times, grid, ordered.map((u) => u.latestBlock)), [times, grid, ordered]);
  const tipAll = tips.flat().filter(Number.isFinite);
  const tipHi = tipAll.length ? Math.max(...tipAll) : 0;
  const tipLo = tipAll.length ? Math.min(...tipAll) : 0;
  const tipPad = Math.max(1, (tipHi - tipLo) * 0.08);
  /* A tip's label adds how far behind the highest tip at that point it is. */
  const behindAt = (si: number, i: number) => {
    const best = Math.max(-Infinity, ...tips.map((t) => (Number.isFinite(t[i]!) ? t[i]! : -Infinity)));
    const v = tips[si]?.[i];
    const b = v != null && Number.isFinite(v) && Number.isFinite(best) ? best - v : 0;
    return b > 0 ? `${fmtComma(b)} behind` : null;
  };

  /* errors over time - failed attempts and node errors per bar, on the clock.
     A bar at t covers the stepSec before it; the last one, still filling,
     only up to asOf. The legend adds up the bars, so the two always agree. */
  const eot = detail?.errorsOverTime;
  const errTimes = useMemo(() => gridTimes(eot?.grid), [eot]);
  const errVals = useMemo(() => onGrid(errTimes, eot?.grid, [eot?.failed ?? [], ...(eot?.node ? [eot.node] : [])]), [errTimes, eot]);
  const zeroGaps = (vals: number[] | undefined) => (vals ?? []).map((v) => (Number.isFinite(v) ? v : 0));
  const errStacks: Layer[] = [
    { name: "Failed attempts", values: zeroGaps(errVals[0]), color: "var(--err)" },
    ...(eot?.node ? [{ name: "Node errors", values: zeroGaps(errVals[1]), color: "#f97316" }] : []),
  ];
  const sumOf = (vals: number[]) => vals.reduce((a, b) => a + b, 0);
  const errTotals = errStacks.map((l) => ({ name: l.name, color: l.color, total: sumOf(l.values) }));
  const errTotal = errTotals.reduce((s, l) => s + l.total, 0);
  const barSec = eot?.grid.stepSec ?? 0;
  const barFrom = (i: number) => (errTimes[i]! - barSec) * 1000;
  const barTo = (i: number) => Math.min(errTimes[i]!, eot?.asOf ?? Infinity) * 1000;
  const barFilling = (i: number) => eot != null && errTimes[i]! > eot.asOf;
  /* One time axis for all four: the window, ending when it was read. The
     errors' first bar starts before it and the last is still filling, so
     both are cut at the edges - their tooltips give the whole bar. */
  const domEnd = grid?.end ?? eot?.asOf;
  const dom: [number, number] | undefined = domEnd != null ? [domEnd - WINDOWS[timeWindow].rangeSeconds, domEnd] : undefined;
  const ticks = timeTicks(dom);
  const barWords = (i: number) => {
    const from = barFrom(i), to = barTo(i);
    const end = barFilling(i) ? "now" : dayOf(to) === dayOf(from) || barSec < 86400 ? hhmm(to) : `${dayOf(to)} ${hhmm(to)}`;
    return `${dayOf(from)}, ${hhmm(from)} - ${end}`;
  };

  /* The errors legend: the window's totals. */
  const errRows: LegendRow[] = errStacks.map((l, k) => ({
    key: l.name, name: l.name, color: l.color, mark: "box", value: fmtComma(errTotals[k]!.total),
  }));
  const errFoot = onOpenErrors ? "Click a bar to see its requests in the Errors tab." : undefined;
  const shared = { xDomain: dom, xTicks: ticks, hoverAt: hovT, onHoverAt: setHover, padX: PAD_X, padR: PAD_R } as const;

  return (
    <div style={{ display: "grid", gap: 12, marginBottom: 12 }}>
      <PMPanel full title="Errors over time"
        tip={`**Failed attempts**: attempts at ${name} with no usable response - a timeout, a connection error, a rate limit, an HTTP 5xx.\n\n**Node errors**: error responses from the node itself. Shown once the router reports them.\n\nOne bar per ${barSpanWords(barSec || 600)}, aligned to the clock; the last bar is still in progress.`}>
        {errTotal > 0 ? (
          <ChartRow height={160}
            chart={<ColumnChart stacks={errStacks} id={"pme" + pid} integerY xs={errTimes} barSpan={barSec} {...shared}
              onBarClick={onOpenErrors ? (i) => onOpenErrors({ spec, upstream: name, from: barFrom(i), to: barTo(i) }) : undefined}
              tooltip={(i) => (
                <>
                  <div className="gw-mono" style={{ color: "var(--text-3)", marginBottom: 6 }}>{barWords(i)}</div>
                  {errStacks.map((l) => (
                    <div key={l.name} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: l.color, flexShrink: 0 }} />
                      <span style={{ flex: 1, color: "var(--text-2)" }}>{l.name}</span>
                      <span className="gw-mono gw-tnum" style={{ color: "var(--text)", fontWeight: 600 }}>{fmtComma(l.values[i] ?? 0)}</span>
                    </div>
                  ))}
                </>
              )} />}
            legend={<LegendLine heading="This window" rows={errRows} foot={errFoot} />} />
        ) : empty(eot ? `No errors at ${name} in this window.` : "Loading…")}
      </PMPanel>

      <PMPanel full title="Request volume"
        tip={`Requests per second each upstream served, each point averaging ${averages} before it.\n\n- A gap is a stretch with no data, not zero traffic\n- Cache hits aren't counted: they never reach an upstream`}>
        {rpsAll.length ? (
          <ChartRow height={200}
            chart={<LineChart series={ordered.map((u, i) => lineOf(u.upstream, i, rps[i]!))} id={"pmv" + pid} padY={16}
              yDomain={[0, rpsHi > 0 ? rpsHi * 1.1 : 0.01]} niceY yFmt={fmtRps} xs={times} maxGap={maxGap}
              hover={hoverOf((v) => `${fmtRps(v)} rps`)} hoverBox={false} pointLabels {...shared} />}
            legend={<LegendLine rows={nameRows} onFocus={setFocusUp} />} />
        ) : peersEmpty(`No upstream on ${chainLabel} served a request in this window.`)}
      </PMPanel>

      <PMPanel full title="Latency · p95"
        tip={`The time 95% of requests finished within, each point over ${averages} before it.\n\nA gap means that upstream served no requests then.`}>
        {latAll.length ? (
          <>
            <ChartRow height={220}
              chart={<LineChart series={ordered.map((u, i) => lineOf(u.upstream, i, lat[i]!))} id={"pml" + pid} padY={16}
                yDomain={[0, latTop]} niceY yFmt={fmtMs} xs={times} maxGap={maxGap} hover={hoverOf(fmtMs)} hoverBox={false} pointLabels {...shared} />}
              legend={<LegendLine rows={nameRows} onFocus={setFocusUp} />} />
            {latOver.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-4)" }}>
                ↑ Off the top of the chart: {latOver.map((x) => `${x.name} (up to ${fmtMs(x.max)})`).join(", ")} - point at it to read each value.
              </div>
            )}
          </>
        ) : peersEmpty(`No upstream on ${chainLabel} served a request with a measured latency in this window.`)}
      </PMPanel>

      <PMPanel full title="Latest block"
        tip={`The block each upstream reports.\n\n- **Climbing together**: in sync\n- **Flat**: stopped syncing\n- **Below the others**: behind - point at the chart to see how many blocks, against the highest tip at that moment`}>
        {tipAll.length ? (
          <ChartRow height={220}
            chart={<LineChart series={ordered.map((u, i) => lineOf(u.upstream, i, tips[i]!, "linear"))} id={"pmb" + pid} padY={16}
              yDomain={[tipLo - tipPad, tipHi + tipPad]} niceY yFmt={(v) => fmtComma(Math.round(v))} xs={times} maxGap={maxGap}
              hover={hoverOf((v) => fmtComma(Math.round(v)), behindAt)} hoverBox={false} pointLabels {...shared} />}
            legend={<LegendLine rows={nameRows} onFocus={setFocusUp} />} />
        ) : peersEmpty(`No upstream on ${chainLabel} reported a block in this window.`)}
      </PMPanel>
    </div>
  );
}
