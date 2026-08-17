"use client";

/* Router grouping for the Upstreams page — one card per router in the mounted
 * values file, rows for the (router × interface) endpoints it publishes.
 *
 * This is the former standalone Endpoints page (page-endpoints.jsx
 * EndpointsPage), folded in as the roster's third grouping: the page already
 * carved the same config three ways in prose ("who serves this chain", "what
 * does this upstream serve"), and "what does this router publish" was the one
 * living on its own tab. Rows read exactly as they did there — same iface tag,
 * capability chips, address resolution, Try-now console and detail sheet — so
 * moving the surface changed nothing about it.
 *
 * SELF-HOSTED REALITY: an "endpoint" is one (router × interface) surface; its
 * address is the published gateway URL, else the local listen port. JWT suffix
 * / last-used are Magma-Cloud data — they render "—" (never fabricated). */

import { useMemo, useState } from "react";
import {
  buildChainMetaByIndex,
  type ChainMetrics,
  type HealthState,
  type RouterTopology,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { CopyButton } from "@/components/gateway/CopyButton";
import { CapabilityTags, capabilitiesOf } from "@/components/gateway/CapabilityTags";
import { useFilters } from "@/components/gateway/FiltersProvider";
import {
  IfaceTag,
  buildEndpointRows,
  epAddons,
  epDisplayHost,
  epHasWs,
  epHttpUrl,
  epWsUrl,
  upstreamCount,
  type EndpointRowModel,
} from "@/components/endpoints/bits";
import { EndpointDetailSheet } from "@/components/endpoints/EndpointDetailSheet";
import { TryNowButton } from "@/components/try-me/try-now-button";
import type { UpstreamRow } from "@/components/upstreams/catalog";

interface RouterGroup {
  routerId: string;
  spec: string;
  network: string;
  rows: EndpointRowModel[];
}

export function RouterGroups({
  routers,
  upstreams,
  search,
  netFilter,
  chainFilter,
}: {
  routers: RouterTopology[];
  /** Upstream roster — the detail sheet lists the nodes behind an endpoint. */
  upstreams: UpstreamRow[];
  /** Page-level filters, applied to the rows this grouping renders. */
  search: string;
  netFilter: "all" | "mainnet" | "testnet";
  /** Spec label from the page's chain picker; null = every chain. */
  chainFilter: string | null;
}) {
  const { scopeQ } = useFilters();
  // Health per spec — threaded into the Try-now drawer's status tag (omitted
  // when a chain has no live metrics; never a hardcoded status).
  const chainMetrics = useApi<{ chains: ChainMetrics[] }>(`/api/metrics/chains?window=1d${scopeQ}`, 60000);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const endpoints = useMemo(() => buildEndpointRows(routers), [routers]);
  const healthBySpec = useMemo(() => {
    const map = new Map<string, HealthState>();
    for (const c of chainMetrics.data?.chains ?? []) map.set(c.spec, c.health);
    return map;
  }, [chainMetrics.data]);

  const groups = useMemo<RouterGroup[]>(() => {
    const filtered = endpoints.filter((ep) => {
      const c = buildChainMetaByIndex(ep.spec);
      const host = epHttpUrl(ep) ?? "";
      const q = search.trim().toLowerCase();
      const matchSearch = !q ||
        c.name.toLowerCase().includes(q) ||
        ep.spec.toLowerCase().includes(q) ||
        host.toLowerCase().includes(q) ||
        ep.iface.toLowerCase().includes(q);
      // Mainnet/testnet comes from the chain map (ep.network is the lowercased
      // spec index, never literally "mainnet"/"testnet").
      const matchNet =
        netFilter === "all" ||
        (netFilter === "mainnet" ? c.mainnet : !c.mainnet);
      const matchChain = chainFilter === null || ep.spec === chainFilter;
      return matchSearch && matchNet && matchChain;
    });
    const map = new Map<string, RouterGroup>();
    filtered.forEach((ep) => {
      let g = map.get(ep.routerId);
      if (!g) {
        g = { routerId: ep.routerId, spec: ep.spec, network: ep.network, rows: [] };
        map.set(ep.routerId, g);
      }
      g.rows.push(ep);
    });
    return [...map.values()];
  }, [endpoints, search, netFilter, chainFilter]);

  /* Specs served by more than one router — the config allows several routers
     on one chain (different ids/hostnames, same `network`), and those cards
     need the router id to tell them apart. */
  const duplicatedSpecs = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const r of routers) {
      if (seen.has(r.spec)) dupes.add(r.spec);
      seen.add(r.spec);
    }
    return dupes;
  }, [routers]);

  const liveDetail = detailId ? endpoints.find((e) => e.id === detailId) ?? null : null;
  const detailRouter = liveDetail ? routers.find((r) => r.id === liveDetail.routerId) ?? null : null;

  return (
    <>
      {groups.length === 0 ? (
        <p className="lede" style={{ padding: "12px 2px" }}>No endpoints match this filter.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((group) => {
            const chain = buildChainMetaByIndex(group.spec);
            return (
              <div key={group.routerId} className="gw-card" style={{ padding: "14px 16px" }}>

                {/* Chain header. No raw-index chip — the name + brand icon
                    identify the chain; only flag genuine testnets. The router
                    id is appended only when several routers serve the SAME
                    chain (e.g. a staging + production pair on one network),
                    which is the only case where the chain name alone is
                    ambiguous. */}
                <div className="gw-row" style={{ gap: 10, alignItems: "center", marginBottom: 10 }}>
                  <ChainBadge spec={group.spec} size={26} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{chain.name}</span>
                  {duplicatedSpecs.has(group.spec) && (
                    <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{group.routerId}</span>
                  )}
                  {!chain.mainnet && (
                    <span className="gw-tag" style={{ fontSize: 10, padding: "1px 6px" }}>testnet</span>
                  )}
                </div>

                {/* Endpoint rows — compact, click to open sheet. Hover reveals
                    a "Try now" button that fires a live request against the
                    endpoint's address (the request console, inline). */}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {group.rows.map((ep) => {
                    const host = epDisplayHost(ep);
                    const url = epHttpUrl(ep);
                    const cnt = upstreamCount(ep);
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
                        {/* Configured capabilities on this endpoint (addons +
                            derived ws) — what the mounted config actually
                            declares; nothing shown when it declares none. */}
                        <CapabilityTags
                          size="xs"
                          capabilities={capabilitiesOf({ addons: epAddons(ep), hasWs: epHasWs(ep) })}
                        />
                        <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                          {host}
                        </span>
                        {/* Try now — inline request console; only when the row
                            has an address to dial (gateway URL on a helm
                            deployment, local listen port on an SR_CONFIG
                            mount). Hidden until row hover. */}
                        {url !== null && (
                          <TryNowButton
                            spec={ep.spec}
                            network={ep.network}
                            iface={ep.iface}
                            url={url}
                            // Same endpoint over its ws upgrade, when the
                            // config declares a websocket upstream for it —
                            // the drawer offers both transports.
                            wsUrl={epHasWs(ep) ? epWsUrl(ep) : null}
                            addons={epAddons(ep)}
                            health={healthBySpec.get(ep.spec)}
                            visible={hovered}
                          />
                        )}
                        {url !== null && (
                          <span onClick={(e) => e.stopPropagation()}>
                            <CopyButton text={url} />
                          </span>
                        )}
                        {/* Last used — not tracked on self-hosted */}
                        <span style={{ fontSize: 11, color: "var(--text-4)", flexShrink: 0, whiteSpace: "nowrap" }}>
                          —
                        </span>
                        {/* Upstream count chip */}
                        {cnt === 0
                          ? <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: "rgba(239,68,68,0.1)", color: "var(--err)", border: "1px solid rgba(239,68,68,0.22)", flexShrink: 0 }}>No upstreams</span>
                          : <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 7px", borderRadius: 4, background: "var(--hover-2)", color: "var(--text-3)", border: "1px solid var(--line)", flexShrink: 0 }}>{cnt} upstream{cnt !== 1 ? "s" : ""}</span>}
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

      <EndpointDetailSheet
        open={!!liveDetail}
        ep={liveDetail}
        router={detailRouter}
        onClose={() => setDetailId(null)}
        upstreams={upstreams}
      />
    </>
  );
}
