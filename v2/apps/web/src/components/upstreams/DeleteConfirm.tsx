"use client";

/* Delete confirm modal — ported from the design prototype (page-providers.jsx
 * DeleteConfirm). SELF-HOSTED: "Remove upstream" is disabled — the config is
 * a read-only mount. */

import { Modal } from "@/components/gateway/Modal";
import { UpstreamLogo } from "@/components/upstreams/UpstreamLogo";
import { Hint } from "@/components/upstreams/bits";
import { READONLY_MSG, type UpstreamRow } from "@/components/upstreams/catalog";

export function DeleteConfirm({ open, onClose, upstream }: {
  open: boolean;
  onClose: () => void;
  upstream: UpstreamRow | null;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Remove upstream"
      footer={<><button className="gw-btn" onClick={onClose}>Cancel</button><button className="gw-btn gw-btn--danger" disabled title={READONLY_MSG} style={{ background: "var(--err)", color: "#fff", borderColor: "var(--err)" }}>Remove upstream</button></>}>
      {upstream && (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {upstream.catalogId ? <UpstreamLogo id={upstream.catalogId} size={28} /> : null}
            <div style={{ fontSize: 13, fontWeight: 600 }}>{upstream.name}</div>
          </div>
          <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(239,68,68,0.06)", border: "1px solid rgba(239,68,68,0.2)", fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>
            Any routes currently using <strong>{upstream.name}</strong> will lose this upstream immediately. <strong>This cannot be undone.</strong>
          </div>
          <Hint type="warn">{READONLY_MSG}</Hint>
        </div>
      )}
    </Modal>
  );
}
