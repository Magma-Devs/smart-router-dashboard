"use client";

/* Ported verbatim from the design prototype (page-team.jsx InviteModal).
   Self-hosted reality: there is no user store to invite into — the form
   chrome is intact but the submit stays disabled (team accounts are a
   Magma Cloud feature). No invitation is ever sent from here. */

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { labelStyle } from "@/lib/styles";

export function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  return (
    <Modal open={open} onClose={onClose} title="Invite teammate"
      footer={
        <>
          <button className="gw-btn" onClick={onClose}>Cancel</button>
          <button className="gw-btn gw-btn--primary" disabled title="Team accounts are a Magma Cloud feature">
            Send invitation
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        <div>
          <div style={{ ...labelStyle, marginBottom: 6 }}>Email address</div>
          <input className="gw-input" type="email" placeholder="colleague@yourcompany.com"
            value={email} onChange={e => setEmail(e.target.value)} />
        </div>
        <div>
          <div style={{ ...labelStyle, marginBottom: 8 }}>Role</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {([
              { id: "admin", label: "Admin", desc: "Full access — manage routes, upstreams, billing, and team." },
              { id: "member", label: "Member", desc: "Read access to routes and metrics. Cannot manage billing or team." },
            ] as const).map(r => (
              <button key={r.id} onClick={() => setRole(r.id)} style={{
                display: "flex", alignItems: "flex-start", gap: 10, padding: "10px 12px",
                borderRadius: 8, border: "1px solid " + (role === r.id ? "var(--brand)" : "var(--line)"),
                background: role === r.id ? "rgba(255,57,0,0.04)" : "var(--surface)",
                cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "var(--text)",
              }}>
                <div style={{
                  width: 14, height: 14, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                  border: "2px solid " + (role === r.id ? "var(--brand)" : "var(--line-2)"),
                  background: role === r.id ? "var(--brand)" : "transparent",
                }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{r.label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 1 }}>{r.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div style={{
          display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 12px", borderRadius: 8,
          background: "rgba(96,165,250,0.08)", border: "1px solid rgba(96,165,250,0.22)",
          fontSize: 12, color: "var(--text-2)", lineHeight: 1.5,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          <span><strong style={{ color: "var(--text)", fontWeight: 600 }}>Team accounts are a Magma&nbsp;Cloud feature.</strong> This self-hosted deployment uses a single shared login, so invitations can&apos;t be sent from here.</span>
        </div>
      </div>
    </Modal>
  );
}
