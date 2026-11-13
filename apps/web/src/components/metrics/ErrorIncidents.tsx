"use client";

/* The Errors tab's timeline (MAG-5263): errors batched by when they arrived,
 * from /api/metrics/error-incidents. One lane per line - a burst, a
 * chain-wide burst, a recurring one, a long-running one - with its waves on
 * one time axis, then the errors that never stop ("always present"). A line
 * stands for every error inside it: opening one narrows the request list
 * below to its times and provider. */

import { useState } from "react";
import { WINDOWS, buildChainMetaByIndex, type ErrorIncidentKind, type ErrorIncidentLine, type ErrorIncidentShape, type ErrorIncidentsReport, type MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useRouterFilter } from "@/hooks/use-router-options";
import { SkelLine } from "@/components/gateway/Skel";
import { Tip } from "@/components/gateway/Tip";
import { fmtComma } from "@/lib/format";
import { fmtDay, fmtTime } from "@/lib/datetime";
import { TT } from "@/lib/tooltips";
import { providerName, rangeWords } from "./request-log";

/** How many lanes show before "Show all". */
const FIRST_LANES = 10;
const GUTTER = 300;
const RIGHT = 132;

export const SHAPE: Record<ErrorIncidentShape, { label: string; hint: string }> = {
  incident: { label: "Burst", hint: "Errors well above this provider's usual level for a while, then back to normal." },
  "chain-wide": { label: "Chain-wide", hint: "Several providers of one chain at the same time: look at the chain, not one provider." },
  recurring: { label: "Recurring", hint: "The same provider and chain, 3 times or more, each within 3 hours of the last." },
  "long-running": { label: "Long-running", hint: "Above the usual level for 6 hours or more without a break." },
};

export const KIND: Record<ErrorIncidentKind, { label: string; noun: string; color: string }> = {
  failed: { label: "Failed attempts", noun: "failed attempts", color: "var(--err)" },
  reply: { label: "Error replies", noun: "error replies", color: "var(--warn)" },
};

const chainName = (spec: string) => buildChainMetaByIndex(spec).name;

/** "blockdaemon on NEAR", "NEAR: 3 providers", "NEAR +6 chains: 2 providers". */
export function lineTitle(l: ErrorIncidentLine): string {
  const main = l.chains[0]?.spec;
  if (l.shape === "chain-wide" && main) {
    const others = l.chains.length - 1;
    return `${chainName(main)}${others ? ` +${others} ${others === 1 ? "chain" : "chains"}` : ""}: ${l.providers.length} providers`;
  }
  const on = l.chains.slice(0, 2).map((c) => chainName(c.spec)).join(", ");
  const more = l.chains.length > 2 ? ` +${l.chains.length - 2}` : "";
  return `${l.providers.map(providerName).join(", ")} on ${on}${more}`;
}

/** "5 min", "2 h 10 min", "3 days". */
export function durWords(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** An axis tick (unix s): the clock within two days, the day beyond. */
const tickWords = (t: number, span: number) => (span <= 2 * 86400 ? fmtTime(t * 1000) : fmtDay(t * 1000));

export function ErrorIncidents({ chainFilter, win, openKey, onOpen }: {
  chainFilter: string | null;
  win: MetricWindow;
  /** The line the list below is narrowed to, if any. */
  openKey: string | null;
  onOpen: (line: ErrorIncidentLine, stepSec: number) => void;
}) {
  const specQ = chainFilter ? `&spec=${encodeURIComponent(chainFilter)}` : "";
  const { scopeQ } = useFilters();
  const { routerIdQ } = useRouterFilter();
  const { data, isLoading, error } = useApi<ErrorIncidentsReport>(`/api/metrics/error-incidents?window=${win}${specQ}${routerIdQ}${scopeQ}`);
  const [kind, setKind] = useState<ErrorIncidentKind | "all">("all");
  const [all, setAll] = useState(false);
  const [steadyOpen, setSteadyOpen] = useState(false);

  const lines = (data?.lines ?? []).filter((l) => kind === "all" || l.kind === kind);
  const shown = all ? lines : lines.slice(0, FIRST_LANES);
  const steady = (data?.steady ?? []).filter((s) => kind === "all" || s.kind === kind);
  const ongoing = lines.filter((l) => l.ongoing).length;
  const winWords = WINDOWS[win].label;

  const from = data?.from ?? 0, to = data?.to ?? 1, step = data?.stepSec ?? 60;
  const span = Math.max(1, to - from);
  // A point at t counts the step before it, so a wave runs from start - step.
  const x = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100));
  const ticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4);

  const count = (k: ErrorIncidentKind) => (data?.lines ?? []).filter((l) => l.kind === k).length;

  return (
    <div className="gw-card" style={{ padding: 0, marginBottom: 16, overflow: "clip" }}>
      <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>
          Error timeline<Tip text={TT.errorTimeline!} />
        </span>
        <span style={{ fontSize: 12, color: "var(--text-4)" }}>
          {isLoading ? <SkelLine w={220} />
            : data ? <>{fmtComma(lines.length)} {lines.length === 1 ? "burst" : "bursts"} in the last {winWords}{ongoing ? <>, <span style={{ color: "var(--err)" }}>{ongoing} still going</span></> : null}</>
            : null}
        </span>
        <span style={{ flex: 1 }} />
        <div className="gw-segctl">
          {(["all", "failed", "reply"] as const).map((k) => (
            <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setAll(false); }} style={{ padding: "5px 11px", whiteSpace: "nowrap" }}
              title={k === "failed" ? "No usable answer from the provider: a timeout, a connection error, a rate limit." : k === "reply" ? "The provider answered with an error: invalid params, pruned data." : undefined}>
              {k !== "all" && <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 2, background: KIND[k].color, marginRight: 6, verticalAlign: "middle" }} />}
              {k === "all" ? "All" : KIND[k].label}
              {data && k !== "all" && <span className="gw-tnum" style={{ marginLeft: 6, color: "var(--text-4)" }}>{count(k)}</span>}
            </button>
          ))}
        </div>
      </div>

      {data && !data.available && (
        <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--warn)", borderTop: "1px solid var(--line)" }}>
          Prometheus didn&apos;t answer for {data.failed.map((k) => KIND[k].noun).join(" and ")}. The timeline below may be missing bursts.
        </div>
      )}
      {error && !data && (
        <div style={{ padding: "24px 16px", fontSize: 12, color: "var(--text-3)", borderTop: "1px solid var(--line)", textAlign: "center" }}>
          The timeline couldn&apos;t be loaded. It tries again on its next refresh.
        </div>
      )}

      {data && lines.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line)" }}>
          {/* The time axis, over the lanes; each lane says its own times to a screen reader. */}
          <div aria-hidden style={{ display: "grid", gridTemplateColumns: `${GUTTER}px 1fr ${RIGHT}px`, fontSize: 10.5, color: "var(--text-4)", padding: "6px 16px 2px" }}>
            <span />
            <div style={{ position: "relative", height: 14 }}>
              {ticks.map((t, i) => (
                <span key={i} className="gw-tnum" style={{ position: "absolute", left: `${(i / 4) * 100}%`, transform: i === 0 ? "none" : i === 4 ? "translateX(-100%)" : "translateX(-50%)", whiteSpace: "nowrap" }}>
                  {i === 4 ? "now" : tickWords(t, span)}
                </span>
              ))}
            </div>
            <span />
          </div>
          <div role="list" aria-label="Error bursts">
            {shown.map((l) => {
              const maxWave = Math.max(1, ...l.waves.map((w) => w.count));
              const isOpen = openKey === l.key;
              const open = () => onOpen(l, step);
              return (
                <div key={l.key} role="listitem">
                  <div role="button" tabIndex={0} data-line={l.key} aria-current={isOpen || undefined}
                    aria-label={`${SHAPE[l.shape].label}: ${lineTitle(l)}. ${fmtComma(l.count)} ${KIND[l.kind].noun}, ${rangeWords({ from: (l.start - step) * 1000, to: l.end * 1000 })}${l.ongoing ? ", still going" : ""}. Open its requests.`}
                    className={`gw-lane${isOpen ? " is-open" : ""}`} onClick={open}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
                    style={{ display: "grid", gridTemplateColumns: `${GUTTER}px 1fr ${RIGHT}px`, alignItems: "center", padding: "7px 16px", borderTop: "1px solid var(--line)" }}>
                    <div style={{ minWidth: 0, paddingRight: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span title={SHAPE[l.shape].hint} style={{ flexShrink: 0, fontSize: 10.5, padding: "1px 6px", borderRadius: 4, border: `1px solid ${KIND[l.kind].color}`, color: KIND[l.kind].color, whiteSpace: "nowrap" }}>
                          {SHAPE[l.shape].label}
                        </span>
                        <span title={lineTitle(l)} style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{lineTitle(l)}</span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-4)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {KIND[l.kind].label}
                        {l.shape === "chain-wide" ? <> · {l.providers.map(providerName).join(", ")}</> : null}
                        {l.waves.length > 1 ? <> · {l.waves.length} waves</> : null}
                        {" · "}{durWords(l.end - l.start + step)}
                      </div>
                    </div>
                    {/* Its waves on the window's clock; one that started before the window runs off the left edge. */}
                    <div style={{ position: "relative", height: 18, background: "var(--line)", borderRadius: 3 }}>
                      {l.waves.map((w, i) => {
                        const left = x(w.start - step), right = x(w.end);
                        return (
                          <span key={i} title={`${fmtComma(w.count)} ${KIND[l.kind].noun}, ${durWords(w.end - w.start + step)}`}
                            style={{ position: "absolute", top: 3, bottom: 3, left: `${left}%`, width: `max(3px, ${right - left}%)`, borderRadius: 2,
                              background: KIND[l.kind].color, opacity: 0.35 + 0.65 * (w.count / maxWave) }} />
                        );
                      })}
                    </div>
                    <div style={{ textAlign: "right", paddingLeft: 12 }}>
                      <div className="gw-tnum" style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600 }}>{fmtComma(l.count)}</div>
                      <div style={{ fontSize: 11, color: l.ongoing ? "var(--err)" : "var(--text-4)", whiteSpace: "nowrap" }}>
                        {l.ongoing ? "● still going" : `ended ${durWords(to - l.end)} ago`}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {lines.length > FIRST_LANES && (
            <button className="gw-btn" onClick={() => setAll(!all)} style={{ margin: "8px 16px 10px", padding: "3px 10px", fontSize: 11.5 }}>
              {all ? "Show fewer" : `Show all ${fmtComma(lines.length)}`}
            </button>
          )}
        </div>
      )}
      {data && lines.length === 0 && (
        <div style={{ padding: "16px", fontSize: 12, color: "var(--text-3)", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
          No bursts of errors in the last {winWords}.{steady.length ? " The errors below come in all the time, at their usual level." : ""}
        </div>
      )}

      {data && steady.length > 0 && (
        <div style={{ borderTop: "1px solid var(--line)" }}>
          <button className="gw-disclosure" onClick={() => setSteadyOpen(!steadyOpen)} aria-expanded={steadyOpen}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", fontSize: 12, color: "var(--text-2)", width: "calc(100% - 32px)" }}>
            <span style={{ display: "inline-block", transform: steadyOpen ? "rotate(90deg)" : "none", transition: "transform 80ms" }}>›</span>
            Always present <span className="gw-tnum" style={{ color: "var(--text-4)" }}>{steady.length}</span>
            <span style={{ color: "var(--text-4)" }}>· errors at their usual level most of the time, not bursts</span>
          </button>
          {steadyOpen && (
            <table className="gw-table" style={{ width: "100%" }}>
              <thead><tr><th>Provider</th><th>Chain</th><th>Kind</th><th style={{ textAlign: "right" }}>Usually, per minute</th><th style={{ textAlign: "right" }}>Share of the time</th></tr></thead>
              <tbody>
                {steady.map((s) => (
                  <tr key={`${s.kind}|${s.spec}|${s.provider}`}>
                    <td className="gw-mono">{providerName(s.provider)}</td>
                    <td>{chainName(s.spec)}</td>
                    <td style={{ color: KIND[s.kind].color }}>{KIND[s.kind].label}</td>
                    <td className="gw-tnum" style={{ textAlign: "right" }}>{s.perMinute < 1 ? "under 1" : fmtComma(Math.round(s.perMinute))}</td>
                    <td className="gw-tnum" style={{ textAlign: "right" }}>{Math.round(s.presence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
