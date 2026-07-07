"use client";

/* Endpoints page — ported from the design prototype (page-endpoints.jsx
 * EndpointsPage): chain-grouped endpoint cards + search + all/mainnet/testnet
 * segctl. SELF-HOSTED REALITY: an "endpoint" is one (router × interface)
 * surface from the mounted values file; its URL is the local listen port
 * (http://localhost:<port>). JWT suffix / last-used are Magma-Cloud data —
 * they render "—" (never fabricated).
 *
 * Each row with a local port carries a hover-revealed "Try now" button that
 * opens the TryMe request console inline (the former standalone Live-test
 * tab, folded in here so testing lives next to the endpoint it targets). */

import { useMemo, useState } from "react";
import {
  buildChainMetaByIndex,
  type ChainMetrics,
  type HealthState,
  type ProviderMetrics,
  type RouterTopology,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { CopyButton } from "@/components/gateway/CopyButton";
import { buildProviderRows } from "@/components/providers/catalog";
import {
  IfaceTag,
  buildEndpointRows,
  epHasArchive,
  epLocalHttp,
  providerCount,
  type EndpointRowModel,
} from "@/components/endpoints/bits";
import { EndpointDetailSheet } from "@/components/endpoints/EndpointDetailSheet";
import { CreateEndpointSheet } from "@/components/endpoints/CreateEndpointSheet";
import { TryNowButton } from "@/components/try-me/try-now-button";

interface CardGroup {
  routerId: string;
  spec: string;
  network: string;
  rows: EndpointRowModel[];
}

export function EndpointsView() {
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  const live = useApi<{ providers: ProviderMetrics[] }>("/api/metrics/providers?window=1d");
  // Health per spec — threaded into the Try-now drawer's status tag (omitted
  // when a chain has no live metrics; never a hardcoded status).
  const chainMetrics = useApi<{ chains: ChainMetrics[] }>("/api/metrics/chains?window=1d", 60000);

  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [netFilter, setNetFilter] = useState<"all" | "mainnet" | "testnet">("all");

  const routers = useMemo(() => config.data?.routers ?? [], [config.data]);
  const endpoints = useMemo(() => buildEndpointRows(routers), [routers]);
  const healthBySpec = useMemo(() => {
    const map = new Map<string, HealthState>();
    for (const c of chainMetrics.data?.chains ?? []) map.set(c.spec, c.health);
    return map;
  }, [chainMetrics.data]);
  const providers = useMemo(
    () => buildProviderRows(routers, live.data?.providers),
    [routers, live.data],
  );

  /* ── group by router (the real per-chain grouping of the topology) ── */
  const chainGroups = useMemo<CardGroup[]>(() => {
    const filtered = endpoints.filter((ep) => {
      const c = buildChainMetaByIndex(ep.spec);
      const host = ep.port ? `localhost:${ep.port}` : "";
      const q = search.trim().toLowerCase();
      const matchSearch = !q ||
        c.name.toLowerCase().includes(q) ||
        ep.spec.toLowerCase().includes(q) ||
        host.toLowerCase().includes(q) ||
        ep.iface.toLowerCase().includes(q);
      const matchNet = netFilter === "all" || (ep.network || "mainnet") === netFilter;
      return matchSearch && matchNet;
    });
    const map = new Map<string, CardGroup>();
    filtered.forEach((ep) => {
      let g = map.get(ep.routerId);
      if (!g) {
        g = { routerId: ep.routerId, spec: ep.spec, network: ep.network, rows: [] };
        map.set(ep.routerId, g);
      }
      g.rows.push(ep);
    });
    return [...map.values()];
  }, [endpoints, search, netFilter]);

  const liveDetail = detailId ? endpoints.find((e) => e.id === detailId) ?? null : null;
  const detailRouter = liveDetail ? routers.find((r) => r.id === liveDetail.routerId) ?? null : null;

  const loading = !config.data && !config.error;
  const openCreate = () => setShowCreate(true);

  return (
    <div className="gw-page fade-in">

      {/* Header */}
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
        <h1>Endpoints</h1>
        <button className="gw-btn gw-btn--primary" onClick={openCreate}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New endpoint
        </button>
      </div>

      {/* Search + filter */}
      <div className="gw-row" style={{ gap: 10, marginBottom: 16 }}>
        <div style={{ position: "relative", flex: 1, maxWidth: 380 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input className="gw-input" type="search" placeholder="Search chains, interfaces…"
            value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 32 }} />
        </div>
        <div className="gw-segctl">
          {([["all", "All"], ["mainnet", "Mainnet"], ["testnet", "Testnet"]] as const).map(([val, lbl]) => (
            <button key={val} className={netFilter === val ? "on" : ""} onClick={() => setNetFilter(val)}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* Empty */}
      {loading ? null : endpoints.length === 0 ? (
        <div className="gw-empty">
          <div className="gw-empty__icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </div>
          <h2>No endpoints yet</h2>
          <p>No router config mounted — set HELM_VALUES_DIR / mount core/values.yml and its chains and interfaces will appear here.</p>
          <button className="gw-btn gw-btn--primary" onClick={openCreate}>New endpoint</button>
        </div>
      ) : chainGroups.length === 0 ? (
        <div style={{ textAlign: "center", padding: "48px 0", color: "var(--text-3)", fontSize: 13 }}>
          No endpoints match your search.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {chainGroups.map((group) => {
            const chain = buildChainMetaByIndex(group.spec);
            return (
              <div key={group.routerId} className="gw-card" style={{ padding: "14px 16px" }}>

                {/* Chain header */}
                <div className="gw-row" style={{ gap: 10, alignItems: "center", marginBottom: 10 }}>
                  <ChainBadge spec={group.spec} size={26} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{chain.name}</span>
                  {group.network && group.network !== "mainnet" && (
                    <span className="gw-tag" style={{ fontSize: 10, padding: "1px 6px" }}>{group.network}</span>
                  )}
                </div>

                {/* Endpoint rows — compact, click to open sheet. Hover reveals
                    a "Try now" button that fires a live request against the
                    local listen port (the former Live-test console, inline). */}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {group.rows.map((ep) => {
                    const host = ep.port ? `localhost:${ep.port}` : "—";
                    const cnt = providerCount(ep);
                    const hovered = hoverId === ep.id;
                    return (
                      <div key={ep.id}
                        className="gw-row"
                        onClick={() => setDetailId(ep.id)}
                        onMouseEnter={() => setHoverId(ep.id)}
                        onMouseLeave={() => setHoverId((cur) => (cur === ep.id ? null : cur))}
                        style={{
                          gap: 8, padding: "8px 10px", borderRadius: 6, cursor: "pointer",
                          background: hovered ? "var(--hover-2)" : "var(--hover)",
                          border: "1px solid var(--line)", alignItems: "center",
                        }}>
                        <IfaceTag id={ep.iface} />
                        <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                          {host}
                        </span>
                        {/* Try now — inline request console; only when the row
                            has a local port to dial. Hidden until row hover. */}
                        {ep.port !== null && (
                          <TryNowButton
                            spec={ep.spec}
                            network={ep.network}
                            iface={ep.iface}
                            url={epLocalHttp(ep.port)}
                            hasArchive={epHasArchive(ep)}
                            health={healthBySpec.get(ep.spec)}
                            visible={hovered}
                          />
                        )}
                        {ep.port !== null && (
                          <span onClick={(e) => e.stopPropagation()}>
                            <CopyButton text={epLocalHttp(ep.port)} />
                          </span>
                        )}
                        {/* Last used — not tracked on self-hosted */}
                        <span style={{ fontSize: 11, color: "var(--text-4)", flexShrink: 0, whiteSpace: "nowrap" }}>
                          —
                        </span>
                        {/* Provider count chip */}
                        {cnt === 0
                          ? <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: "rgba(239,68,68,0.1)", color: "var(--err)", border: "1px solid rgba(239,68,68,0.22)", flexShrink: 0 }}>No providers</span>
                          : <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: "var(--hover-2)", color: "var(--text-3)", border: "1px solid var(--line)", flexShrink: 0 }}>{cnt} provider{cnt !== 1 ? "s" : ""}</span>}
                        {/* JWT suffix — Magma Cloud feature, masked honest */}
                        <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>—</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="9 18 15 12 9 6"/></svg>
                      </div>
                    );
                  })}
                </div>

              </div>
            );
          })}
        </div>
      )}

      <CreateEndpointSheet
        open={showCreate}
        onClose={() => setShowCreate(false)}
        routers={routers}
        providers={providers}
        existing={endpoints}
      />
      <EndpointDetailSheet
        open={!!liveDetail}
        ep={liveDetail}
        router={detailRouter}
        onClose={() => setDetailId(null)}
        providers={providers}
      />
    </div>
  );
}
