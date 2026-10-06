"use client";

/* charts.tsx — reusable SVG chart primitives for Smart Router dashboard.
   Ported 1:1 from the design prototype (SR_Dashboard/magma/charts.jsx). */

import { useEffect, useRef, useState } from "react";
import { ColumnChart as LegacyColumnChart, LineChart as LegacyLineChart } from "@/legacy/components/gateway/charts";
import { useNewUi } from "./new-ui";

/* default x-axis tick labels — charts hold ~24h of hourly data */
export const X_DEFAULT = ["−24h", "−18h", "−12h", "−6h", "now"];

/* ── observe container w + h ─────────────────────────────────────────── */
export function useChartDims(
  fw = 600,
  fh = 200,
): [React.RefObject<HTMLDivElement | null>, number, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(fw);
  const [h, setH] = useState(fh);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const cw = Math.max(200, e.contentRect.width);
      const ch = e.contentRect.height;
      setW(cw);
      if (ch > 40) setH(ch);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w, h];
}

/* ── 0→1 animation progress ─────────────────────────────────────────── */
export function useAnimProg(key: string | number, ms = 700): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    setP(0);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const v = Math.min(1, (t - t0) / ms);
      setP(v);
      if (v < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return p;
}

/* ── smooth path (monotone cubic → bezier) ───────────────────────────────
   A curve through the points that never leaves them: between two points it
   stays between their values, and a peak or a trough is flat at the point.
   The Catmull-Rom curve this replaced overshot every step - a square wave
   rang at its corners, and a quiet line dipped below zero beside each burst,
   drawing values that never happened. (The tangents are d3's monotoneX.) */
function smoothLine(pts: [number, number][]): string {
  const n = pts.length;
  if (n < 2) return n ? `M ${pts[0]![0]} ${pts[0]![1]}` : "";
  const f = (v: number) => v.toFixed(1);
  if (n === 2) return `M ${f(pts[0]![0])} ${f(pts[0]![1])} L ${f(pts[1]![0])} ${f(pts[1]![1])}`;
  const sign = (v: number) => (v < 0 ? -1 : 1);
  // Secant slopes, then each interior tangent: zero at a turn, else the
  // smaller of the neighbours' slopes (capped), so no segment overshoots.
  const s: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1]![0] - pts[i]![0];
    s.push(h ? (pts[i + 1]![1] - pts[i]![1]) / h : 0);
  }
  const t: number[] = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const h0 = pts[i]![0] - pts[i - 1]![0];
    const h1 = pts[i + 1]![0] - pts[i]![0];
    const s0 = s[i - 1]!, s1 = s[i]!;
    const p = (s0 * h1 + s1 * h0) / (h0 + h1 || 1);
    t[i] = (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  t[0] = (3 * s[0]! - t[1]!) / 2;
  t[n - 1] = (3 * s[n - 2]! - t[n - 2]!) / 2;
  // An end tangent pointing against its segment would overshoot there.
  if (Math.sign(t[0]!) !== Math.sign(s[0]!)) t[0] = 0;
  if (Math.sign(t[n - 1]!) !== Math.sign(s[n - 2]!)) t[n - 1] = 0;
  let d = `M ${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const dx = (x1 - x0) / 3;
    d += ` C ${f(x0 + dx)} ${f(y0 + t[i]! * dx)} ${f(x1 - dx)} ${f(y1 - t[i + 1]! * dx)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}

/** A label on a time axis, at `at` in the same units as the chart's `xs`. */
export interface XTick {
  at: number;
  label: string;
}

/** Tick labels along the bottom, each under its own time - anchored inward
 *  at the edges so none is cut off. */
function xTickLabels(ticks: XTick[], xOf: (at: number) => number, padX: number, iW: number, y: number) {
  return ticks.map((t, k) => {
    const x = xOf(t.at);
    const anchor = x - padX < 18 ? "start" : padX + iW - x < 18 ? "end" : "middle";
    return <text key={"t" + k} x={x} y={y} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={anchor}>{t.label}</text>;
  });
}

/** A round number to step an axis by: 1, 2 or 5 × a power of ten. */
function niceNum(x: number): number {
  if (!(x > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const r = x / e;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * e;
}

/** An axis widened to round numbers - [lo, hi] on multiples of a round step,
 *  about `count` of them - and its ticks. */
export function niceScale(lo: number, hi: number, count = 4): { lo: number; hi: number; ticks: number[] } {
  const step = niceNum((hi - lo) / count || Math.abs(hi) || 1);
  const nlo = Math.floor(lo / step + 1e-9) * step;
  const nhi = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let k = 0; nlo + k * step <= nhi + step / 2; k++) ticks.push(Number((nlo + k * step).toPrecision(12)));
  return { lo: nlo, hi: Math.max(nhi, nlo + step), ticks };
}

export interface Series {
  values: number[];
  color?: string;
  width?: number;
  fill?: boolean;
  dashed?: boolean;
  opacity?: number;
  /** "linear" joins points with straight segments - for values that jump (a
   *  block height), where a smoothed curve would overshoot and dip. */
  curve?: "smooth" | "linear";
}

/** What a LineChart shows on hover: a crosshair, and every series' value at that point. */
export interface ChartHover {
  /** The heading for point i - usually its time. */
  title: (i: number) => string;
  /** One row per series, in the series' order. */
  rows: { name: string; bold?: boolean }[];
  fmt: (v: number) => string;
  /** A second reading for series `si` at point `i`, after the value in its label ("754 behind"). */
  sub?: (si: number, i: number) => string | null;
}
export interface Layer {
  name: string;
  values: number[];
  color: string;
}
export interface BgBand {
  lo: number;
  hi: number;
  fill: string;
}
export interface ChartTarget {
  value: number;
  color?: string;
  label?: string;
}

/* ── LineChart ───────────────────────────────────────────────────────── */
/* series: [{values, color, dashed, width, opacity, fill}]
   bgBands: [{lo, hi, fill}]   target: {value, color, label} */
function NewLineChart({
  series,
  height,
  padX = 40,
  padY = 10,
  xLabels,
  yFmt,
  target,
  bgBands,
  id = "lc",
  gridCount = 4,
  yDomain,
  hover,
  maxGap = 0,
  niceY = false,
  xs,
  xDomain,
  xTicks,
  padR,
  hoverAt,
  onHoverAt,
  hoverBox = true,
  pointLabels = false,
}: {
  series: Series[];
  height?: number;
  padX?: number;
  padY?: number;
  /** null ⇒ no x labels (and no reserved space); undefined ⇒ X_DEFAULT */
  xLabels?: string[] | null;
  yFmt?: (v: number) => string;
  target?: ChartTarget;
  bgBands?: BgBand[];
  id?: string;
  gridCount?: number;
  yDomain?: [number, number];
  /** A crosshair and a tooltip with every series' value at the point under the cursor. */
  hover?: ChartHover;
  /** Missing points a line bridges before it breaks - a dropped scrape
   *  shouldn't cut a line, a missing hour should. 0 ⇒ every gap breaks it. */
  maxGap?: number;
  /** Widen the y axis to round numbers and put the gridlines on them. */
  niceY?: boolean;
  /** Lay points out by time: point i at `xs[i]` on an axis from `xDomain[0]`
   *  to `xDomain[1]`, so charts stacked on one domain line up. */
  xs?: number[];
  xDomain?: [number, number];
  /** Labels at given times (with `xs`/`xDomain`), instead of `xLabels`. */
  xTicks?: XTick[];
  /** The right margin, when it differs from the left (`padX`). */
  padR?: number;
  /** A hover the parent owns, in `xs` units (a time) - so charts stacked on
   *  one axis move one crosshair together. `onHoverAt` reports where the
   *  pointer is; null when it leaves. Leave both out for a chart of its own. */
  hoverAt?: number | null;
  onHoverAt?: (at: number | null) => void;
  /** The floating box of values beside the crosshair. Off when the page shows
   *  the values elsewhere - a legend that reads them out. */
  hoverBox?: boolean;
  /** The values at the crosshair as labels beside each series' dot, and its
   *  time in a pill above it - read where you are looking, not in a legend. */
  pointLabels?: boolean;
}) {
  const [ref, w, oh] = useChartDims(600, height || 200);
  const h = height || oh;
  const prog = useAnimProg(id + (series?.[0]?.values?.length ?? 0));
  const [hovI, setHovI] = useState<number | null>(null);

  const containerStyle: React.CSSProperties = {
    width: "100%",
    height: height ? height : "100%",
    overflow: hover ? "visible" : "hidden",
    position: "relative",
  };
  if (!series?.length) return <div ref={ref} style={containerStyle} />;

  const all = series.flatMap((s) => s.values ?? []).filter((v) => v != null && isFinite(v));
  if (!all.length) return <div ref={ref} style={containerStyle} />;

  const lo0 = yDomain ? yDomain[0] : Math.min(...all) * 0.97,
    hi0 = yDomain ? yDomain[1] : Math.max(...all) * 1.03;
  const nice = niceY ? niceScale(lo0, hi0, gridCount) : null;
  const lo = nice ? nice.lo : lo0,
    hi = nice ? nice.hi : hi0,
    range = hi - lo || 1;
  const n = Math.max(...series.map((s) => s.values?.length ?? 0));
  const iW = w - padX - (padR ?? padX),
    iH = h - padY * 2 - (xLabels === null ? 0 : 18);
  const timed = xs && xDomain && xDomain[1] > xDomain[0] ? { xs, d0: xDomain[0], span: xDomain[1] - xDomain[0] } : null;
  const xAt = (at: number) => padX + (timed ? ((at - timed.d0) / timed.span) * iW : 0);
  const cx = (i: number) => (timed ? xAt(timed.xs[i] ?? timed.d0) : padX + (n > 1 ? (i / (n - 1)) * iW : iW / 2));
  const cy = (v: number) => padY + iH - ((v - lo) / range) * iH;
  /* The point nearest a position on the axis (a time, or an index) - and
     the one nearest a fraction f of the way across. */
  const atIndex = (at: number) => {
    if (!timed) return Math.min(n - 1, Math.max(0, Math.round(at)));
    let best = 0;
    timed.xs.forEach((x, i) => { if (Math.abs(x - at) < Math.abs(timed.xs[best]! - at)) best = i; });
    return best;
  };
  const nearest = (f: number) => atIndex(timed ? timed.d0 + f * timed.span : f * (n - 1));
  const controlled = hoverAt !== undefined;
  const shownI = controlled ? (hoverAt == null ? null : atIndex(hoverAt)) : hovI;
  /* A series' points split where a value is missing (NaN): each run is drawn
     on its own, so a gap reads as a gap - never as a drop to zero. A series
     with no gaps is one run, drawn exactly as before. */
  const runsOf = (vals: number[]) => {
    const runs: [number, number][][] = [];
    let cur: [number, number][] = [];
    let missing = 0;
    vals.forEach((v, i) => {
      if (Number.isFinite(v)) {
        cur.push([cx(i), cy(v)]);
        missing = 0;
      } else if (cur.length && ++missing > maxGap) {
        runs.push(cur);
        cur = [];
      }
    });
    if (cur.length) runs.push(cur);
    return runs;
  };
  const runPath = (run: [number, number][], curve: Series["curve"] = "smooth") =>
    curve === "linear"
      ? run.map(([x, y], k) => `${k ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")
      : smoothLine(run);
  const baseY = padY + iH;
  const clipId = `${id}cp`;
  // fill the area under a series when it's the only line, or when explicitly asked
  const single = series.filter((s) => s.values?.length).length === 1;
  const fmt =
    yFmt ||
    ((v: number) => {
      const a = Math.abs(v);
      if (a >= 1000) return (v / 1000).toFixed(1) + "k";
      if (a < 1) return v.toFixed(2);
      return Math.round(v).toString();
    });
  const gVals = nice ? nice.ticks : Array.from({ length: gridCount + 1 }, (_, i) => lo + (range * i) / gridCount);

  return (
    <div ref={ref} style={containerStyle}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        <defs>
          <clipPath id={clipId}>
            <rect x={padX} y={padY - 4} width={Math.max(0, iW * prog)} height={iH + 8} />
          </clipPath>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${id}g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color || "var(--brand)"} stopOpacity={single ? 0.34 : 0.22} />
              <stop offset="55%" stopColor={s.color || "var(--brand)"} stopOpacity={single ? 0.1 : 0.06} />
              <stop offset="100%" stopColor={s.color || "var(--brand)"} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {bgBands?.map((b, bi) => {
          const yTop = cy(Math.min(hi, b.hi));
          const yBot = cy(Math.max(lo, b.lo));
          return <rect key={bi} x={padX} y={yTop} width={iW} height={Math.max(0, yBot - yTop)} fill={b.fill} opacity="0.09" />;
        })}
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">{fmt(v)}</text>
          </g>
        ))}
        {target && (
          <>
            <line x1={padX} x2={padX + iW} y1={cy(target.value)} y2={cy(target.value)}
              stroke={target.color || "var(--ok)"} strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
            {target.label && (
              <text x={padX + iW + 3} y={cy(target.value) + 3} fontSize="9"
                fill={target.color || "var(--ok)"} fontFamily="var(--font-mono)">{target.label}</text>
            )}
          </>
        )}
        <g clipPath={`url(#${clipId})`}>
          {/* area fills (decaying gradient) */}
          {series.map((s, si) => {
            if (!s.values?.length) return null;
            const doFill = s.fill !== undefined ? s.fill : single;
            if (!doFill) return null;
            const d = runsOf(s.values)
              .filter((p) => p.length > 1)
              .map((p) => `${smoothLine(p)} L ${p[p.length - 1]![0].toFixed(1)} ${baseY.toFixed(1)} L ${p[0]![0].toFixed(1)} ${baseY.toFixed(1)} Z`)
              .join(" ");
            return d ? <path key={"a" + si} d={d} fill={`url(#${id}g${si})`} stroke="none" /> : null;
          })}
          {/* lines - and a point with no neighbour on either side as a dot,
              a little wider than the line, so a lone sample reads as one
              rather than as a speck the renderer left behind */}
          {series.map((s, si) => {
            if (!s.values?.length) return null;
            const runs = runsOf(s.values);
            return (
              <g key={si} opacity={s.opacity ?? 1}>
                <path d={runs.filter((r) => r.length > 1).map((r) => runPath(r, s.curve)).join(" ")} fill="none"
                  stroke={s.color || "var(--brand)"} strokeWidth={s.width || 2}
                  strokeLinejoin="round" strokeLinecap="round"
                  strokeDasharray={s.dashed ? "4 3" : undefined} />
                {runs.filter((r) => r.length === 1).map((r, k) => (
                  <circle key={k} cx={r[0]![0]} cy={r[0]![1]} r={(s.width || 2) / 2 + 1} fill={s.color || "var(--brand)"} />
                ))}
              </g>
            );
          })}
          {/* end-point marker on single-series charts */}
          {single &&
            (() => {
              const s = series.find((x) => x.values?.length);
              if (!s) return null;
              let lastI = s.values.length - 1;
              while (lastI >= 0 && !Number.isFinite(s.values[lastI]!)) lastI--;
              if (lastI < 0) return null;
              return <circle cx={cx(lastI)} cy={cy(s.values[lastI]!)} r="3" fill={s.color || "var(--brand)"} stroke="var(--surface)" strokeWidth="1.5" />;
            })()}
        </g>
        {hover && shownI != null && (
          <g pointerEvents="none">
            <line x1={cx(shownI)} x2={cx(shownI)} y1={padY} y2={padY + iH} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
            {series.map((s, si) => {
              const v = s.values?.[shownI];
              return v != null && Number.isFinite(v) && v >= lo && v <= hi
                ? <circle key={si} cx={cx(shownI)} cy={cy(v)} r="3.5" fill={s.color || "var(--brand)"} stroke="var(--surface)" strokeWidth="1.5" opacity={s.opacity ?? 1} />
                : null;
            })}
            {pointLabels && (() => {
              /* A label beside each dot, in its line's colour. Lines that sit
                 together (three upstreams at 0 rps) would stack their labels on
                 one another, so they are spread 17px apart, kept inside the
                 plot, with a tick back to the dot when moved. */
              const x = cx(shownI);
              const top = padY + 8, bottom = padY + iH - 8;
              const items = series.flatMap((s, si) => {
                const v = s.values?.[shownI];
                if (v == null || !Number.isFinite(v) || !hover.rows[si]) return [];
                const extra = hover.sub?.(si, shownI);
                const dotY = Math.min(Math.max(cy(v), padY), padY + iH);
                return [{ si, dotY, y: Math.min(Math.max(dotY, top), bottom), text: hover.fmt(v) + (extra ? ` · ${extra}` : ""),
                  color: s.color || "var(--brand)", bold: !!hover.rows[si]!.bold, faded: (s.opacity ?? 1) < 0.5 }];
              }).sort((a, b) => a.y - b.y);
              for (let k = 1; k < items.length; k++) items[k]!.y = Math.max(items[k]!.y, items[k - 1]!.y + 17);
              const over = items.length ? items[items.length - 1]!.y - bottom : 0;
              if (over > 0) for (const it of items) it.y = Math.max(top, it.y - over);
              const time = hover.title(shownI);
              const tw = time.length * 5.9 + 12;
              const tx = Math.min(Math.max(x - tw / 2, padX), padX + iW - tw);
              return (
                <>
                  {time && (
                    <g>
                      <rect x={tx} y={padY - 15} width={tw} height={14} rx={7} fill="var(--surface-2)" stroke="var(--line-2)" />
                      <text x={tx + tw / 2} y={padY - 5} textAnchor="middle" fontSize="9.5" fontFamily="var(--font-mono)" fill="var(--text-2)">{time}</text>
                    </g>
                  )}
                  {items.map((it) => {
                    const lw = it.text.length * 6.4 + 12;
                    const right = x + 10 + lw <= padX + iW;
                    const lx = right ? x + 10 : x - 10 - lw;
                    return (
                      <g key={it.si} opacity={it.faded ? 0.35 : 1}>
                        {Math.abs(it.y - it.dotY) > 3 && (
                          <line x1={x} y1={it.dotY} x2={right ? lx : lx + lw} y2={it.y} stroke={it.color} strokeWidth="1" opacity="0.5" />
                        )}
                        <rect x={lx} y={it.y - 8.5} width={lw} height={17} rx={4} fill="var(--surface-2)" stroke={it.color} strokeWidth={it.bold ? 1.4 : 1} />
                        <text x={lx + 6} y={it.y + 3.6} fontSize="10.5" fontFamily="var(--font-mono)" fill="var(--text)" fontWeight={it.bold ? 700 : 500}>{it.text}</text>
                      </g>
                    );
                  })}
                </>
              );
            })()}
          </g>
        )}
        {hover && (
          <rect x={padX} y={padY} width={Math.max(0, iW)} height={Math.max(0, iH)} fill="transparent"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const f = r.width ? (e.clientX - r.left) / r.width : 0;
              const i = nearest(f);
              if (!controlled) setHovI(i);
              onHoverAt?.(timed ? timed.xs[i]! : i);
            }}
            onMouseLeave={() => { if (!controlled) setHovI(null); onHoverAt?.(null); }} />
        )}
        {timed && xTicks
          ? xTickLabels(xTicks, xAt, padX, iW, padY + iH + 13)
          : xLabels !== null && (xLabels || X_DEFAULT).map((lab, _i, _a) => (
            <text key={"x" + _i} x={padX + (_a.length > 1 ? (_i / (_a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={_i === 0 ? "start" : _i === _a.length - 1 ? "end" : "middle"}>{lab}</text>
          ))}
      </svg>
      {hover && hoverBox && shownI != null && (
        <div style={{
          position: "absolute", top: padY, zIndex: 5, pointerEvents: "none",
          ...(cx(shownI) > w / 2 ? { right: w - cx(shownI) + 12 } : { left: cx(shownI) + 12 }),
          background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 10px",
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)", fontSize: 11, minWidth: 160, maxWidth: 320,
        }}>
          <div className="gw-mono" style={{ color: "var(--text-3)", marginBottom: 6 }}>{hover.title(shownI)}</div>
          {series.map((s, si) => {
            const row = hover.rows[si];
            if (!row) return null;
            const v = s.values?.[shownI];
            return (
              <div key={si} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
                <span style={{ width: 9, height: row.bold ? 3 : 2, background: s.color || "var(--brand)", borderRadius: 1, flexShrink: 0 }} />
                <span className="gw-mono" style={{ flex: 1, color: row.bold ? "var(--text)" : "var(--text-2)", fontWeight: row.bold ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</span>
                <span className="gw-mono gw-tnum" style={{ color: "var(--text)", fontWeight: 600 }}>{v != null && Number.isFinite(v) ? hover.fmt(v) : "—"}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── StackedAreaChart ────────────────────────────────────────────────── */
/* layers: [{name, values, color}] — bottom layer first */
export function StackedAreaChart({
  layers,
  height,
  padX = 40,
  padY = 10,
  xLabels,
  normalized = false,
  id = "sa",
}: {
  layers: Layer[];
  height?: number;
  padX?: number;
  padY?: number;
  /** null ⇒ no x labels (and no reserved space); undefined ⇒ X_DEFAULT */
  xLabels?: string[] | null;
  normalized?: boolean;
  id?: string;
}) {
  const [ref, w, oh] = useChartDims(600, height || 200);
  const h = height || oh;
  const prog = useAnimProg(id + (layers?.[0]?.values?.length ?? 0));

  const containerStyle: React.CSSProperties = { width: "100%", height: height ? height : "100%", overflow: "hidden" };
  if (!layers?.length || !layers[0]!.values?.length) return <div ref={ref} style={containerStyle} />;

  const n = layers[0]!.values.length;
  const iW = w - padX * 2,
    iH = h - padY * 2 - (xLabels === null ? 0 : 18);
  const cumV = layers.map((_, li) =>
    Array.from({ length: n }, (__, i) => layers.slice(0, li + 1).reduce((s, l) => s + (l.values[i] || 0), 0)),
  );
  const maxV = normalized ? 100 : Math.max(...cumV[cumV.length - 1]!) * 1.05 || 1;
  const cx = (i: number) => padX + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
  const cy = (v: number) => padY + iH - (v / maxV) * iH;
  const clipId = `${id}cp`;
  const gVals = [0.25, 0.5, 0.75, 1.0].map((f) => maxV * f);
  const fmt = (v: number) => (normalized ? v.toFixed(0) + "%" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : Math.round(v).toString());

  return (
    <div ref={ref} style={containerStyle}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        <defs>
          <clipPath id={clipId}><rect x={padX} y={padY} width={Math.max(0, iW * prog)} height={iH + 2} /></clipPath>
        </defs>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">{fmt(v)}</text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {layers.map((layer, li) => {
            const top = cumV[li]!;
            const bot = li > 0 ? cumV[li - 1]! : Array<number>(n).fill(0);
            const poly = [
              ...top.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`),
              ...[...bot].reverse().map((v, i) => `${cx(n - 1 - i).toFixed(1)},${cy(v).toFixed(1)}`),
            ].join(" ");
            const topLine = top.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`).join(" ");
            return (
              <g key={li}>
                <polygon points={poly} fill={layer.color} opacity="0.65" />
                <polyline points={topLine} fill="none" stroke={layer.color} strokeWidth="1" opacity="0.9" />
              </g>
            );
          })}
        </g>
        {xLabels !== null && (xLabels || X_DEFAULT).map((lab, _i, _a) => (
          <text key={"x" + _i} x={padX + (_a.length > 1 ? (_i / (_a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={_i === 0 ? "start" : _i === _a.length - 1 ? "end" : "middle"}>{lab}</text>
        ))}
      </svg>
    </div>
  );
}

/* ── ColumnChart ─────────────────────────────────────────────────────── */
/* stacks: [{name, values, color}] — bottom to top */
function NewColumnChart({
  stacks,
  height,
  padX = 40,
  padY = 10,
  xLabels,
  highlightSpikes = false,
  id = "col",
  onBarClick,
  selected = null,
  tooltip,
  integerY = false,
  xs,
  barSpan = 0,
  xDomain,
  xTicks,
  padR,
  hoverAt,
  onHoverAt,
}: {
  stacks: Layer[];
  height?: number;
  padX?: number;
  padY?: number;
  /** null ⇒ no x labels (and no reserved space); undefined ⇒ X_DEFAULT */
  xLabels?: string[] | null;
  highlightSpikes?: boolean;
  id?: string;
  /** Makes the bars clickable - the index of the bar clicked. */
  onBarClick?: (i: number) => void;
  /** A bar to keep highlighted (the one last clicked). */
  selected?: number | null;
  /** What hovering bar i shows, in a card beside it. */
  tooltip?: (i: number) => React.ReactNode;
  /** Counts: gridlines on whole, round numbers - never "1, 1, 1" on a short axis. */
  integerY?: boolean;
  /** Lay bars out by time: bar i covers the `barSpan` before `xs[i]`, on an
   *  axis from `xDomain[0]` to `xDomain[1]` - cut where it runs past either
   *  end - so it lines up with line charts on the same domain. */
  xs?: number[];
  barSpan?: number;
  xDomain?: [number, number];
  /** Labels at given times (with `xs`/`xDomain`), instead of `xLabels`. */
  xTicks?: XTick[];
  /** The right margin, when it differs from the left (`padX`). */
  padR?: number;
  /** A hover the parent owns, in `xs` units - see LineChart. A bar reports
   *  its middle; the space between bars reports the time under the pointer. */
  hoverAt?: number | null;
  onHoverAt?: (at: number | null) => void;
}) {
  const [ref, w, oh] = useChartDims(600, height || 160);
  const h = height || oh;
  const prog = useAnimProg(id + (stacks?.[0]?.values?.length ?? 0));
  const [hov, setHov] = useState<number | null>(null);

  const containerStyle: React.CSSProperties = {
    width: "100%",
    height: height ? height : "100%",
    overflow: tooltip ? "visible" : "hidden",
    position: "relative",
  };
  if (!stacks?.length || !stacks[0]!.values?.length) return <div ref={ref} style={containerStyle} />;

  const n = stacks[0]!.values.length;
  const iW = w - padX - (padR ?? padX),
    iH = h - padY * 2 - (xLabels === null ? 0 : 18);
  const totals = Array.from({ length: n }, (_, i) => stacks.reduce((s, l) => s + (l.values[i] || 0), 0));
  const top = Math.max(...totals);
  const intStep = integerY ? Math.max(1, niceNum(top / 4)) : 0;
  const maxV = integerY ? Math.max(intStep, Math.ceil(top / intStep) * intStep) : top * 1.1 || 1;
  const avg = totals.reduce((a, b) => a + b, 0) / n;
  const timed = xs && xDomain && xDomain[1] > xDomain[0] ? { xs, d0: xDomain[0], d1: xDomain[1] } : null;
  const xAt = (at: number) => (timed ? padX + ((at - timed.d0) / (timed.d1 - timed.d0)) * iW : padX);
  /* Where bar i sits: its slot of n, or its stretch of time cut to the axis. */
  const geo = (i: number): { x: number; w: number } => {
    if (!timed) {
      const w0 = Math.max(2, iW / n - 2);
      return { x: padX + (i + 0.5) * (iW / n) - w0 / 2, w: w0 };
    }
    const end = timed.xs[i] ?? timed.d0;
    const x0 = xAt(Math.max(end - barSpan, timed.d0));
    const x1 = xAt(Math.min(end, timed.d1));
    return { x: x0 + 0.5, w: Math.max(0, x1 - x0 - 1) };
  };
  /* The bar a position on the axis falls in (a time, or an index). */
  const barAt = (at: number) => {
    const k = timed ? timed.xs.findIndex((x) => at > x - barSpan && at <= x) : Math.round(at);
    return k >= 0 && k < n ? k : null;
  };
  const controlled = hoverAt !== undefined;
  const shown = controlled ? (hoverAt == null ? null : barAt(hoverAt)) : hov;
  const report = (at: number | null) => onHoverAt?.(at);
  const cy = (v: number) => padY + iH - (v / maxV) * iH;
  const gVals = integerY
    ? Array.from({ length: Math.round(maxV / intStep) }, (_, k) => (k + 1) * intStep)
    : [0.25, 0.5, 0.75, 1.0].map((f) => Math.round(maxV * f));

  return (
    <div ref={ref} style={containerStyle}>
      <svg width={w} height={h} style={{ overflow: "visible", display: "block" }}>
        {gVals.map((v, i) => (
          <g key={i}>
            <line x1={padX} x2={padX + iW} y1={cy(v)} y2={cy(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={padX - 5} y={cy(v) + 3} textAnchor="end" fontSize="9" fill="var(--text-3)" fontFamily="var(--font-mono)">
              {v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}
            </text>
          </g>
        ))}
        {/* the space between bars reports the time under the pointer, so a
            shared crosshair follows it here too */}
        {onHoverAt && (
          <rect x={padX} y={padY} width={Math.max(0, iW)} height={Math.max(0, iH)} fill="transparent"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const f = r.width ? (e.clientX - r.left) / r.width : 0;
              report(timed ? timed.d0 + f * (timed.d1 - timed.d0) : f * (n - 1));
            }}
            onMouseLeave={() => report(null)} />
        )}
        {timed && controlled && hoverAt != null && hoverAt >= timed.d0 && hoverAt <= timed.d1 && (
          <line x1={xAt(hoverAt)} x2={xAt(hoverAt)} y1={padY} y2={padY + iH} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" pointerEvents="none" />
        )}
        {totals.map((total, i) => {
          if (total === 0 || i / n > prog) return null;
          const isSpike = highlightSpikes && total > avg * 2.2;
          const { x: bx, w: barW } = geo(i);
          if (barW <= 0) return null;
          let cum = 0;
          return (
            <g key={i}
              onMouseEnter={() => { if (!controlled) setHov(i); report(timed ? (timed.xs[i] ?? 0) - barSpan / 2 : i); }}
              onMouseLeave={() => { if (!controlled) setHov(null); report(null); }}
              onClick={onBarClick ? () => onBarClick(i) : undefined} style={onBarClick ? { cursor: "pointer" } : undefined}>
              {/* a full-height hit area, so a short bar is still easy to click */}
              {onBarClick && <rect x={bx - 1} y={padY} width={barW + 2} height={iH} fill="transparent" />}
              {stacks.map((s, si) => {
                const v = s.values[i] || 0;
                if (v === 0) { cum += v; return null; }
                const bh = (v / maxV) * iH;
                const y = padY + iH - ((cum + v) / maxV) * iH;
                cum += v;
                return (
                  <rect key={si} x={bx} y={y} width={barW} height={Math.max(bh, 0.5)}
                    fill={isSpike ? "var(--warn)" : s.color} opacity={isSpike ? 0.88 : 0.7}
                    rx={si === stacks.length - 1 ? 1.5 : 0} />
                );
              })}
              {(shown === i || selected === i) && <rect x={bx - 1} y={padY} width={barW + 2} height={iH} fill="white" opacity={selected === i ? 0.09 : 0.06} rx="2" pointerEvents="none" />}
            </g>
          );
        })}
        {timed && xTicks
          ? xTickLabels(xTicks, xAt, padX, iW, padY + iH + 13)
          : xLabels !== null && (xLabels || X_DEFAULT).map((lab, _i, _a) => (
            <text key={"x" + _i} x={padX + (_a.length > 1 ? (_i / (_a.length - 1)) * iW : iW / 2)} y={padY + iH + 13} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={_i === 0 ? "start" : _i === _a.length - 1 ? "end" : "middle"}>{lab}</text>
          ))}
      </svg>
      {tooltip && shown != null && totals[shown]! > 0 && (
        <div style={{
          position: "absolute", top: padY, zIndex: 5, pointerEvents: "none",
          ...(geo(shown).x > w / 2 ? { right: w - geo(shown).x + 8 } : { left: geo(shown).x + geo(shown).w + 8 }),
          background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 10px",
          boxShadow: "0 6px 18px rgba(0,0,0,0.35)", fontSize: 11, minWidth: 170, maxWidth: 320,
        }}>
          {tooltip(shown)}
        </div>
      )}
    </div>
  );
}

/* ── SparkLine ───────────────────────────────────────────────────────── */
export function SparkLine({
  values,
  color = "var(--brand)",
  width = 60,
  height = 22,
}: {
  values?: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!values?.length || values.length < 2) return null;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / range) * (height - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block", flexShrink: 0, opacity: 0.75 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── ChartLegend ─────────────────────────────────────────────────────── */
export interface LegendItem {
  label: string;
  color: string;
  square?: boolean;
  dashed?: boolean;
}
export function ChartLegend({ items, style }: { items: LegendItem[]; style?: React.CSSProperties }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", ...style }}>
      {(items || []).map((item, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, color: "var(--text-3)" }}>
          <span
            style={{
              display: "inline-block",
              flexShrink: 0,
              width: item.square ? 8 : 14,
              height: item.square ? 8 : 2,
              borderRadius: item.square ? 2 : 0,
              background: item.dashed ? "transparent" : item.color,
              borderTop: item.dashed ? `2px dashed ${item.color}` : undefined,
              opacity: item.square ? 0.8 : 1,
            }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/* DASHBOARD_NEW_UI: the two charts 0.28 changed draw as in 0.28 under the
   flag, else as in 0.27 (src/legacy) - the curve that overshoots its points
   included. The props are 0.28's, a superset; 0.27 callers pass only its own. */
export function LineChart(props: React.ComponentProps<typeof NewLineChart>) {
  return useNewUi() ? <NewLineChart {...props} /> : <LegacyLineChart {...props} />;
}

export function ColumnChart(props: React.ComponentProps<typeof NewColumnChart>) {
  return useNewUi() ? <NewColumnChart {...props} /> : <LegacyColumnChart {...props} />;
}
