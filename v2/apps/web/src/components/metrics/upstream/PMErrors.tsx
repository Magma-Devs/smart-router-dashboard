"use client";

/* PMErrorCodes + PMRecentErrors — the per-upstream error-code list and the
 * "Recent errors" modal. Ported verbatim from the design prototype
 * (page-provider-metrics.jsx). Live: /api/metrics/upstream-detail returns
 * errorsByCode/recentErrors EMPTY with emitted:false until the router emits
 * labelled error counters — both render the design's own empty branches. */

import type { UpstreamErrorCode, UpstreamRecentError } from "@sr/shared";
import { Modal } from "@/components/gateway/Modal";
import { fmtComma } from "@/lib/format";

export function PMErrorCodes({ codes }: { codes: UpstreamErrorCode[] }) {
  const errs = [...codes].sort((a, b) => b.count - a.count);
  const total = errs.reduce((s, e) => s + e.count, 0);
  if (!errs.length) return <div style={{ fontSize: 12, color: "var(--text-4)", padding: "2px 0" }}>No errors recorded this window.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {errs.map((e) => {
        // No live error catalog yet — the design's own `||` fallback shape.
        const color = "var(--text-3)";
        const isInt = false;
        const retryable = true;
        const pct = total ? Math.round((e.count / total) * 100) : 0;
        return (
          <div key={e.code} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="gw-mono" style={{ fontSize: 11.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.code}</div>
              <div style={{ display: "flex", gap: 5, marginTop: 3 }}>
                <span style={{ fontSize: 8.5, fontWeight: 700, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", background: isInt ? "rgba(129,140,248,0.14)" : "rgba(245,158,11,0.12)", color: isInt ? "#818cf8" : "#f59e0b" }}>{isInt ? "router" : "chain / upstream"}</span>
                <span style={{ fontSize: 8.5, fontWeight: 700, padding: "1px 5px", borderRadius: 3, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap", background: retryable ? "rgba(96,165,250,0.12)" : "rgba(148,163,184,0.14)", color: retryable ? "#60a5fa" : "var(--text-3)" }}>{retryable ? "retryable" : "non-retryable"}</span>
              </div>
            </div>
            <div style={{ width: 60, height: 5, borderRadius: 999, background: "var(--bg-2)", flexShrink: 0 }}>
              <div style={{ width: Math.max(pct, 2) + "%", height: "100%", borderRadius: 999, background: color, opacity: 0.85 }} />
            </div>
            <span style={{ fontSize: 10, color: "var(--text-4)", minWidth: 26, textAlign: "right", flexShrink: 0 }}>{pct}%</span>
            <span className="gw-mono gw-tnum" style={{ fontSize: 12.5, fontWeight: 600, minWidth: 48, textAlign: "right", flexShrink: 0 }}>{fmtComma(e.count)}</span>
          </div>
        );
      })}
    </div>
  );
}

function pmAgo(sec: number): string {
  if (sec < 60) return Math.round(sec) + "s ago";
  const m = Math.floor(sec / 60);
  if (m < 60) return m + "m ago";
  return Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}

function agoFromIso(at: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  return pmAgo(Math.max(0, (Date.now() - t) / 1000));
}

export function PMRecentErrors({ name, chainName, rows, open, onClose }: {
  name: string;
  chainName: string;
  rows: UpstreamRecentError[];
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Recent errors"
      footer={<button className="gw-btn" onClick={onClose}>Close</button>}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 12, color: "var(--text-3)" }}>
        <span>Latest {rows.length} for <strong style={{ color: "var(--text-2)" }}>{name}</strong> · {chainName}</span>
        <span style={{ marginLeft: "auto", fontSize: 9.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-4)", border: "1px solid var(--line)", borderRadius: 4, padding: "2px 7px" }}>from error log</span>
      </div>
      {rows.length ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: i < rows.length - 1 ? "1px solid var(--line)" : "none" }}>
              <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-4)", minWidth: 66, flexShrink: 0 }}>{agoFromIso(r.at)}</span>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: "var(--text-3)", flexShrink: 0 }} />
              <span className="gw-mono" style={{ fontSize: 12, color: "var(--err)", flexShrink: 0 }}>{r.code ?? r.message}</span>
              <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)", flex: 1, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.method ?? "—"}</span>
            </div>
          ))}
        </div>
      ) : <div style={{ fontSize: 13, color: "var(--text-4)", padding: "24px 0", textAlign: "center" }}>No errors recorded this window.</div>}
    </Modal>
  );
}
