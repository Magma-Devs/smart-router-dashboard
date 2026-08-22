"use client";

/* Upstreams page — ported from the design prototype (page-providers.jsx
 * ProvidersPage). SELF-HOSTED REALITY: the roster is the mounted values
 * file (GET /api/config/routers), grouped one card per config node; live
 * stats join from GET /api/metrics/upstreams (endpointId = node name).
 * All mutating flows render the full design UI with their commit buttons
 * disabled (read-only mount); the Test modal fires a real local POST. */

import { useMemo, useState } from "react";
import {
  buildChainMetaByIndex,
  type UpstreamMetrics,
  type RouterTopology,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { ExplorerHomeLink } from "@/components/gateway/ExplorerLink";
import { ChainSelect } from "@/components/gateway/ChainSelect";
import { WindowSelect } from "@/components/gateway/WindowSelect";
import { RouterFilterSelect } from "@/components/gateway/RouterFilterSelect";
import { useChainFilter, useChainOptions, withMutedRows } from "@/hooks/use-chain-options";
import { useRouterFilter } from "@/hooks/use-router-options";
import { CapabilityTags, capabilitiesOf } from "@/components/gateway/CapabilityTags";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { VendorStatusChip } from "@/components/upstreams/VendorStatusChip";
import { HealthTag } from "@/components/gateway/HealthTag";
import { useVendorStatus } from "@/hooks/use-vendor-status";
import {
  buildUpstreamRows,
  directTargetFor,
  groupByChain,
  type UpstreamChainRow,
  type UpstreamRow,
} from "@/components/upstreams/catalog";
import { IfaceTag } from "@/components/endpoints/bits";
import { RouterGroups } from "@/components/upstreams/RouterGroups";
import { TryNowButton } from "@/components/try-me/try-now-button";
import { useFilters } from "@/components/gateway/FiltersProvider";

/* ─────────────────────────────────────────────
   Stat strip (design: intentionally empty)
───────────────────────────────────────────── */
function StatStrip() { return null; }

/** How the roster is carved up. All three groupings render the same mounted
 *  config — only what a card is about changes: the router that publishes an
 *  endpoint, the chain it serves, or the upstream behind it. ("provider" was
 *  this last one's name before the product settled on "upstream".) */
type GroupBy = "router" | "chain" | "upstream";

/** Initial-badge fallback for unmatched (BYO) nodes — chain-colored. */
function InitialBadge({ name, spec, size = 28 }: { name: string; spec?: string; size?: number }) {
  const color = spec ? buildChainMetaByIndex(spec).color : "var(--surface-2)";
  return (
    <span style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: Math.round(size * 0.43), flexShrink: 0 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * One upstream endpoint. Shared by the chain and upstream groupings, so a row
 * reads the same whichever card it sits in — only the identity it has to spell
 * out changes: an upstream card's header already names the upstream, a chain
 * card's names the chain.
 */
function EndpointRow({
  upstream,
  row,
  routers,
  showUpstream = false,
}: {
  upstream: UpstreamRow;
  row: UpstreamChainRow;
  routers: RouterTopology[];
  showUpstream?: boolean;
}) {
  // Resolve this (router, interface)'s dialable address: the gateway URL a
  // Kubernetes deployment publishes, else the local listen port an SR_CONFIG
  // mount declares. The router serves WebSocket on the SAME address as the
  // base interface (no separate ws port/host), so a ws row dials it with the
  // -ws catalog interface — which makes the Try-me drawer use its WebSocket
  // transport.
  const rtr = routers.find((r) => r.id === row.routerId);
  const isWsRow = row.urlHost.startsWith("ws://") || row.urlHost.startsWith("wss://") || row.iface.endsWith("-ws");
  const publicUrl = rtr?.publicUrls[row.iface] ?? null;
  const localPort = rtr?.localPorts[row.iface] ?? null;
  // WS is served on the same address but ONLY under a path (/ws for jsonrpc,
  // /websocket for tendermint) — a bare ws://host handshake is rejected with
  // HTTP 405.
  const wsPath = row.iface.startsWith("tendermintrpc") ? "/websocket" : "/ws";
  const tryUrl = publicUrl ?? (localPort !== null ? `http://localhost:${localPort}` : null);
  // Both transports go to the drawer; a ws-flagged upstream opens on
  // WebSocket, and either can be toggled to.
  const tryWsUrl = tryUrl === null ? null : tryUrl.replace(/^http/, "ws") + wsPath;
  return (
    <div className="gw-row" style={{ gap: 8, padding: "6px 10px", background: "var(--hover)", borderRadius: 6, border: "1px solid var(--line)" }}>
      {/* Upstream identity — only on a chain card, whose header names the
          chain instead. */}
      {showUpstream && (
        <div className="gw-row" style={{ gap: 7, flexShrink: 0, minWidth: 150 }}>
          {upstream.catalogId
            ? <UpstreamLogo id={upstream.catalogId} size={18} />
            : <InitialBadge name={upstream.name} spec={row.spec} size={18} />}
          <span style={{ fontSize: 12, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {upstream.name}
          </span>
        </div>
      )}
      {/* Role inline — the chain identity is on the card header, not repeated
          per row. Only reserve the slot when the config actually marks a role
          (helm is_backup). */}
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
      {/* The masked host drops path + query, so a provider that pins one
          node-url per internal path (TON's v2 at the root, v3 under /api/v3)
          would render identical rows. The badge is what tells them apart. */}
      {row.internalPath && (
        <span
          className="gw-mono"
          title={`Pinned to internal path ${row.internalPath}`}
          style={{ fontSize: 10, padding: "1px 5px", borderRadius: 4, whiteSpace: "nowrap", color: "var(--text-2)", border: "1px solid var(--line)" }}
        >
          {row.internalPath}
        </span>
      )}
      {/* interface tag + configured capabilities (addons + derived ws) — real
          config values, nothing invented. Same IfaceTag component the
          Endpoints page uses so the badge label + colour are consistent. */}
      {row.iface && <IfaceTag id={row.iface} />}
      <CapabilityTags
        size="xs"
        capabilities={capabilitiesOf({
          addons: row.addons,
          hasWs: row.urlHost.startsWith("ws://") || row.urlHost.startsWith("wss://") || row.iface.endsWith("-ws"),
        })}
      />
      {/* Try now — opens the Try-me drawer preselecting THIS interface. Only
          when the router exposes an address for it (nothing to dial
          otherwise). */}
      {tryUrl !== null && (
        <TryNowButton
          spec={row.spec}
          network={row.network}
          iface={row.iface}
          url={tryUrl}
          wsUrl={tryWsUrl}
          initialTransport={isWsRow ? "ws" : "http"}
          addons={[...new Set(upstream.chainRows.filter((r) => r.spec === row.spec).flatMap((r) => r.addons))]}
          selectUpstream={upstream.name}
          // Lets the drawer offer "Direct to upstream" — the same request sent
          // by the api straight to THIS node-url, with the router left out.
          directTarget={directTargetFor(upstream, row)}
          // Per row: a node can be primary on one chain and backup on another,
          // and the router's pin only works for the primary pool.
          upstreamTier={row.role}
          visible
        />
      )}
    </div>
  );
}

export function UpstreamsView() {
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  /* The shared window (and router scope) the metrics screens use — this page
     used to pin 1d while honouring the scope, which made it the one screen
     where the window selector's absence was a silent override. */
  const { timeWindow, setTimeWindow, scopeQ } = useFilters();
  const { chain, select: selectChain } = useChainFilter();
  /* Effective router selection — the hook drops one the chain filter excluded,
     so the cards can't be narrowed by a router the picker no longer shows. */
  const { routerId } = useRouterFilter();
  const live = useApi<{ upstreams: UpstreamMetrics[] }>(`/api/metrics/upstreams?window=${timeWindow}${scopeQ}`);
  /* What the vendors behind these nodes say about the chains WE route through
     them (Status Page Index). Empty map when the index can't be read — then no
     card carries a vendor chip at all, rather than one saying something
     reassuring. */
  const { bySlug: vendorBySlug, stale: vendorStale } = useVendorStatus();

  const [unhealthyOnly, setUnhealthyOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [netFilter, setNetFilter] = useState<"all" | "mainnet" | "testnet">("all");
  /* Chain filter — the Metrics page's picker, on the same shared selection, so
     narrowing there and walking here keeps the chain. */
  const chainFilter = chain ?? "all";
  /* Router-first by default: the endpoints a router publishes are what a
     self-hosted deployment reaches for — the address to dial, what it serves,
     and how many upstreams stand behind it. The chain and upstream groupings
     answer the two follow-up questions off the same config. */
  const [groupBy, setGroupBy] = useState<GroupBy>("router");
  const [newChainCtas, setNewChainCtas] = useState<{ chainId: string; upstreamName: string }[]>([]);

  const routers = useMemo(() => config.data?.routers ?? [], [config.data]);
  const upstreams = useMemo(
    () => buildUpstreamRows(routers, live.data?.upstreams),
    [routers, live.data],
  );
  /* Config ∪ traffic (see useChainOptions). Here it's the chains NOT in the
     mounted config that get dimmed — they can carry metrics (a values file
     edited after the fact) but this page has no endpoints or upstreams to show
     for them. */
  const { chains: chainRows } = useChainOptions();
  const chainOptions = withMutedRows(chainRows, (c) => (c.inConfig ? false : "not in config"));
  /* The chain actually filtered on. A selection that leaves the list entirely
     reads as "All chains" instead of narrowing everything to nothing — the
     same rule the router scope follows, derived rather than reset so the box
     and the cards can't disagree. */
  const activeChain =
    chainFilter !== "all" && chainOptions.some((c) => c.spec === chainFilter) ? chainFilter : null;

  const displayed = useMemo(() => {
    return upstreams.filter((pv) => {
      const matchHealth = !unhealthyOnly || pv.health === "unhealthy";
      const matchSearch = !search.trim() ||
        pv.name.toLowerCase().includes(search.toLowerCase()) ||
        pv.url.toLowerCase().includes(search.toLowerCase());
      const matchNet = netFilter === "all" || pv.networks.includes(netFilter);
      const matchChain = !activeChain || pv.chains.includes(activeChain);
      // The shared router filter — an upstream belongs to the routers whose
      // config declares it (`routerId` on each of its endpoint rows).
      const matchRouter = !routerId || pv.chainRows.some((r) => r.routerId === routerId);
      return matchHealth && matchSearch && matchNet && matchChain && matchRouter;
    });
  }, [upstreams, unhealthyOnly, search, netFilter, activeChain, routerId]);

  /* Chain grouping filters per ROW, not per upstream: a chain card survives
     when the query matches the chain itself OR any upstream serving it, so
     both "Ethereum" and "publicnode" find something. */
  const chainGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const groups = groupByChain(upstreams).map((group) => ({
      ...group,
      rows: group.rows.filter(({ upstream, row }) =>
        (!routerId || row.routerId === routerId) &&
        (!unhealthyOnly || upstream.health === "unhealthy") &&
        (!q ||
          buildChainMetaByIndex(group.spec).name.toLowerCase().includes(q) ||
          group.spec.toLowerCase().includes(q) ||
          upstream.name.toLowerCase().includes(q) ||
          upstream.url.toLowerCase().includes(q)),
      ),
    }));
    return groups.filter((group) => {
      if (group.rows.length === 0) return false;
      if (activeChain && group.spec !== activeChain) return false;
      if (netFilter === "all") return true;
      const mainnet = buildChainMetaByIndex(group.spec).mainnet;
      return netFilter === "mainnet" ? mainnet : !mainnet;
    });
  }, [upstreams, unhealthyOnly, search, netFilter, activeChain, routerId]);

  const loading = !config.data && !config.error;
  /* Nothing to show. The router grouping renders the routers themselves, so a
     values file with routers but no upstream nodes still has endpoints to
     list — only an empty topology is empty here. */
  const nothingMounted = groupBy === "router" ? routers.length === 0 : upstreams.length === 0;

  return (
    <div className="gw-page fade-in">
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1>Upstreams</h1>
          <p className="lede">
            {groupBy === "router"
              ? "Every endpoint your routers publish, and the upstream RPC nodes behind them"
              : "The upstream RPC nodes this router routes through"} · config{" "}
            <span className="gw-mono" style={{ color: "var(--text-2)" }}>read-only mount</span>.
          </p>
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
              onClick={() => { setGroupBy("router"); setNewChainCtas((fc) => fc.filter((c) => c.chainId !== chainId)); }}>
              View endpoints →
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
          <input className="gw-input" type="search"
            placeholder={groupBy === "router" ? "Search chains, interfaces…" : "Search upstreams…"} value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 32 }} />
        </div>
        {/* Chain filter — the Metrics page's picker, same shared selection. */}
        {chainOptions.length > 1 && (
          <ChainSelect
            value={activeChain ?? "all"}
            onChange={(v) => selectChain(v === "all" ? null : v)}
            chains={chainOptions}
          />
        )}
        {/* Router filter — also shared. This page is built out of the config,
            so it needs no caveat: every grouping here can name the router an
            endpoint belongs to. */}
        <RouterFilterSelect />
        <div className="gw-segctl">
          {([["all", "All"], ["mainnet", "Mainnet"], ["testnet", "Testnet"]] as const).map(([val, lbl]) => (
            <button key={val} className={netFilter === val ? "on" : ""} onClick={() => setNetFilter(val)}>{lbl}</button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {/* The shared time window — the roster's health is derived from the
            metrics in it, so this page can't be the one screen that ignores
            the selector every other screen honours. */}
        <WindowSelect value={timeWindow} onChange={setTimeWindow} />
        {/* One config, three ways to carve it: by the router that publishes an
            endpoint, by the chain it serves, or by the upstream behind it. */}
        <div className="gw-segctl">
          {([["router", "By router"], ["chain", "By chain"], ["upstream", "By upstream"]] as const).map(([val, lbl]) => (
            <button key={val} className={groupBy === val ? "on" : ""} onClick={() => setGroupBy(val)}>{lbl}</button>
          ))}
        </div>
      </div>

      {unhealthyOnly && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, padding: "8px 14px", borderRadius: 8, background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.18)", fontSize: 12, color: "var(--warn)" }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          Showing unhealthy upstreams only —{" "}
          <button onClick={() => setUnhealthyOnly(false)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>clear filter</button>
        </div>
      )}

      {loading ? null : nothingMounted ? (
        <div className="gw-empty">
          <div className="gw-empty__icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
          </div>
          {groupBy === "router" ? (
            <>
              <h2>No endpoints yet</h2>
              <p>No router config mounted — set HELM_VALUES_DIR / mount core/values.yml and its chains and interfaces will appear here.</p>
            </>
          ) : (
            <>
              <h2>No upstreams yet</h2>
              <p>The mounted values file has no upstream nodes. Add your first upstream — Alchemy, Infura, QuickNode, or your own node — by editing the values file.</p>
            </>
          )}
        </div>
      ) : groupBy === "router" ? (
        <RouterGroups routers={routers} upstreams={upstreams} search={search} netFilter={netFilter} chainFilter={activeChain} routerFilter={routerId} />
      ) : groupBy === "chain" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {chainGroups.map((group) => {
            const chain = buildChainMetaByIndex(group.spec);
            return (
              <div key={group.spec} className="gw-card" style={{ padding: "14px 16px" }}>
                {/* header — the chain this card is about; the rows below name
                    the upstream instead. */}
                <div className="gw-row" style={{ gap: 10, marginBottom: 12 }}>
                  <ExplorerHomeLink spec={group.spec}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                      <ChainBadge spec={group.spec} size={28} />
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{chain.name}</span>
                    </span>
                  </ExplorerHomeLink>
                  <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{group.spec}</span>
                  {!chain.mainnet && (
                    <span className="gw-tag" style={{ fontSize: 10, padding: "1px 6px" }}>testnet</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: "var(--hover-2)", color: "var(--text-3)", border: "1px solid var(--line)", flexShrink: 0 }}>
                    {group.upstreams} upstream{group.upstreams !== 1 ? "s" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {group.rows.map(({ upstream, row }, i) => (
                    <EndpointRow key={i} upstream={upstream} row={row} routers={routers} showUpstream />
                  ))}
                </div>
              </div>
            );
          })}
          {chainGroups.length === 0 && (
            <p className="lede" style={{ padding: "12px 2px" }}>No chains match this filter.</p>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {displayed.map((pv) => {
            /* The vendor behind this node, when the catalog matched one and
               the index tracks it (index slugs ARE the catalog ids). The chip
               speaks only for the chains this card serves. */
            const vendor = pv.catalogId !== null ? vendorBySlug.get(pv.catalogId) : undefined;
            return (
              <div key={pv.id} className="gw-card" style={{ padding: "14px 16px", transition: "background 0.4s" }}>
                {/* header */}
                <div className="gw-row" style={{ gap: 14, flexWrap: "wrap", marginBottom: 12 }}>
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
                      {pv.health !== "unknown" && <HealthTag health={pv.health} />}
                      {/* Their claim next to our measurement — the pair is the
                          point: same-coloured means agreement, disagreement is
                          the interesting case. Scoped to this card's chains
                          (narrowed by the chain filter, like the rows below). */}
                      {vendor && (
                        <VendorStatusChip
                          vendor={vendor}
                          specs={activeChain ? pv.chains.filter((c) => c === activeChain) : pv.chains}
                          stale={vendorStale}
                        />
                      )}
                    </div>
                  </div>
                </div>
                {/* endpoint rows, one per (chain, upstream endpoint) served —
                    narrowed to the picked chain, so a card never lists chains
                    the filter excludes. */}
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {pv.chainRows
                    .filter((row) => (!activeChain || row.spec === activeChain) &&
                                     (!routerId || row.routerId === routerId))
                    .map((row, i) => (
                      <EndpointRow key={i} upstream={pv} row={row} routers={routers} />
                    ))}
                </div>
              </div>
            );
          })}
          {displayed.length === 0 && (
            <p className="lede" style={{ padding: "12px 2px" }}>No upstreams match this filter.</p>
          )}
        </div>
      )}

    </div>
  );
}
