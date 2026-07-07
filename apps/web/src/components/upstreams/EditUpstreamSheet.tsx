"use client";

/* Edit Upstream Sheet — ported from the design prototype (page-providers.jsx
 * EditUpstreamSheet: name + role form). SELF-HOSTED: the form renders and is
 * editable, but "Save changes" is disabled — the config is a read-only mount. */

import { useEffect, useState } from "react";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { FE, FL, Hint } from "@/components/upstreams/bits";
import { READONLY_MSG, type UpstreamRow } from "@/components/upstreams/catalog";

export function EditUpstreamSheet({ open, onClose, upstream }: {
  open: boolean;
  onClose: () => void;
  upstream: UpstreamRow | null;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<"primary" | "backup">("primary");
  const errors: { name?: string } = {};

  useEffect(() => {
    if (open && upstream) {
      setName(upstream.name);
      setRole(upstream.role || "primary");
    }
  }, [open, upstream]);

  if (!open || !upstream) return null;
  return (
    <div className="gw-sheet-bg" onClick={onClose}>
      <div className="gw-sheet gw-sheet--wide" onClick={(e) => e.stopPropagation()}>
        <div className="gw-sheet__head">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
            {upstream.catalogId ? <UpstreamLogo id={upstream.catalogId} size={30} /> : <div style={{ width: 30, height: 30, borderRadius: 7, background: "var(--surface-2)", border: "1px solid var(--line)", flexShrink: 0 }} />}
            <div style={{ minWidth: 0 }}>
              <p className="gw-sheet__title" style={{ margin: 0 }}>{upstream.name}</p>
              <p className="gw-sheet__sub" style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{upstream.url || "—"}</p>
            </div>
          </div>
          <button className="gw-btn gw-btn--ghost" style={{ padding: 5, flexShrink: 0 }} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className="gw-sheet__body">

          {/* Name */}
          <div>
            <FL>Display name <span style={{ color: "var(--err)" }}>*</span></FL>
            <input className="gw-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            <FE msg={errors.name} />
          </div>

          {/* Role */}
          <div style={{ marginTop: 16 }}>
            <FL>Role</FL>
            <div style={{ display: "flex", gap: 8 }}>
              {([["primary", "Primary"], ["backup", "Backup"]] as const).map(([v, lbl]) => (
                <button key={v} onClick={() => setRole(v)} style={{
                  flex: 1, padding: "9px 12px", borderRadius: 8, fontSize: 13, fontWeight: 500,
                  cursor: "pointer", fontFamily: "inherit",
                  border: "1px solid " + (role === v ? "var(--brand)" : "var(--line)"),
                  background: role === v ? "rgba(255,57,0,0.07)" : "var(--bg)",
                  color: role === v ? "var(--brand)" : "var(--text-2)",
                }}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Read-only reality */}
          <Hint type="warn">{READONLY_MSG}</Hint>

        </div>

        <div className="gw-sheet__foot">
          <button className="gw-btn" onClick={onClose}>Cancel</button>
          <button className="gw-btn gw-btn--primary" disabled title={READONLY_MSG}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
