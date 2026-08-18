"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiSend } from "@/lib/api-client";
import type { MemberSummary } from "./ChangeRoleModal";

/**
 * Removal needs no approval — a confirmation naming the person is enough. What
 * it does need is to say plainly what happens, because "remove" reads like a
 * deletion and this deliberately isn't one.
 */
export function RemoveMemberModal({
  open,
  onClose,
  member,
  onRemoved,
}: {
  open: boolean;
  onClose: () => void;
  member: MemberSummary | null;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend("DELETE", `/api/team/members/${member.id}`);
      onRemoved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove that person.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Remove member"
      footer={
        <>
          <button className="gw-btn" onClick={onClose}>Cancel</button>
          <button className="gw-btn gw-btn--danger" disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : `Remove ${member?.name || member?.email || ""}`}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12, fontSize: 13, lineHeight: 1.6 }}>
        <div>
          <strong>{member?.name || member?.email}</strong>
          {member?.name ? <span style={{ color: "var(--text-3)" }}> ({member.email})</span> : null}{" "}
          will lose access immediately — on whatever they have open right now, not at their next
          sign-in.
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12.5 }}>
          <li>Every device they are signed in on is signed out.</li>
          <li>Any pending invitation to their address is cancelled.</li>
          <li>Their name stays in the audit log permanently.</li>
          <li>Their address can be invited again later, as a new account.</li>
        </ul>
        {error && <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>{error}</div>}
      </div>
    </Modal>
  );
}
