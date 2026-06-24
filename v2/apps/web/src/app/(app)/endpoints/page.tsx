"use client";

import { useMemo, useState } from "react";
import type { RouterConfig } from "@sr/shared";
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
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
      <span className="tag tag--muted" style={{ fontSize: 10, minWidth: 84, justifyContent: "center" }}>{IFACE_LABEL[iface] ?? iface}</span>
      <span className="gw-mono" style={{ flex: 1, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</span>
      {addons.length > 0 && addons.map((a) => <span key={a} className="tag tag--muted" style={{ fontSize: 9 }}>{a}</span>)}
      <span className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{providerCount} provider{providerCount === 1 ? "" : "s"}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
    </div>
  );
}

export default function EndpointsPage() {
  const { data } = useApi<{ routers: RouterConfig[] }>("/api/config/routers", 60000);
  const [net, setNet] = useState<NetFilter>("all");

  // Group routers by spec → one card per chain, each interface a row.
  const cards = useMemo(() => {
    const bySpec = new Map<string, RouterConfig[]>();
    for (const r of data?.routers ?? []) {
      const list = bySpec.get(r.spec) ?? [];
      list.push(r);
      bySpec.set(r.spec, list);
    }
    return [...bySpec.entries()].map(([spec, routers]) => ({ spec, meta: buildChainMetaByIndex(spec), routers }));
  }, [data]);

  return (
    <div className="gw-page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>Endpoints</h1>
          <p style={{ margin: "4px 0 0", color: "var(--text-3)", fontSize: 13 }}>The live router topology — chains, interfaces, and backing RPC endpoints.</p>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div className="gw-segctl">
            {(["all", "mainnet", "testnet"] as const).map((n) => (
              <button key={n} className={net === n ? "on" : ""} onClick={() => setNet(n)} style={{ textTransform: "capitalize" }}>{n}</button>
            ))}
          </div>
          <button className="gw-btn gw-btn--primary" style={{ fontSize: 12, padding: "6px 12px" }}>New endpoint</button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {cards.map(({ spec, meta, routers }) => {
          const totalProviders = routers.reduce((n, r) => n + r.nodes.length, 0);
          const port = routers[0]?.listenPort;
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
              {/* One row per (interface) */}
              {routers.map((r, i) => (
                <IfaceRow
                  key={i}
                  iface={r.apiInterface}
                  host={r.nodes[0]?.url ?? ""}
                  providerCount={r.nodes.length}
                  addons={r.nodes.flatMap((n) => n.addons)}
                />
              ))}
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
