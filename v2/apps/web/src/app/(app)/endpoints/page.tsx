"use client";

import type { RouterConfig } from "@sr/shared";
import { useApi } from "@/hooks/use-api";

export default function EndpointsPage() {
  const config = useApi<{ routers: RouterConfig[] }>("/api/config/routers", 60000);

  return (
    <div className="gw-page">
      <h1>Endpoints</h1>
      <p className="lede">The live router topology — chains, interfaces, and the backing RPC endpoints behind each.</p>

      <div className="gw-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))" }}>
        {(config.data?.routers ?? []).map((r) => (
          <div className="gw-card" key={`${r.spec}-${r.apiInterface}`}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <strong style={{ fontSize: 15 }}>{r.spec}</strong>
              <span className="tag tag--muted">{r.apiInterface}</span>
            </div>
            {r.listenPort && (
              <div className="muted mono" style={{ fontSize: 12, marginBottom: 12 }}>
                localhost:{r.listenPort}
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {r.nodes.map((n, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{n.name}</span>
                  <span className="muted mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{n.url}</span>
                  {n.addons.length > 0 && (
                    <span style={{ display: "flex", gap: 4, marginTop: 2 }}>
                      {n.addons.map((a) => <span key={a} className="tag tag--muted" style={{ fontSize: 10 }}>{a}</span>)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        {config.data && config.data.routers.length === 0 && (
          <div className="gw-card muted">No router config mounted (set HELM_VALUES_DIR / mount core/values.yml).</div>
        )}
      </div>
    </div>
  );
}
