"use client";

/* AvailabilityBreakdown — availability in blocks: a row for the requests the
 * router served, then a row per provider, a block per stretch
 * of the clock (`bucketGrid`: 30 minutes on 12 hours) coloured by that
 * stretch's availability - the share of its tries that succeeded - and the
 * row's availability over the window at its end. Drawn in a router's row of
 * the Routers table and in the Overview's Availability card.
 *
 * Live data: /api/metrics/upstream-timeline (tries and failed tries per
 * provider per stretch). Honest-state notes:
 *  - a block a provider took no tries in is "No traffic", grey: a standby
 *    backup is not 100% available, it was not asked;
 *  - the top row is what clients got: the share of their requests the router
 *    served (the Failed requests card's recorded counts), so a try that failed
 *    and was served by another provider doesn't count against it. Where the
 *    store has no such counts it adds up the providers' tries, and says so;
 *  - a read the store refused says so above the rows. */

import { useState } from "react";
import type { MetricWindow, UpstreamTimeline, UpstreamTimelineCell } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useChartDims } from "@/components/gateway/charts";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { barSpanWords, barWords, timeTicks } from "@/lib/chart-time";

const TARGET = 0.999;
const ROW_H = 16;
const ROW_GAP = 6;
const AXIS_H = 18;
const ALL = "All providers";
const SERVED = "Requests served";

/** A block's colour by its availability: at the target, under it, under 99%. */
const LEVELS = [
  { min: TARGET, color: "var(--ok)", label: "99.9% or more" },
  { min: 0.99, color: "var(--warn)", label: "99% to 99.9%" },
  { min: -Infinity, color: "var(--err)", label: "Under 99%" },
] as const;
const levelOf = (a: number) => LEVELS.find((l) => a >= l.min)!;
const NO_TRAFFIC = "var(--line-2)";

/** Two decimals, without the zeros that say nothing; under 100 never reads as 100. */
const pct = (a: number) => {
  const p = a * 100;
  if (p < 100 && p > 99.99) return "99.99%";
  return p.toFixed(2).replace(/\.?0+$/, "") + "%";
};

interface Block { t: number; tries: number; failed: number }
interface Row { name: string; backup: boolean; inConfig: boolean; blocks: (Block | null)[] }

const triesOf = (c: UpstreamTimelineCell | undefined): Block | null =>
  c && (c.rps ?? 0) > 0 ? { t: c.t, tries: c.rps!, failed: Math.min(c.failedRps ?? 0, c.rps!) } : null;
const availOf = (b: { tries: number; failed: number } | null) => (b && b.tries > 0 ? 1 - b.failed / b.tries : null);
const total = (blocks: (Block | null)[]) =>
  blocks.reduce((a, b) => (b ? { tries: a.tries + b.tries, failed: a.failed + b.failed } : a), { tries: 0, failed: 0 });

export function AvailabilityBreakdown({ spec, routerId, win }: {
  spec: string;
  /** The config router whose providers the rows are; null when no values file names one. */
  routerId: string | null;
  win: MetricWindow;
}) {
  const { scopeQ } = useFilters();
  const rid = routerId ? `&routerId=${encodeURIComponent(routerId)}` : "";
  const { data: tl } = useApi<UpstreamTimeline>(`/api/metrics/upstream-timeline?spec=${encodeURIComponent(spec)}&window=${win}${rid}${scopeQ}`);
  const [hovI, setHovI] = useState<number | null>(null);

  const stepSec = tl?.grid.stepSec ?? 0;
  const times = tl ? Array.from({ length: Math.floor((tl.grid.end - tl.grid.start) / stepSec) + 1 }, (_, k) => tl.grid.start + k * stepSec) : [];
  const providers: Row[] = (tl?.upstreams ?? []).map((u) => ({
    name: u.upstream,
    backup: u.role === "backup",
    inConfig: u.inConfig,
    blocks: times.map((t) => triesOf(u.cells.find((c) => c.t === t))),
  }));
  // The top row is what clients got: the share of their requests the router served, from the Failed
  // requests card's counts. A try that failed and was then served elsewhere doesn't count against it.
  // Where the store has no such counts, it adds up the providers' tries instead, and says so.
  const served = tl?.served ?? null;
  const all: Row = served
    ? {
      name: SERVED, backup: false, inConfig: true,
      blocks: times.map((t) => {
        const c = served.find((x) => x.t === t);
        return c && c.requests ? { t, tries: c.requests, failed: c.failed ?? 0 } : null;
      }),
    }
    : {
      name: ALL, backup: false, inConfig: true,
      blocks: times.map((t, k) => {
        const sum = total(providers.map((p) => p.blocks[k] ?? null));
        return sum.tries > 0 ? { t, ...sum } : null;
      }),
    };
  const rows = tl ? [all, ...providers] : [];
  const rowCount = tl ? rows.length : 4;
  const height = rowCount * (ROW_H + ROW_GAP) + 8 + AXIS_H;
  const [wrapRef, w] = useChartDims(600, height);

  const narrow = w < 640;
  const LEFT = narrow ? 104 : 160;
  const RIGHT = narrow ? 56 : 72;
  const plotW = Math.max(60, w - LEFT - RIGHT);
  // From the first block's start to now; the block still filling is cut at now.
  const x0 = tl ? tl.grid.start - stepSec : 0;
  const x1 = tl ? tl.asOf : 1;
  const x = (t: number) => LEFT + ((Math.min(Math.max(t, x0), x1) - x0) / (x1 - x0 || 1)) * plotW;
  const colOf = (t: number) => { const a = x(t - stepSec), b = x(t); return { x: a + 0.75, w: Math.max(1, b - a - 1.5) }; };
  const rowY = (i: number) => 4 + i * (ROW_H + ROW_GAP) + (i > 0 ? 6 : 0);
  const bottom = rowY(rowCount - 1) + ROW_H;

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!tl || !times.length) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (px < LEFT || px > LEFT + plotW) return setHovI(null);
    const t = x0 + ((px - LEFT) / plotW) * (x1 - x0);
    const i = times.findIndex((end) => t > end - stepSec && t <= end);
    setHovI(i >= 0 ? i : null);
  }
  const hovCol = hovI !== null && times[hovI] !== undefined ? colOf(times[hovI]!) : null;
  const tipRight = hovCol !== null && hovCol.x > LEFT + plotW * 0.55;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 8, fontSize: 11, color: "var(--text-4)" }}>
        {stepSec > 0 && (
          <span>
            a block per {barSpanWords(stepSec)} · {served ? "the top row: requests the router served; each provider: its tries that succeeded" : "coloured by the share of tries that succeeded"}
          </span>
        )}
        {tl && !tl.available && <span style={{ color: "var(--warn)" }}>incomplete: the metrics store did not answer every read</span>}
      </div>
      <div ref={wrapRef} style={{ position: "relative", width: "100%", height }} onMouseMove={onMove} onMouseLeave={() => setHovI(null)}>
        <svg width={w} height={height} style={{ display: "block" }}>
          {hovCol && <rect x={hovCol.x - 1.5} y={0} width={hovCol.w + 3} height={bottom + 4} fill="var(--text)" opacity="0.07" rx="2" />}
          {!tl && Array.from({ length: rowCount }, (_, i) => (
            <rect key={i} x={LEFT} y={rowY(i)} width={plotW} height={ROW_H} rx="3" fill="var(--line)" opacity="0.35" />
          ))}
          {tl && providers.length === 0 && (
            <text x={LEFT} y={rowY(1) + 12} fontSize="11" fill="var(--text-4)">No providers on this router.</text>
          )}
          {rows.map((r, i) => {
            const y = rowY(i);
            const label = r.name + (r.backup ? " (backup)" : "");
            const maxChars = Math.floor((LEFT - 12) / 6.4);
            const whole = availOf(total(r.blocks));
            return (
              <g key={r.name}>
                <text x={0} y={y + 12} fontSize="11.5" fontWeight={i === 0 ? 600 : 400}
                  fill={i === 0 ? "var(--text)" : r.inConfig ? "var(--text-2)" : "var(--text-4)"} fontFamily={i === 0 ? undefined : "var(--font-mono)"}>
                  <title>{r.inConfig ? label : `${label} - not in the config`}</title>
                  {label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label}
                </text>
                {times.map((t, k) => {
                  const b = r.blocks[k];
                  const a = availOf(b ?? null);
                  const { x: bx, w: bw } = colOf(t);
                  return <rect key={t} x={bx} y={y} width={bw} height={ROW_H} rx="2" fill={a === null ? NO_TRAFFIC : levelOf(a).color} opacity={a === null ? 0.5 : 0.85} />;
                })}
                <text x={LEFT + plotW + 10} y={y + 12} fontSize="11.5" fontWeight={i === 0 ? 600 : 500}
                  fill={whole === null ? "var(--text-4)" : whole < TARGET ? "var(--err)" : "var(--text)"} className="gw-tnum" fontFamily="var(--font-mono)">
                  {whole === null ? "—" : pct(whole)}
                </text>
              </g>
            );
          })}
          {tl && (timeTicks([x0, x1]) ?? []).map((tk, k) => (
            <text key={k} x={x(tk.at)} y={bottom + AXIS_H - 2} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor="middle">{tk.label}</text>
          ))}
        </svg>
        {hovI !== null && hovCol && tl && (
          <div style={{ position: "absolute", top: 0, ...(tipRight ? { right: w - hovCol.x + 8 } : { left: hovCol.x + hovCol.w + 8 }), pointerEvents: "none", background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 10px", whiteSpace: "nowrap", boxShadow: "0 6px 18px rgba(0,0,0,0.35)", fontSize: 11.5, display: "grid", gap: 3, minWidth: 190, zIndex: 5 }}>
            <div className="gw-mono" style={{ color: "var(--text-3)", fontSize: 10.5, marginBottom: 3 }}>{barWords(times[hovI]!, stepSec, tl.asOf)}</div>
            {rows.map((r, i) => {
              const a = availOf(r.blocks[hovI] ?? null);
              return (
                <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: i === 0 ? 600 : 400 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: a === null ? NO_TRAFFIC : levelOf(a).color }} />
                  <span style={{ flex: 1, color: "var(--text-2)" }}>{r.name}</span>
                  <span className="gw-mono gw-tnum" style={{ color: a === null ? "var(--text-4)" : "var(--text)" }}>{a === null ? "no traffic" : pct(a)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, paddingLeft: LEFT, fontSize: 10.5, color: "var(--text-3)" }}>
        {LEVELS.map((l) => <Key key={l.label} color={l.color} label={l.label} />)}
        <Key color={NO_TRAFFIC} label="No traffic" />
      </div>
    </div>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, opacity: 0.85 }} />{label}
    </span>
  );
}
