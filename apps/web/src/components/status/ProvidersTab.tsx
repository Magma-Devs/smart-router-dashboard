"use client";

/* ProvidersTab - one row per provider: healthy or not, and why.
 *
 * The verdict comes from the SAME findings the Issues tab shows - one rule
 * set, two views. A provider is Unhealthy when a Critical or Degraded finding
 * names it; Config findings are the deployment's fault, not the provider's,
 * so they never mark one unhealthy. Expanding a row gives the reason in the
 * finding's own words, the error codes behind it, and a Grafana link for the
 * raw error text - Prometheus holds counts, not messages. */

import { useState } from "react";
import type { HealthState, MetricWindow, StatusFinding, UpstreamMetrics } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { HealthTag } from "@/components/gateway/HealthTag";
import { fullLogsHref, useGrafanaUrl } from "@/components/gateway/RouterHeader";
import { fmtComma } from "@/lib/format";

interface ProviderRow {
  name: string;
  chains: number;
  requests: number;
  /** From the values file: one role across every chain, or "mixed" when the
   *  config marks it primary somewhere and backup elsewhere. Null when no
   *  config is mounted or the format cannot mark backups (raw SR_CONFIG). */
  role: "primary" | "backup" | "mixed" | null;
  /** chain spec → role, for the expansion when the role is mixed. */
  roleByChain: Record<string, "primary" | "backup">;
  health: HealthState;
  /** Critical/Degraded findings naming this provider - the "why". */
  findings: StatusFinding[];
  /** Every chain this provider serves - the per-endpoint health list. */
  perChain: {
    spec: string;
    requests: number;
    /** Our verdict, from the findings - one rule set with the Issues tab. */
    verdict: HealthState;
    /** The router's own live gauge - its current bench/unbench opinion. */
    routerSaysUnhealthy: boolean;
  }[];
}

function buildRows(upstreams: UpstreamMetrics[], findings: StatusFinding[]): ProviderRow[] {
  const byName = new Map<string, UpstreamMetrics[]>();
  for (const u of upstreams) {
    const list = byName.get(u.endpointId) ?? [];
    list.push(u);
    byName.set(u.endpointId, list);
  }
  const rows = [...byName.entries()].map(([name, list]) => {
    const mine = findings.filter((f) => f.upstream === name && f.tier !== "config");
    const troubled = new Set(mine.map((f) => f.spec));
    const requests = list.reduce((s, u) => s + u.requests, 0);
    const health: HealthState = mine.length ? "unhealthy" : requests > 0 ? "operational" : "unknown";
    const perChain = [...new Map(list.map((u) => [u.spec, u])).values()]
      .map((u) => ({
        spec: u.spec,
        requests: u.requests,
        verdict: (troubled.has(u.spec) ? "unhealthy" : u.requests > 0 ? "operational" : "unknown") as HealthState,
        routerSaysUnhealthy: u.health === "unhealthy",
      }))
      .sort((a, b) => (a.verdict === b.verdict ? b.requests - a.requests : a.verdict === "unhealthy" ? -1 : b.verdict === "unhealthy" ? 1 : 0));
    const roleByChain: Record<string, "primary" | "backup"> = {};
    for (const u of list) if (u.role) roleByChain[u.spec] = u.role;
    const roles = new Set(Object.values(roleByChain));
    const role = roles.size === 0 ? null : roles.size === 1 ? [...roles][0]! : ("mixed" as const);
    return {
      name,
      chains: new Set(list.map((u) => u.spec)).size,
      requests,
      role,
      roleByChain,
      health,
      findings: mine,
      perChain,
    };
  });
  const rank: Record<HealthState, number> = { unhealthy: 0, operational: 1, unknown: 2 };
  return rows.sort((a, b) => rank[a.health] - rank[b.health] || b.requests - a.requests);
}

function Row({ p, timeWindow }: { p: ProviderRow; timeWindow: MetricWindow }) {
  const [open, setOpen] = useState(false);
  const grafana = useGrafanaUrl();
  const codes = [...new Set(p.findings.flatMap((f) => f.codes))].slice(0, 5);
  return (
    <div
      role="button" tabIndex={0} aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen((o) => !o); } }}
      style={{ borderTop: "1px solid var(--line)", cursor: "pointer" }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto 16px", gap: 14, padding: "12px 18px", alignItems: "center" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span className="gw-mono" style={{ fontSize: 12.5, fontWeight: 650 }}>{p.name}</span>
          {p.role && (
            <span
              title={p.role === "mixed"
                ? `Primary on ${Object.values(p.roleByChain).filter((r) => r === "primary").length} chains, backup on ${Object.values(p.roleByChain).filter((r) => r === "backup").length}`
                : `Marked ${p.role} in the config on every chain it serves`}
              style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700,
                border: "1px solid var(--line-2)", color: "var(--text-4)", borderRadius: 3, padding: "1px 5px", whiteSpace: "nowrap" }}
            >
              {p.role === "mixed"
                ? `primary ×${Object.values(p.roleByChain).filter((r) => r === "primary").length} · backup ×${Object.values(p.roleByChain).filter((r) => r === "backup").length}`
                : p.role}
            </span>
          )}
        </span>
        <span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-3)" }}>{p.chains} chain{p.chains === 1 ? "" : "s"}</span>
        <span className="gw-mono gw-tnum" style={{ fontSize: 11, color: "var(--text-3)" }}>{fmtComma(p.requests)} relays</span>
        <HealthTag health={p.health} />
        <span aria-hidden="true" className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ padding: "2px 18px 16px", borderTop: "1px dashed var(--line)", fontSize: 12.5, lineHeight: 1.55 }}>
          {p.findings.length > 0 ? (
            <>
              {p.findings.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "baseline", gap: 7, marginTop: 10 }}>
                  <ChainBadge spec={f.spec} size={14} />
                  <span>
                    <b>{f.chainName}</b> - {f.headline}
                  </span>
                </div>
              ))}
              {codes.length > 0 && (
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--text-3)", fontSize: 11 }}>error codes behind it:</span>
                  {codes.map((c) => (
                    <span key={c} className="gw-mono" style={{ fontSize: 11, background: "var(--bg-2)",
                      border: "1px solid var(--line)", borderRadius: 4, padding: "1px 6px", color: "var(--text-2)" }}>{c}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ marginTop: 10, color: "var(--text-3)" }}>
              {p.requests > 0 ? "No rule crossed on any of its chains in this window." : "No traffic in this window."}
            </div>
          )}
          {p.perChain.length > 0 && (
            <>
              <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 700,
                color: "var(--text-4)", margin: "14px 0 6px" }}>Health per chain</div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(140px, auto) auto auto 1fr", gap: "4px 14px",
                fontSize: 11, alignItems: "center" }}>
                {p.perChain.map((c) => (
                  <div key={c.spec} style={{ display: "contents" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <ChainBadge spec={c.spec} size={13} />
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.spec}</span>
                    </span>
                    <span className="gw-mono gw-tnum" style={{ color: "var(--text-3)", textAlign: "right" }}>{fmtComma(c.requests)}</span>
                    <HealthTag health={c.verdict} fontSize={9} />
                    {/* The router's gauge is its LIVE opinion - it flips on one
                        failure and resets hourly, so it is a marker, never the
                        verdict. Disagreement between the two is information. */}
                    <span style={{ fontSize: 11, color: "var(--text-4)" }}>
                      {c.routerSaysUnhealthy ? "benched by the router right now" : ""}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{ marginTop: 12 }}>
            <a
              href={fullLogsHref(grafana, timeWindow, "")}
              target="_blank" rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{ fontSize: 11, color: "var(--text-2)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}
            >
              Open the logs in Grafana ↗
            </a>
            <span style={{ fontSize: 11, color: "var(--text-4)", marginLeft: 8 }}>
              the metrics hold counts - the error text itself is in the logs
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProvidersTab({ findings, timeWindow }: { findings: StatusFinding[]; timeWindow: MetricWindow }) {
  const { data } = useApi<{ upstreams: UpstreamMetrics[] }>(`/api/metrics/upstreams?window=${timeWindow}`);
  if (!data) {
    return <div className="gw-card" style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--text-4)" }}>Checking…</div>;
  }
  const rows = buildRows(data.upstreams, findings);
  if (rows.length === 0) {
    return <div className="gw-card" style={{ padding: "14px 18px", fontSize: 12.5, color: "var(--text-3)" }}>No providers reported any traffic in this window.</div>;
  }
  return (
    <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 18px", background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
        <h2 style={{ fontSize: 12.5, fontWeight: 700, margin: 0 }}>Providers</h2>

      </div>
      {rows.map((p) => <Row key={p.name} p={p} timeWindow={timeWindow} />)}
    </div>
  );
}
