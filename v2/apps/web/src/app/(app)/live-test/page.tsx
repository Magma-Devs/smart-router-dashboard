"use client";

/* Live test — the lava-connect "Try me" request console, self-hosted.
 * One gw-card per chain from the mounted router topology; each available
 * interface renders a reference-style endpoint row (hover-reveal "Try it" +
 * copy) that launches the TryMeDrawer against the local listen port.
 *
 * Honest-data rules:
 *  - Endpoint URLs are real local listeners (http://localhost:<port> from
 *    localPorts[iface] ?? localPort) — helm-values configs have no local
 *    ports and fall into the empty state.
 *  - A WS row appears ONLY when the chain's config carries a ws(s)://
 *    upstream for that interface. The router's fiber listeners register the
 *    WS upgrade at /ws and /websocket on the same port as HTTP (smart-router
 *    chainlib jsonRPC.go / tendermintRPC.go), so the URL is
 *    ws://localhost:<port>/websocket.
 *  - The drawer's status tag is threaded from /api/metrics/chains; chains
 *    with no live metrics simply show no tag.
 */

import { useMemo } from "react";
import {
  buildChainMetaByIndex,
  type ChainMetrics,
  type HealthState,
  type RouterTopology,
} from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { isCatalogInterface } from "@/components/try-me/chain-methods";
import { IFACE_LABEL } from "@/components/try-me/drawer";
import { EndpointRow } from "@/components/try-me/endpoint-row";

interface RowModel {
  key: string;
  iface: string;
  label: string;
  url: string;
}

/** HTTP interfaces whose listener also accepts a WebSocket upgrade. */
const WS_CAPABLE = ["jsonrpc", "tendermintrpc"];

function labelFor(iface: string): string {
  return isCatalogInterface(iface) ? IFACE_LABEL[iface] : iface;
}

/** True when any upstream node endpoint on this (router, raw iface) is a
 *  ws(s):// URL — the honest signal that this interface can serve WS. */
function hasWsUpstream(r: RouterTopology, rawIface: string): boolean {
  return r.nodes.some((n) =>
    n.endpoints.some(
      (e) =>
        e.interface === rawIface &&
        (e.urlHost.startsWith("wss://") || e.urlHost.startsWith("ws://")),
    ),
  );
}

/** Whether the mounted config marks an `archive` addon anywhere on the chain
 *  — gates the drawer's Archive tier. */
function hasArchiveAddon(r: RouterTopology): boolean {
  return r.nodes.some((n) => n.endpoints.some((e) => e.addons.includes("archive")));
}

/** One row per (interface with a local listen port), plus a WS variant when
 *  the config proves the capability. */
function rowsForRouter(r: RouterTopology): RowModel[] {
  const out: RowModel[] = [];
  const rawIfaces = r.interfaces.length ? r.interfaces : [""];
  for (const raw of rawIfaces) {
    const port = r.localPorts[raw] ?? r.localPort;
    if (!port) continue;
    // Legacy SR_CONFIG entries that omit api-interface are jsonrpc listeners.
    const iface = raw || "jsonrpc";
    out.push({
      key: iface,
      iface,
      label: labelFor(iface),
      url: `http://localhost:${port}`,
    });
    if (WS_CAPABLE.includes(iface) && hasWsUpstream(r, raw)) {
      const wsIface = `${iface}-ws`;
      out.push({
        key: wsIface,
        iface: wsIface,
        label: labelFor(wsIface),
        url: `ws://localhost:${port}/websocket`,
      });
    }
  }
  return out;
}

export default function LiveTestPage() {
  const config = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  const metrics = useApi<{ chains: ChainMetrics[] }>("/api/metrics/chains?window=1d", 60000);

  const healthBySpec = useMemo(() => {
    const map = new Map<string, HealthState>();
    for (const c of metrics.data?.chains ?? []) map.set(c.spec, c.health);
    return map;
  }, [metrics.data]);

  const cards = useMemo(
    () =>
      (config.data?.routers ?? [])
        .map((router) => ({
          router,
          rows: rowsForRouter(router),
          hasArchive: hasArchiveAddon(router),
        }))
        .filter((c) => c.rows.length > 0),
    [config.data],
  );

  const loading = !config.data && !config.error;

  return (
    <div className="gw-page fade-in">
      <h1>Live test</h1>
      <p className="lede">
        Fire real requests through each local router — pick a method, tweak the
        params, and inspect the response, status, and latency.
      </p>

      {loading ? null : cards.length === 0 ? (
        <div className="gw-empty">
          <div className="gw-empty__icon">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-3)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h2>No local routers to test</h2>
          <p>
            No router config with local listen ports was found. Mount the
            smart-router SR_CONFIG (<code>endpoints:</code> +{" "}
            <code>direct-rpc:</code>) and every chain it serves gets a live
            request console here. Helm-values configs describe remote gateways
            without local ports, so there is nothing to dial from this machine.
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {cards.map(({ router, rows, hasArchive }) => {
            const chain = buildChainMetaByIndex(router.spec);
            const health = healthBySpec.get(router.spec);
            const showNetwork =
              router.network &&
              router.network.toLowerCase() !== router.spec.toLowerCase() &&
              router.network !== "mainnet";
            return (
              <div key={router.id} className="gw-card" style={{ padding: "14px 16px" }}>
                {/* Chain header */}
                <div
                  className="gw-row"
                  style={{ gap: 10, alignItems: "center", marginBottom: 10 }}
                >
                  <ChainBadge spec={router.spec} size={26} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{chain.name}</span>
                  <span
                    className="gw-mono"
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 7px",
                      borderRadius: 4,
                      background: "var(--hover)",
                      color: "var(--text-3)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {router.spec}
                  </span>
                  {showNetwork && (
                    <span className="gw-tag" style={{ fontSize: 10, padding: "1px 6px" }}>
                      {router.network}
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  {router.localPort !== null && (
                    <span
                      className="gw-mono"
                      style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}
                    >
                      localhost:{router.localPort}
                    </span>
                  )}
                </div>

                {/* Endpoint rows — hover reveals Try it + copy */}
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {rows.map((row) => (
                    <EndpointRow
                      key={row.key}
                      spec={router.spec}
                      network={router.network}
                      iface={row.iface}
                      label={row.label}
                      url={row.url}
                      hasArchive={hasArchive}
                      health={health}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
