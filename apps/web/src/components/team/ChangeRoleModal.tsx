"use client";

/* Ported verbatim from the design prototype (page-team.jsx ChangeRoleModal).
   Not wired on self-hosted (the members table has no editable rows — there
   is no user store), but kept as the faithful block for when a backend
   exists. */

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { ROLE_LABELS, type TeamMember, type TeamRole } from "./bits";

export function ChangeRoleModal({ open, onClose, member, onSave }: {
  open: boolean;
  onClose: () => void;
  member: TeamMember | null;
  onSave: (id: string, role: TeamRole) => void;
}) {
  const [role, setRole] = useState<TeamRole>(member?.role || "member");
  return (
    <Modal open={open} onClose={onClose} title={"Change role · " + (member?.name || "")}
      footer={
        <>
          <button className="gw-btn" onClick={onClose}>Cancel</button>
          <button className="gw-btn gw-btn--primary" onClick={() => { if (member) onSave(member.id, role); onClose(); }}>Save</button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {(["owner", "admin", "member"] as const).map(r => (
          <button key={r} onClick={() => setRole(r)} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            borderRadius: 8, border: "1px solid " + (role === r ? "var(--brand)" : "var(--line)"),
            background: role === r ? "rgba(255,57,0,0.04)" : "var(--surface)",
            cursor: "pointer", textAlign: "left", fontFamily: "inherit",
          }}>
            <div style={{
              width: 14, height: 14, borderRadius: "50%", flexShrink: 0,
              border: "2px solid " + (role === r ? "var(--brand)" : "var(--line-2)"),
              background: role === r ? "var(--brand)" : "transparent",
            }} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>{ROLE_LABELS[r]}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
