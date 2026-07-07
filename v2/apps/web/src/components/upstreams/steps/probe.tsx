"use client";

/* Probe step — the design chrome (identity row + capability table), ported
 * from page-providers.jsx ProbeStep. HONEST-STATE DIFFERENCE: the prototype
 * fabricated results from PROBE_CAPS after a fake delay; on self-hosted we
 * never invent probe outcomes, so every check renders the design's own "—"
 * (not-run) state and the read-only Hint closes the step. */

import { useEffect } from "react";
import { labelStyle } from "@/lib/styles";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { Hint } from "@/components/upstreams/bits";
import { READONLY_MSG } from "@/components/upstreams/catalog";

function Check({ val }: { val: boolean | null | undefined }) {
  if (val === undefined)
    return <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "50%", background: "var(--hover)", border: "1px solid var(--line-2)" }} />;
  if (val === null)
    return <span style={{ color: "var(--text-4)", fontSize: 11 }}>—</span>;
  return val
    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>;
}

export function ProbeStep({ catalogId, upstreamName, onReady }: {
  catalogId?: string | null;
  upstreamName?: string;
  onReady?: () => void;
}) {
  useEffect(() => { onReady?.(); }, [onReady]);

  /* No probe runs on self-hosted — all rows stay in the "—" state. */
  const rows: { label: string; method: string; val: boolean | null }[] = [
    { label: "Liveness", method: "eth_chainId", val: null },
    { label: "Standard", method: "eth_getBlockByNumber", val: null },
    { label: "Archive", method: "eth_getStorageAt(…, 0x1)", val: null },
    { label: "Debug", method: "debug_traceTransaction", val: null },
    { label: "Trace", method: "trace_block", val: null },
  ];

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {/* Identity row */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "12px 14px", borderRadius: 10, background: "var(--bg)", border: "1px solid var(--line)" }}>
        <UpstreamLogo id={catalogId ?? undefined} size={34} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{upstreamName || catalogId || "Custom"}</div>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            Capability probes not run — self-hosted
          </div>
        </div>
        <span style={{ color: "var(--text-4)", fontSize: 11 }}>—</span>
      </div>

      {/* Results table */}
      <div style={{ background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "8px 14px", borderBottom: "1px solid var(--line)", display: "flex", gap: 10 }}>
          <span style={{ ...labelStyle, flex: 1 }}>Tier</span>
          <span style={{ ...labelStyle, flex: 2 }}>Probe method</span>
          <span style={{ ...labelStyle, textAlign: "center", minWidth: 40 }}>Result</span>
        </div>
        {rows.map((row, i) => (
          <div key={i} style={{ padding: "9px 14px", borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{row.label}</span>
            <span className="gw-mono" style={{ fontSize: 10, color: "var(--text-3)", flex: 2 }}>{row.method}</span>
            <div style={{ minWidth: 40, display: "flex", justifyContent: "center" }}>
              <Check val={row.val} />
            </div>
          </div>
        ))}
      </div>

      {/* Read-only reality — the final step of every config-mutating flow. */}
      <Hint type="warn">{READONLY_MSG}</Hint>
    </div>
  );
}
