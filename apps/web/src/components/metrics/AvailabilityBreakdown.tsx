"use client";

/* AvailabilityBreakdown — the ChainDetail Availability view: three parts on
 * ONE time axis, so a drop in availability, the upstreams that went unhealthy
 * and the backups that took traffic read off one vertical line.
 *
 *  1. Availability — the chain's line and its 99.9% target (`chain-series`).
 *  2. Served by backups — the backups' share of the chain's tries
 *     (`chain-series` backupShare), 0-100%.
 *  3. Providers — a row per upstream, a cell per point of the same grid
 *     (`/api/metrics/upstream-timeline`), coloured by `HealthState` through
 *     lib/health.ts; a backup that took traffic gets a bar under the cell.
 *
 * Every part lays points out by TIME on the grid, never by index: a point the
 * store didn't return is a gap in the line and a blank cell, not a squeezed
 * axis, a 0% or a green cell. Spans under the target are shaded red across
 * all three, and one hover reads all three at that time. */

import { useState } from "react";
import type { HealthState, MetricWindow, TimePoint, UpstreamTimeline, UpstreamTimelineRow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useChartDims } from "@/components/gateway/charts";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { HEALTH_LABEL, healthColor } from "@/lib/health";
import { roFmtTime } from "./InteractiveChart";

/** The backups' colour: their share line and the "took traffic" bar under a backup's cell. */
export const BACKUP_COLOR = "#fb923c";

const TARGET = 99.9;
const AVAIL_H = 150;
const BACKUP_H = 70;
const ROW_H = 14;
const ROW_GAP = 6;
const TITLE_H = 30;
const AXIS_H = 18;

interface Pt {
  t: number;
  v: number;
}

const kept = (pts: TimePoint[] | null | undefined, scale = 1): Pt[] =>
  (pts ?? []).filter((p): p is TimePoint & { v: number } => p.v !== null).map((p) => ({ t: p.t, v: p.v * scale }));

/** Runs of points no further apart than 1.5 steps: a longer stretch is a gap. */
function segments(pts: Pt[], stepSec: number): Pt[][] {
  const out: Pt[][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    if (last && prev && p.t - prev.t <= stepSec * 1.5) last.push(p);
    else out.push([p]);
  }
  return out;
}

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
    const served = maxShare >= 0 ? `served up to ${fmtShare(maxShare)}` : null;
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

export function AvailabilityBreakdown({
  spec,
  routerId,
  win,
  color,
  availability,
  backupShare,
  hasBackup,
}: {
  spec: string;
  /** The config router the row is; null when no values file names it. */
  routerId: string | null;
  win: MetricWindow;
  color: string;
  availability: TimePoint[];
  backupShare: TimePoint[] | null;
  /** The mounted config marks at least one backup for this router. */
  hasBackup: boolean;
}) {
  const { scopeQ } = useFilters();
  const rid = routerId ? `&routerId=${encodeURIComponent(routerId)}` : "";
  const { data: tl } = useApi<UpstreamTimeline>(`/api/metrics/upstream-timeline?spec=${encodeURIComponent(spec)}&window=${win}${rid}${scopeQ}`);
  const [hovT, setHovT] = useState<number | null>(null);

  const avail = kept(availability, 100);
  const share = kept(backupShare, 100);
  const stepSec = tl?.grid.stepSec ?? (avail.length > 1 ? avail[1]!.t - avail[0]!.t : 15);
  const x0 = Math.min(tl?.grid.start ?? Infinity, avail[0]?.t ?? Infinity);
  const x1 = Math.max(tl?.grid.end ?? -Infinity, avail[avail.length - 1]?.t ?? -Infinity);
  const hasAxis = Number.isFinite(x0) && Number.isFinite(x1) && x1 > x0;

  const rows = tl?.upstreams ?? [];
  const rowCount = tl ? Math.max(rows.length, 1) : 3;
  const backupPartH = hasBackup ? TITLE_H + BACKUP_H : TITLE_H;
  const providersH = TITLE_H + rowCount * (ROW_H + ROW_GAP);
  const height = 8 + AVAIL_H + backupPartH + providersH + AXIS_H;
  const [wrapRef, w] = useChartDims(600, height);

  const narrow = w < 640;
  const LEFT = narrow ? 104 : 150;
  const RIGHT = narrow ? 0 : 200;
  const plotW = Math.max(60, w - LEFT - RIGHT);
  const x = (t: number) => LEFT + (hasAxis ? ((t - x0) / (x1 - x0)) * plotW : plotW / 2);
  const cellW = hasAxis ? Math.max(1, (stepSec / (x1 - x0)) * plotW) : plotW;

  // Part 1: the same y-domain rule as InteractiveChart, the target always in view, capped at 100%.
  const aTop = 8;
  let minV = Math.min(TARGET, ...avail.map((p) => p.v));
  let maxV = Math.max(TARGET, ...avail.map((p) => p.v));
  const pad = (maxV - minV) * 0.14 || 1;
  minV -= pad;
  maxV = Math.min(maxV + pad, 100);
  const yA = (v: number) => aTop + AVAIL_H - ((v - minV) / (maxV - minV || 1)) * AVAIL_H;
  const aTicks = Array.from({ length: 5 }, (_, i) => minV + ((maxV - minV) * i) / 4);

  // Part 2.
  const bTop = aTop + AVAIL_H + TITLE_H;
  const yB = (v: number) => bTop + BACKUP_H - (Math.max(0, Math.min(100, v)) / 100) * BACKUP_H;

  // Part 3.
  const pTop = aTop + AVAIL_H + backupPartH + TITLE_H;
  const rowY = (i: number) => pTop + i * (ROW_H + ROW_GAP);
  const bottom = pTop + rowCount * (ROW_H + ROW_GAP) - ROW_GAP;

  // Incident shading: runs of availability points under the target.
  const bands: [number, number][] = [];
  for (const p of avail) {
    if (p.v >= TARGET) continue;
    const last = bands[bands.length - 1];
    if (last && p.t - last[1] <= stepSec * 1.5) last[1] = p.t;
    else bands.push([p.t, p.t]);
  }

  const line = (seg: Pt[], y: (v: number) => string | number) => seg.map((p) => `${x(p.t).toFixed(1)},${y(p.v)}`).join(" ");
  const area = (seg: Pt[], y: (v: number) => number, base: number) =>
    `M ${x(seg[0]!.t).toFixed(1)},${base} ` + seg.map((p) => `L ${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ") + ` L ${x(seg[seg.length - 1]!.t).toFixed(1)},${base} Z`;

  const near = (pts: Pt[], t: number) => pts.find((p) => Math.abs(p.t - t) <= stepSec / 2) ?? null;
  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!hasAxis) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < LEFT || px > LEFT + plotW) return setHovT(null);
    const t = x0 + ((px - LEFT) / plotW) * (x1 - x0);
    setHovT(x0 + Math.round((t - x0) / stepSec) * stepSec);
  }

  const hov = hovT === null ? null : (() => {
    const a = near(avail, hovT);
    const cellAt = (r: UpstreamTimelineRow) => r.cells.find((c) => Math.abs(c.t - hovT) <= stepSec / 2);
    const unhealthy = rows.filter((r) => cellAt(r)?.state === "unhealthy").map((r) => r.upstream);
    const serving = rows.filter((r) => r.role === "backup" && (cellAt(r)?.rps ?? 0) > 0).map((r) => r.upstream);
    const b = near(share, hovT);
    return { a, unhealthy, serving, b };
  })();
  const tipRight = hovT !== null && x(hovT) > LEFT + plotW * 0.6;
  const clip = `ab-clip-${spec}`;

  return (
    <div>
      <div ref={wrapRef} style={{ position: "relative", width: "100%", height }} onMouseMove={onMove} onMouseLeave={() => setHovT(null)}>
        <svg width={w} height={height} style={{ display: "block" }}>
          <defs>
            <clipPath id={clip}><rect x={LEFT} y={0} width={plotW} height={height} /></clipPath>
          </defs>

          {/* Incident shading, across all three parts. */}
          <g clipPath={`url(#${clip})`}>
            {bands.map(([a, b], i) => (
              <rect key={i} x={x(a) - cellW / 2} width={x(b) - x(a) + cellW} y={aTop} height={bottom - aTop} fill="var(--err)" opacity="0.09" />
            ))}
          </g>

          {/* 1 · Availability */}
          {aTicks.map((v, i) => (
            <g key={i}>
              <line x1={LEFT} x2={LEFT + plotW} y1={yA(v)} y2={yA(v)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
              <text x={LEFT - 6} y={yA(v) + 3} textAnchor="end" fontSize="9.5" fill="var(--text-3)" fontFamily="var(--font-mono)">{v.toFixed(2)}%</text>
            </g>
          ))}
          <line x1={LEFT} x2={LEFT + plotW} y1={yA(TARGET)} y2={yA(TARGET)} stroke="var(--text-4)" strokeWidth="1" strokeDasharray="4 3" opacity="0.8" />
          <text x={LEFT + plotW} y={yA(TARGET) - 4} textAnchor="end" fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)">99.9%</text>
          {segments(avail, stepSec).map((seg, i) => (
            <g key={i}>
              <path d={area(seg, yA, aTop + AVAIL_H)} fill={color} opacity="0.10" />
              <polyline points={line(seg, (v) => yA(v).toFixed(1))} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {!avail.length && (
            <text x={LEFT + plotW / 2} y={aTop + AVAIL_H / 2} textAnchor="middle" fontSize="12" fill="var(--text-4)">No samples in this window.</text>
          )}

          {/* 2 · Served by backups */}
          <text x={LEFT} y={aTop + AVAIL_H + 22} fontSize="11" fontWeight="600" fill="var(--text-2)">
            Served by backups
            {!hasBackup && <tspan fontWeight="400" fill="var(--text-4)" dx="8">no backup upstream configured</tspan>}
          </text>
          {hasBackup && (
            <>
              <line x1={LEFT} x2={LEFT + plotW} y1={yB(0)} y2={yB(0)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
              <line x1={LEFT} x2={LEFT + plotW} y1={yB(100)} y2={yB(100)} stroke="var(--line)" strokeWidth="1" opacity="0.6" />
              <text x={LEFT - 6} y={yB(100) + 3} textAnchor="end" fontSize="9.5" fill="var(--text-3)" fontFamily="var(--font-mono)">100%</text>
              <text x={LEFT - 6} y={yB(0) + 3} textAnchor="end" fontSize="9.5" fill="var(--text-3)" fontFamily="var(--font-mono)">0%</text>
              {share.length ? (
                segments(share, stepSec).map((seg, i) => (
                  <g key={i}>
                    <path d={area(seg, yB, yB(0))} fill={BACKUP_COLOR} opacity="0.22" />
                    <polyline points={line(seg, (v) => yB(v).toFixed(1))} fill="none" stroke={BACKUP_COLOR} strokeWidth="1.5" strokeLinejoin="round" />
                  </g>
                ))
              ) : (
                <text x={LEFT + plotW / 2} y={bTop + BACKUP_H / 2 + 4} textAnchor="middle" fontSize="11" fill="var(--text-4)">no data</text>
              )}
              {share.length > 0 && RIGHT > 0 && (
                <text x={LEFT + plotW + 10} y={bTop + 12} fontSize="10.5" fill="var(--text-3)">{Math.max(...share.map((p) => p.v)) > 0 ? `up to ${fmtShare(Math.max(...share.map((p) => p.v)) / 100)}` : "none"}</text>
              )}
            </>
          )}

          {/* 3 · Providers */}
          <text x={LEFT} y={pTop - 9} fontSize="11" fontWeight="600" fill="var(--text-2)">
            Providers
            {tl && !tl.available && <tspan fontWeight="400" fill="var(--warn)" dx="8">incomplete: the metrics store did not answer every read</tspan>}
          </text>
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
                  {r.cells.map((c) => (
                    <g key={c.t}>
                      {c.state && (
                        <rect x={x(c.t) - cellW / 2 + (cellW > 3 ? 0.5 : 0)} y={y} width={Math.max(1, cellW - (cellW > 3 ? 1 : 0))} height={r.role === "backup" ? ROW_H - 4 : ROW_H} fill={healthColor(c.state)} opacity="0.85" />
                      )}
                      {r.role === "backup" && (c.rps ?? 0) > 0 && (
                        <rect x={x(c.t) - cellW / 2} y={y + ROW_H - 3} width={cellW} height={3} fill={BACKUP_COLOR} />
                      )}
                    </g>
                  ))}
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

          {/* The one time axis. */}
          {hasAxis && [0, 0.25, 0.5, 0.75, 1].map((f, k) => (
            <text key={k} x={LEFT + f * plotW} y={bottom + AXIS_H - 2} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)" textAnchor={k === 0 ? "start" : k === 4 ? "end" : "middle"}>
              {roFmtTime(new Date((x0 + f * (x1 - x0)) * 1000), win)}
            </text>
          ))}

          {hovT !== null && hov && (
            <>
              <line x1={x(hovT)} x2={x(hovT)} y1={aTop} y2={bottom} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="3 3" />
              {hov.a && <circle cx={x(hovT)} cy={yA(hov.a.v)} r="3.5" fill={color} stroke="var(--surface)" strokeWidth="1.5" />}
            </>
          )}
        </svg>
        {hovT !== null && hov && (
          <div style={{ position: "absolute", top: 6, left: x(hovT), transform: `translateX(${tipRight ? "-104%" : "10px"})`, pointerEvents: "none", background: "var(--surface)", border: "1px solid var(--line-2)", borderRadius: 6, padding: "6px 10px", whiteSpace: "nowrap", boxShadow: "0 6px 18px rgba(0,0,0,0.35)", fontSize: 11.5, display: "grid", gap: 2 }}>
            <div style={{ color: "var(--text-4)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{roFmtTime(new Date(hovT * 1000), win)}</div>
            <div style={{ color: "var(--text)" }}>
              Availability <b className="gw-mono gw-tnum">{hov.a ? hov.a.v.toFixed(2) + "%" : "no data"}</b>
            </div>
            {hov.unhealthy.length > 0 && (
              <div style={{ color: "var(--err)" }}>Unhealthy: {hov.unhealthy.join(", ")}</div>
            )}
            {hasBackup && (
              <div style={{ color: hov.b && hov.b.v > 0 ? BACKUP_COLOR : "var(--text-3)" }}>
                Backups served {hov.b ? fmtShare(hov.b.v / 100) : "no data"}
                {hov.serving.length > 0 && ` (${hov.serving.join(", ")})`}
              </div>
            )}
          </div>
        )}
      </div>
      {/* Legend: the health words and colours of lib/health.ts, nothing new. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, paddingLeft: LEFT, fontSize: 10.5, color: "var(--text-3)" }}>
        {(["operational", "unhealthy", "unknown"] as const).map((s) => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 9, height: 9, borderRadius: 2, background: healthColor(s), opacity: 0.85 }} />{HEALTH_LABEL[s]}
          </span>
        ))}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, border: "1px solid var(--line-2)" }} />No data
        </span>
        {hasBackup && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 11, height: 3, background: BACKUP_COLOR }} />Backup took traffic
          </span>
        )}
        {bands.length > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 11, height: 9, background: "var(--err)", opacity: 0.18 }} />Under 99.9%
          </span>
        )}
      </div>
    </div>
  );
}
