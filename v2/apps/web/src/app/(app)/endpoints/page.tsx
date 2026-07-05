"use client";

import { useMemo, useState } from "react";
import type { RouterTopology } from "@sr/shared";
import { buildChainMetaByIndex } from "@sr/shared";
import { useApi } from "@/hooks/use-api";

const IFACE_LABEL: Record<string, string> = {
  jsonrpc: "JSON-RPC",
  rest: "REST",
  tendermintrpc: "Tendermint RPC",
  grpc: "gRPC",
  websocket: "WebSocket",
};

type NetFilter = "all" | "mainnet" | "testnet";

/** One interface row inside an endpoint card. */
function IfaceRow({ iface, host, providerCount, addons }: { iface: string; host: string; providerCount: number; addons: string[] }) {
  const url = (() => {
    try {
      return new URL(host).host;
    } catch {
      return host.replace(/^https?:\/\//, "").replace(/^wss?:\/\//, "");
    }
  })();
  const ifaceColor = iface === "websocket" ? "var(--ok)" : "var(--info)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", marginTop: 8, borderRadius: 10, background: "var(--bg-2)", border: "1px solid var(--line)", fontSize: 13 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", color: ifaceColor, minWidth: 84 }}>{(IFACE_LABEL[iface] ?? iface).toUpperCase()}</span>
      <span className="gw-mono" style={{ flex: 1, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</span>
      {addons.length > 0 && addons.map((a) => <span key={a} className="tag tag--muted" style={{ fontSize: 9 }}>{a}</span>)}
      {/* copy icon */}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      <span className="tag tag--muted" style={{ fontSize: 10 }}>{providerCount} provider{providerCount === 1 ? "" : "s"}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
    </div>
  );
}

export default function EndpointsPage() {
  const { data } = useApi<{ routers: RouterTopology[] }>("/api/config/routers", 60000);
  const [net, setNet] = useState<NetFilter>("all");
  const [query, setQuery] = useState("");

  // One card per chain; each interface a row (topology is already per-chain).
  const cards = useMemo(() => {
    return (data?.routers ?? [])
      .map((router) => ({ spec: router.spec, meta: buildChainMetaByIndex(router.spec), router }))
      .filter(({ spec, meta, router }) => {
        const q = query.toLowerCase();
        return (
          !q ||
          meta.name.toLowerCase().includes(q) ||
          spec.toLowerCase().includes(q) ||
          router.interfaces.some((i) => i.toLowerCase().includes(q))
        );
      });
  }, [data, query]);

  return (
    <div className="gw-page">
      {/* Title + New endpoint */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>Endpoints</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-3)", fontSize: 13 }}>The live router topology — chains, interfaces, and backing RPC endpoints.</p>
        </div>
        <button className="gw-btn gw-btn--primary" style={{ fontSize: 13, padding: "8px 14px" }}>+ New endpoint</button>
      </div>

      {/* Search + filter */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
        <input
          className="gw-input"
          placeholder="Search chains, interfaces…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ maxWidth: 380, height: 38 }}
        />
        <div className="gw-segctl">
          {(["all", "mainnet", "testnet"] as const).map((n) => (
            <button key={n} className={net === n ? "on" : ""} onClick={() => setNet(n)} style={{ textTransform: "capitalize" }}>{n}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {cards.map(({ spec, meta, router }) => {
          const totalProviders = router.nodes.length;
          const port = router.localPort;
          const ifaces = router.interfaces.length ? router.interfaces : [""];
          return (
            <div className="gw-card" key={spec}>
              {/* Header row: letter badge + chain name + meta */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <span style={{ width: 30, height: 30, borderRadius: 8, background: meta.color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
                  {meta.name.slice(0, 1).toUpperCase()}
                </span>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{meta.name}</span>
                <span className="muted mono" style={{ fontSize: 11 }}>{spec}</span>
                {port && <span className="muted mono" style={{ fontSize: 11 }}>:{port}</span>}
                <div style={{ flex: 1 }} />
                <span className="muted" style={{ fontSize: 12 }}>{totalProviders} provider{totalProviders === 1 ? "" : "s"}</span>
              </div>
              {/* One row per interface */}
              {ifaces.map((iface) => {
                const nodes = router.nodes.filter((n) =>
                  n.endpoints.some((e) => e.interface === iface),
                );
                const eps = nodes.flatMap((n) => n.endpoints.filter((e) => e.interface === iface));
                return (
                  <IfaceRow
                    key={iface || "default"}
                    iface={iface || "jsonrpc"}
                    host={eps[0]?.urlHost ?? ""}
                    providerCount={nodes.length}
                    addons={[...new Set(eps.flatMap((e) => e.addons))]}
                  />
                );
              })}
            </div>
          );
        })}
        {data && cards.length === 0 && (
          <div className="gw-card muted">No router config mounted (set HELM_VALUES_DIR / mount core/values.yml).</div>
        )}
      </div>
    </div>
  );
}
