"use client";

/* AvailabilityBreakdown — the ChainDetail Availability view: the chain in bars
 * on the clock, and its upstreams under the same bars, so a bad stretch and
 * the upstreams that went unhealthy read off one column.
 *
 *  1. Tries — a bar per stretch of the clock (`bucketGrid`, 30 minutes on
 *     12 hours), from 0: the chain's tries that succeeded and that failed.
 *     Bars, not an availability line: on a quiet chain one failed try in a
 *     point is a 50% availability, and a line of those reads as an outage.
 *  2. Providers — a row per upstream, a cell per bar
 *     (`/api/metrics/upstream-timeline`), coloured by `HealthState` through
 *     lib/health.ts; a backup that took traffic gets a bar under the cell.
 *
 * A bar or cell the store didn't return is left blank, never a 0 or a green
 * cell. Hovering anywhere in a bar's column reads both parts at that bar. */

import { useState } from "react";
import type { HealthState, MetricWindow, UpstreamTimeline, UpstreamTimelineRow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { niceScale, useChartDims } from "@/components/gateway/charts";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { HEALTH_LABEL, healthColor } from "@/lib/health";
import { barSpanWords, barWords, timeTicks } from "@/lib/chart-time";
import { fmtComma } from "@/lib/format";
import { roFmtTime } from "./InteractiveChart";

/** The backups' colour: the "took traffic" bar under a backup's cell. */
export const BACKUP_COLOR = "#fb923c";

const TARGET = 99.9;
const BARS_H = 140;
const ROW_H = 14;
const ROW_GAP = 6;
const TITLE_H = 30;
const AXIS_H = 18;
/** The least height a bar's part that isn't zero is drawn at, as the other bar charts. */
const MIN_PART_PX = 3;

/** Two decimals, without the zeros that say nothing; above 0 never reads as 0. */
const pct = (v: number) => (v > 0 && v < 0.005 ? "<0.01%" : v.toFixed(2).replace(/\.?0+$/, "") + "%");

/** Consecutive cells matching `pick`, as [first t, last t] pairs. */
function runs(row: UpstreamTimelineRow, pick: (s: HealthState | null) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let open: [number, number] | null = null;
  for (const c of row.cells) {
    if (pick(c.state)) {
      if (open) open[1] = c.t;
      else open = [c.t, c.t];
    } else if (open) {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

const fmtShare = (share: number): string => {
  const p = share * 100;
  if (p > 0 && p < 1) return "<1%";
  return Math.round(p) + "%";
};

/** The short status at the end of a provider row. */
function rowStatus(row: UpstreamTimelineRow, stepSec: number, win: string): { text: string; color: string } {
  const span = ([a, b]: [number, number]) =>
    `${roFmtTime(new Date((a - stepSec) * 1000), win)}-${roFmtTime(new Date(b * 1000), win)}`;
  const bad = runs(row, (s) => s === "unhealthy");
  const last = bad[bad.length - 1];
  const unhealthy = last ? `Unhealthy ${span(last)}${bad.length > 1 ? ` +${bad.length - 1} more` : ""}` : null;
  const maxShare = row.cells.reduce((m, c) => ((c.rps ?? 0) > 0 && c.share !== null ? Math.max(m, c.share) : m), -1);
  const anyData = row.cells.some((c) => c.state !== null);
  const anyOk = row.cells.some((c) => c.state === "operational");
  if (row.role === "backup") {
    const served = maxShare > 0 ? `served up to ${fmtShare(maxShare)}` : null;
    if (unhealthy) return { text: served ? `${unhealthy} · ${served}` : unhealthy, color: "var(--err)" };
    if (served) return { text: served, color: BACKUP_COLOR };
    if (!anyData) return { text: "no data", color: "var(--text-4)" };
    return anyOk ? { text: "standby", color: "var(--text-3)" } : { text: HEALTH_LABEL.unknown, color: healthColor("unknown") };
  }
  if (unhealthy) return { text: unhealthy, color: "var(--err)" };
  if (!anyData) return { text: "no data", color: "var(--text-4)" };
  return anyOk
    ? { text: HEALTH_LABEL.operational, color: healthColor("operational") }
    : { text: HEALTH_LABEL.unknown, color: healthColor("unknown") };
}

export function AvailabilityBreakdown({ spec, routerId, win, hasBackup }: {
  spec: string;
  /** The config router the row is; null when no values file names it. */
  routerId: string | null;
  win: MetricWindow;
  /** The mounted config marks at least one backup for this router. */
  hasBackup: boolean;
}) {
  const { scopeQ } = useFilters();
  const rid = routerId ? `&routerId=${encodeURIComponent(routerId)}` : "";
  const { data: tl } = useApi<UpstreamTimeline>(`/api/metrics/upstream-timeline?spec=${encodeURIComponent(spec)}&window=${win}${rid}${scopeQ}`);
  const [hovI, setHovI] = useState<number | null>(null);

  const bars = tl?.bars ?? [];
  const stepSec = tl?.grid.stepSec ?? 0;
  const rows = tl?.upstreams ?? [];
  const rowCount = tl ? Math.max(rows.length, 1) : 3;
  const height = 8 + BARS_H + TITLE_H + rowCount * (ROW_H + ROW_GAP) + AXIS_H;
  const [wrapRef, w] = useChartDims(600, height);

  const narrow = w < 640;
  const LEFT = narrow ? 104 : 150;
  const RIGHT = narrow ? 0 : 200;
  const plotW = Math.max(60, w - LEFT - RIGHT);
  // The axis runs from the first bar's start to now; the bar still filling is cut at now.
  const x0 = tl ? tl.grid.start - stepSec : 0;
  const x1 = tl ? tl.asOf : 1;
  const x = (t: number) => LEFT + ((Math.min(Math.max(t, x0), x1) - x0) / (x1 - x0 || 1)) * plotW;
  const colOf = (t: number) => { const a = x(t - stepSec), b = x(t); return { x: a + 0.5, w: Math.max(1, b - a - 1) }; };

  // Part 1: tries per bar, from 0 on round steps.
  const top = 8;
  const totals = bars.map((b) => (b.ok ?? 0) + (b.failed ?? 0));
  const scale = niceScale(0, Math.max(4, ...totals));
  const yMax = scale.hi;
  const yB = (v: number) => top + BARS_H - (v / yMax) * BARS_H;

  // Part 2.
  const pTop = top + BARS_H + TITLE_H;
  const rowY = (i: number) => pTop + i * (ROW_H + ROW_GAP);
  const bottom = pTop + rowCount * (ROW_H + ROW_GAP) - ROW_GAP;

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!tl || !bars.length) return;
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    if (px < LEFT || px > LEFT + plotW) return setHovI(null);
    const t = x0 + ((px - LEFT) / plotW) * (x1 - x0);
    const i = bars.findIndex((b) => t > b.t - stepSec && t <= b.t);
    setHovI(i >= 0 ? i : null);
  }

  const hov = hovI === null || !bars[hovI] ? null : (() => {
    const b = bars[hovI]!;
    const cellAt = (r: UpstreamTimelineRow) => r.cells.find((c) => c.t === b.t);
    const unhealthy = rows.filter((r) => cellAt(r)?.state === "unhealthy").map((r) => r.upstream);
    const serving = rows.filter((r) => r.role === "backup" && (cellAt(r)?.rps ?? 0) > 0);
    const backupShare = serving.reduce((a, r) => a + (cellAt(r)?.share ?? 0), 0);
    const total = (b.ok ?? 0) + (b.failed ?? 0);
    return { b, unhealthy, serving: serving.map((r) => r.upstream), backupShare, avail: b.ok === null ? null : total > 0 ? (b.ok / total) * 100 : null };
  })();
  const hovCol = hov ? colOf(hov.b.t) : null;
  const tipRight = hovCol !== null && hovCol.x > LEFT + plotW * 0.6;
  const clip = `ab-clip-${spec}`;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, marginBottom: 6, paddingLeft: LEFT, fontSize: 11, color: "var(--text-4)" }}>
        {stepSec > 0 && <span>a bar per {barSpanWords(stepSec)}</span>}
        <span>target {TARGET}%</span>
        {tl && !tl.available && <span style={{ color: "var(--warn)" }}>incomplete: the metrics store did not answer every read</span>}
      </div>
      <div ref={wrapRef} style={{ position: "relative", width: "100%", height }} onMouseMove={onMove} onMouseLeave={() => setHovI(null)}>
        <svg width={w} height={height} style={{ display: "block" }}>
          <defs>
            <clipPath id={clip}><rect x={LEFT} y={0} width={plotW} height={height} /></clipPath>
          </defs>

          {/* The hovered bar's column, across both parts. */}
          {hovCol && <rect x={hovCol.x - 1} y={top} width={hovCol.w + 2} height={bottom - top} fill="var(--text)" opacity="0.06" rx="2" />}

          {/* 1 · Tries, succeeded and failed */}
          {scale.ticks.filter((v) => v <= yMax).map((v) => (
            <g key={v}>
              <line x1={LEFT} x2={LEFT + plotW} y1={yB(v)} y2={yB(v)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
              <text x={LEFT - 6} y={yB(v) + 3} textAnchor="end" fontSize="9.5" fill="var(--text-3)" fontFamily="var(--font-mono)">{v >= 1000 ? (v / 1000).toFixed(1).replace(/\.0$/, "") + "k" : v}</text>
            </g>
          ))}
          <g clipPath={`url(#${clip})`}>
            {bars.map((b) => {
              if (b.ok === null) return null;
              const { x: bx, w: bw } = colOf(b.t);
              // Every part that isn't zero stays visible: one failed try beside hundreds is a sliver, not nothing.
              const okH = b.ok > 0 ? Math.max((b.ok / yMax) * BARS_H, MIN_PART_PX) : 0;
              const failH = (b.failed ?? 0) > 0 ? Math.max(((b.failed ?? 0) / yMax) * BARS_H, MIN_PART_PX) : 0;
              const base = top + BARS_H;
              return (
                <g key={b.t}>
                  {okH > 0 && <rect x={bx} y={base - okH} width={bw} height={okH} fill="var(--ok)" opacity="0.75" />}
                  {failH > 0 && <rect x={bx} y={base - okH - failH} width={bw} height={failH} fill="var(--err)" opacity="0.85" />}
                </g>
              );
            })}
          </g>
          {tl && !bars.some((b) => b.ok !== null && b.ok + (b.failed ?? 0) > 0) && (
            <text x={LEFT + plotW / 2} y={top + BARS_H / 2} textAnchor="middle" fontSize="12" fill="var(--text-4)">No requests in this window.</text>
          )}
          {!tl && <rect x={LEFT} y={top} width={plotW} height={BARS_H} rx="4" fill="var(--line)" opacity="0.25" />}

          {/* 2 · Providers */}
          <text x={LEFT} y={pTop - 9} fontSize="11" fontWeight="600" fill="var(--text-2)">Providers</text>
          {!tl && Array.from({ length: 3 }, (_, i) => (
            <rect key={i} x={LEFT} y={rowY(i)} width={plotW} height={ROW_H} rx="2" fill="var(--line)" opacity="0.35" />
          ))}
          {tl && !rows.length && (
            <text x={LEFT} y={rowY(0) + 11} fontSize="11" fill="var(--text-4)">No upstreams on this chain.</text>
          )}
          {rows.map((r, i) => {
            const y = rowY(i);
            const label = r.upstream + (r.role === "backup" ? " (backup)" : "");
            const maxChars = Math.floor((LEFT - 10) / 6.1);
            const st = rowStatus(r, stepSec, win);
            return (
              <g key={r.upstream}>
                <text x={0} y={y + 11} fontSize="11" fill={r.inConfig ? "var(--text-2)" : "var(--text-4)"} fontFamily="var(--font-mono)">
                  <title>{r.inConfig ? label : `${label} - not in the config`}</title>
                  {label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label}
                </text>
                <rect x={LEFT} y={y} width={plotW} height={ROW_H} fill="var(--line)" opacity="0.18" />
                <g clipPath={`url(#${clip})`}>
                  {r.cells.map((c) => {
                    const { x: cx, w: cw } = colOf(c.t);
                    return (
                      <g key={c.t}>
                        {c.state && <rect x={cx} y={y} width={cw} height={r.role === "backup" ? ROW_H - 4 : ROW_H} rx="1.5" fill={healthColor(c.state)} opacity="0.85" />}
                        {r.role === "backup" && (c.rps ?? 0) > 0 && <rect x={cx} y={y + ROW_H - 3} width={cw} height={3} fill={BACKUP_COLOR} />}
                      </g>
                    );
                  })}
                </g>
                {RIGHT > 0 && (
                  <text x={LEFT + plotW + 10} y={y + 11} fontSize="10.5" fill={st.color}>
                    <title>{st.text}</title>
                    {st.text.length > 34 ? st.text.slice(0, 33) + "…" : st.text}
                  </text>
                )}
              </g>
            );
          })}

          {/* The one time axis, on round times. */}
          {tl && (timeTicks([x0, x1]) ?? []).map((tk, k) => (
            <text key={k} x={x(tk.at)} y={bottom + AXIS_H - 2} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor="middle">{tk.label}</text>
          ))}
        </svg>
        {hov && hovCol && tl && (
          <div style={{ position: "absolute", top: 6, ...(tipRight ? { right: w - hovCol.x + 8 } : { left: hovCol.x + hovCol.w + 8 }), pointerEvents: "none", background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 8, padding: "8px 10px", whiteSpace: "nowrap", boxShadow: "0 6px 18px rgba(0,0,0,0.35)", fontSize: 11.5, display: "grid", gap: 3, minWidth: 180 }}>
            <div className="gw-mono" style={{ color: "var(--text-3)", fontSize: 10.5, marginBottom: 3 }}>{barWords(hov.b.t, stepSec, tl.asOf)}</div>
            {hov.b.ok === null ? (
              <div style={{ color: "var(--text-4)" }}>No data</div>
            ) : (
              <>
                <TipRow color="var(--ok)" label="Succeeded" value={fmtComma(hov.b.ok)} />
                <TipRow color="var(--err)" label="Failed" value={fmtComma(hov.b.failed ?? 0)} />
                <div style={{ display: "flex", gap: 8, marginTop: 2, color: "var(--text-2)" }}>
                  <span style={{ flex: 1 }}>Availability</span>
                  <b className="gw-mono gw-tnum" style={{ color: hov.avail !== null && hov.avail < TARGET ? "var(--err)" : "var(--text)" }}>{hov.avail === null ? "—" : pct(hov.avail)}</b>
                </div>
              </>
            )}
            {hov.unhealthy.length > 0 && <div style={{ color: "var(--err)", marginTop: 2 }}>Unhealthy: {hov.unhealthy.join(", ")}</div>}
            {hasBackup && hov.serving.length > 0 && (
              <div style={{ color: BACKUP_COLOR }}>Backups served {fmtShare(hov.backupShare)} ({hov.serving.join(", ")})</div>
            )}
          </div>
        )}
      </div>
      {/* Legend: the bars, then the health words and colours of lib/health.ts, nothing new. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, paddingLeft: LEFT, fontSize: 10.5, color: "var(--text-3)" }}>
        <Key color="var(--ok)" label="Succeeded" />
        <Key color="var(--err)" label="Failed" />
        <span style={{ width: 1, background: "var(--line-2)" }} />
        {(["operational", "unhealthy", "unknown"] as const).map((s) => <Key key={s} color={healthColor(s)} label={HEALTH_LABEL[s]} />)}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, border: "1px solid var(--line-2)" }} />No data
        </span>
        {hasBackup && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 11, height: 3, background: BACKUP_COLOR }} />Backup took traffic
          </span>
        )}
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

function TipRow({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: color, opacity: 0.85 }} />
      <span style={{ flex: 1, color: "var(--text-2)" }}>{label}</span>
      <b className="gw-mono gw-tnum" style={{ color: "var(--text)" }}>{value}</b>
    </div>
  );
}
