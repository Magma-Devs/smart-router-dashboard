"use client";

/* PMPanel / PMStat / PMNoVal — small presentational bits of the Providers
 * tab. Ported verbatim from the design prototype (page-provider-metrics.jsx);
 * PMTip is merged into the shared gateway <Tip /> (same markup + styles). */

import { Tip } from "@/components/gateway/Tip";

export function PMPanel({ title, tip, children, height, right, full }: {
  title: string;
  tip?: string;
  children?: React.ReactNode;
  height?: number | string;
  right?: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className="gw-card" style={{ padding: 0, display: "flex", flexDirection: "column", gridColumn: full ? "1 / -1" : undefined }}>
      <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>{title}</span>
        {tip && <Tip text={tip} />}
        <div style={{ flex: 1 }} />
        {right}
      </div>
      <div style={{ padding: "12px 14px", height }}>{children}</div>
    </div>
  );
}

export function PMStat({ label, tip, children }: {
  label: string;
  tip?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="gw-card" style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.09em", fontWeight: 600, color: "var(--text-3)" }}>{label}</span>
        {tip && <Tip text={tip} />}
      </div>
      <div style={{ marginTop: 9 }}>{children}</div>
    </div>
  );
}

export function PMNoVal() {
  return <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-4)", paddingTop: 4 }}>No data</div>;
}
