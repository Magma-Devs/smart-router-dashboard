"use client";

/* PMEmpty — explicit empty state for an upstream with no recent traffic.
 * Ported verbatim from the design prototype (page-provider-metrics.jsx). */

export function PMEmpty({ name, chainName }: { name: string; chainName: string }) {
  return (
    <div className="gw-card" style={{ padding: "56px 24px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l2 6 4-12 2 6h6" />
      </svg>
      <div>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)" }}>No recent traffic for {name}</div>
        <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6, maxWidth: 380, lineHeight: 1.6 }}>
          This upstream is configured on {chainName} and probes are passing, but it hasn&apos;t served live requests in the selected window. Traffic &amp; latency panels appear once the router sends it requests.
        </div>
      </div>
      <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 11px", borderRadius: 999, border: "1px solid var(--line)", fontSize: 11, color: "var(--text-2)" }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--ok)", boxShadow: "0 0 6px var(--ok)" }} />
        Probes healthy · standing by as backup
      </span>
    </div>
  );
}
