"use client";

/* Upstreams page — ported from the design prototype (page-providers.jsx
 * ProvidersPage). SELF-HOSTED REALITY: the roster is the mounted values
 * file (GET /api/config/routers), grouped one card per config node; live
 * stats join from GET /api/metrics/upstreams (endpointId = node name).
 * All mutating flows render the full design UI with their commit buttons
 * disabled (read-only mount); the Test modal fires a real local POST. */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildChainMetaByIndex,
  type UpstreamMetrics,
  type RouterTopology,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { CapabilityTags, capabilitiesOf } from "@/components/gateway/CapabilityTags";
import { fmtMs, fmtNum, fmtPct } from "@/lib/format";
import { uptimeColorFrac } from "@/lib/colors";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { StatusDot, pvStatLabel } from "@/components/upstreams/bits";
import { buildUpstreamRows } from "@/components/upstreams/catalog";
import { IfaceTag } from "@/components/endpoints/bits";
import { TryNowButton } from "@/components/try-me/try-now-button";

/* ─────────────────────────────────────────────
   Stat strip (design: intentionally empty)
───────────────────────────────────────────── */
function StatStrip() { return null; }

/** Initial-badge fallback for unmatched (BYO) nodes — chain-colored. */
function InitialBadge({ name, spec, size = 28 }: { name: string; spec?: string; size?: number }) {
  const color = spec ? buildChainMetaByIndex(spec).color : "var(--surface-2)";
  return (
    <span style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: Math.round(size * 0.43), flexShrink: 0 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function UpstreamsView() {
  const router = useRouter();
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  /* Upstream roster stats — fixed 1d window ("Req today"). */
  const live = useApi<{ upstreams: UpstreamMetrics[] }>("/api/metrics/upstreams?window=1d");

  const [degradedFilter, setDegradedFilter] = useState(false);
  const [search, setSearch] = useState("");
  const [netFilter, setNetFilter] = useState<"all" | "mainnet" | "testnet">("all");
  const [newChainCtas, setNewChainCtas] = useState<{ chainId: string; upstreamName: string }[]>([]);

  const routers = useMemo(() => config.data?.routers ?? [], [config.data]);
  const upstreams = useMemo(
    () => buildUpstreamRows(routers, live.data?.upstreams),
    [routers, live.data],
  );

  const displayed = useMemo(() => {
    return upstreams.filter((pv) => {
      const matchDegraded = !degradedFilter || pv.status === "degraded";
      const matchSearch = !search.trim() ||
        pv.name.toLowerCase().includes(search.toLowerCase()) ||
        pv.url.toLowerCase().includes(search.toLowerCase());
      const matchNet = netFilter === "all" || pv.networks.includes(netFilter);
      return matchDegraded && matchSearch && matchNet;
    });
  }, [upstreams, degradedFilter, search, netFilter]);

  const loading = !config.data && !config.error;

  const statColor = (s: string) => s === "healthy" ? "ok" : s === "degraded" ? "warn" : "err";

  return (
    <div className="gw-page fade-in">
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1>Upstreams</h1>
          <p className="lede">The upstream RPC nodes this router routes through · config <span className="gw-mono" style={{ color: "var(--text-2)" }}>read-only mount</span>.</p>
        </div>
      </div>

      <StatStrip />

      {/* First-upstream CTAs — one per newly-covered chain (design flow;
          unreachable on self-hosted since adds never commit) */}
      {newChainCtas.map(({ chainId, upstreamName }) => {
        const chain = buildChainMetaByIndex(chainId);
        return (
          <div key={chainId} style={{
            display: "flex", alignItems: "center", gap: 12, marginBottom: 12,
            padding: "11px 16px", borderRadius: 10,
            background: "rgba(34,197,94,0.06)", border: "1px solid rgba(34,197,94,0.2)",
          }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="20 6 9 17 4 12"/></svg>
            <ChainBadge spec={chainId} size={20} />
            <span style={{ fontSize: 13, flex: 1 }}>
              <strong>{upstreamName}</strong> is your first upstream for <strong>{chain.name}</strong>.
            </span>
            <button className="gw-btn gw-btn--primary" style={{ fontSize: 12, padding: "5px 12px", flexShrink: 0 }}
              onClick={() => { router.push("/endpoints"); setNewChainCtas((fc) => fc.filter((c) => c.chainId !== chainId)); }}>
              Create endpoint →
            </button>
            <button className="gw-btn gw-btn--ghost" style={{ padding: "4px 6px", flexShrink: 0 }}
              onClick={() => setNewChainCtas((fc) => fc.filter((c) => c.chainId !== chainId))}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        );
      })}

      {/* search + network filter */}
      <div className="gw-row" style={{ gap: 10, marginBottom: 16 }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input className="gw-input" type="search" placeholder="Search upstreams…" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 32 }} />
        </div>
        <div className="gw-segctl">
          {([["all", "All"], ["mainnet", "Mainnet"], ["testnet", "Testnet"]] as const).map(([val, lbl]) => (
            <button key={val} className={netFilter === val ? "on" : ""} onClick={() => setNetFilter(val)}>{lbl}</button>
          ))}
        </div>
      </div>

      {degradedFilter && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 14px", borderRadius: 8, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.18)", fontSize: 12, color: "var(--warn)" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Showing degraded upstreams only —{" "}
          <button onClick={() => setDegradedFilter(false)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>clear filter</button>
        </div>
      )}

      {loading ? null : upstreams.length === 0 ? (
        <div className="gw-empty">
          <div className="gw-empty__icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
          </div>
          <h2>No upstreams yet</h2>
          <p>The mounted values file has no upstream nodes. Add your first upstream — Alchemy, Infura, QuickNode, or your own node — by editing the values file.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {displayed.map((pv) => {
            return (
              <div key={pv.id} className="gw-card" style={{ padding: "14px 16px", transition: "background 0.4s" }}>
                {/* header */}
                <div className="gw-row" style={{ gap: 14, justifyContent: "space-between", flexWrap: "wrap", marginBottom: 12 }}>
                  <div className="gw-row" style={{ gap: 10 }}>
                    {pv.catalogId
                      ? <UpstreamLogo id={pv.catalogId} size={28} />
                      : <InitialBadge name={pv.name} spec={pv.chains[0]} size={28} />}
                    <div className="gw-row" style={{ gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{pv.name}</span>
                      {/* Chain identity lives HERE (icon + name), so the
                          per-endpoint rows below don't repeat it. */}
                      {pv.chains[0] && (
                        <span className="gw-row" style={{ gap: 5, alignItems: "center" }}>
                          <span style={{ color: "var(--text-4)" }}>·</span>
                          <ChainBadge spec={pv.chains[0]} size={15} />
                          <span style={{ fontSize: 12, color: "var(--text-2)" }}>{buildChainMetaByIndex(pv.chains[0]).name}</span>
                          {pv.chains.length > 1 && (
                            <span style={{ fontSize: 10, color: "var(--text-3)" }}>+{pv.chains.length - 1}</span>
                          )}
                        </span>
                      )}
                      {pv.status !== "—" && (
                        <span className={"gw-tag gw-tag--" + statColor(pv.status)} style={{ fontSize: 10, padding: "1px 6px", display: "inline-flex", gap: 5, alignItems: "center" }}><StatusDot status={pv.status} />{pv.status}</span>
                      )}
                    </div>
                  </div>
                  <div className="gw-row" style={{ gap: 18 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={pvStatLabel}>Latency</div>
                      <div className="gw-mono gw-tnum" style={{ fontSize: 12, marginTop: 2 }}>{fmtMs(pv.latencyMs)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={pvStatLabel}>Uptime</div>
                      <div className="gw-mono gw-tnum" style={{ fontSize: 12, marginTop: 2, color: uptimeColorFrac(pv.uptime) }}>{fmtPct(pv.uptime)}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={pvStatLabel}>Req today</div>
                      <div className="gw-mono gw-tnum" style={{ fontSize: 12, marginTop: 2 }}>{fmtNum(pv.requests)}</div>
                    </div>
                  </div>
                </div>
                {/* endpoint rows, one per (chain, upstream endpoint) served */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {pv.chainRows.map((row, i) => {
                    // Resolve the local listen port for this (router, interface).
                    // The router serves WebSocket on the SAME port as the base
                    // interface (there's no separate ws port), so a ws row dials
                    // ws://localhost:<port> with the -ws catalog interface — which
                    // makes the Try-me drawer use its WebSocket transport.
                    const rtr = routers.find((r) => r.id === row.routerId);
                    const isWsRow = row.urlHost.startsWith("ws://") || row.urlHost.startsWith("wss://") || row.iface.endsWith("-ws");
                    const localPort = rtr?.localPorts[row.iface] ?? null;
                    const tryIface = isWsRow
                      ? (row.iface.startsWith("tendermintrpc") ? "tendermintrpc-ws" : "jsonrpc-ws")
                      : row.iface;
                    const tryUrl = localPort !== null
                      ? `${isWsRow ? "ws" : "http"}://localhost:${localPort}`
                      : null;
                    return (
                      <div key={i} className="gw-row" style={{ gap: 8, padding: "6px 10px", background: "var(--hover)", borderRadius: 6, border: "1px solid var(--line)" }}>
                        {/* Role inline — the chain identity is on the card header,
                            not repeated per row. Only reserve the slot when the
                            config actually marks a role (helm is_backup). */}
                        {(row.role === "primary" || row.role === "backup") && (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, minWidth: 78 }}>
                          {row.role === "primary" && (
                            <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--ok)", fontWeight: 500 }}>
                              <svg width="5" height="5" viewBox="0 0 6 6"><circle cx="3" cy="3" r="3" fill="currentColor"/></svg>
                              primary
                            </span>
                          )}
                          {row.role === "backup" && (
                            <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "#60a5fa", fontWeight: 500 }}>
                              <svg width="5" height="5" viewBox="0 0 6 6"><circle cx="3" cy="3" r="3" fill="currentColor"/></svg>
                              backup
                            </span>
                          )}
                        </div>
                        )}
                        <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{row.urlHost || "—"}</span>
                        {/* interface tag + configured capabilities (addons +
                            derived ws) — real config values, nothing invented.
                            Same IfaceTag component the Endpoints page uses so
                            the badge label + colour are consistent. */}
                        {row.iface && <IfaceTag id={row.iface} />}
                        <CapabilityTags
                          size="xs"
                          capabilities={capabilitiesOf({
                            addons: row.addons,
                            hasWs: row.urlHost.startsWith("ws://") || row.urlHost.startsWith("wss://") || row.iface.endsWith("-ws"),
                          })}
                        />
                        {/* Try now — opens the Try-me drawer preselecting THIS
                            interface. Only when the router exposes a local port
                            for it (nothing to dial otherwise). */}
                        {tryUrl !== null && (
                          <TryNowButton
                            spec={row.spec}
                            network={row.network}
                            iface={tryIface}
                            url={tryUrl}
                            hasArchive={pv.chainRows.some((r) => r.spec === row.spec && r.addons.includes("archive"))}
                            selectUpstream={pv.name}
                            visible
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
