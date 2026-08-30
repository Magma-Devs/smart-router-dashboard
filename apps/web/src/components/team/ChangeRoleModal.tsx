"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiSend } from "@/lib/api-client";
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@sr/shared";

export interface MemberSummary {
  id: string;
  name: string | null;
  email: string;
  role: Role;
}

export function ChangeRoleModal({
  open,
  onClose,
  member,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  member: MemberSummary | null;
  onChanged: () => void;
}) {
  const [role, setRole] = useState<Role>(member?.role ?? "read_only");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (member) {
      setRole(member.role);
      setError(null);
    }
  }, [member]);

  async function save() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend("PATCH", `/api/team/members/${member.id}`, { role });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change that role.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Change role · ${member?.name || member?.email || ""}`}
      footer={
        <>
          <button className="gw-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="gw-btn gw-btn--primary"
            disabled={busy || role === member?.role}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ROLES.map((r) => (
          <button
            key={r}
            onClick={() => setRole(r)}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid " + (role === r ? "var(--brand)" : "var(--line)"),
              background: role === r ? "rgba(255,57,0,0.04)" : "var(--surface)",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              color: "var(--text)",
            }}
          >
            <div
              style={{
                width: 14,
                height: 14,
                borderRadius: "50%",
                flexShrink: 0,
                marginTop: 2,
                border: "2px solid " + (role === r ? "var(--brand)" : "var(--line-2)"),
                background: role === r ? "var(--brand)" : "transparent",
              }}
            />
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{ROLE_LABELS[r]}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}>
                {ROLE_DESCRIPTIONS[r]}
              </div>
            </div>
          </button>
        ))}
        <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5 }}>
          This takes effect immediately, on whatever they have open right now — not at their next
          sign-in.
        </div>
        {error && (
          <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
