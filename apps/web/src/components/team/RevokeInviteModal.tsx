"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiSend } from "@/lib/api-client";

/**
 * Revoking an invitation, behind a confirmation that names the address: the
 * link dies at once and cannot be brought back, only replaced by a new
 * invitation.
 *
 * Mounted per invitation (the page keys it by id), so one error never greets
 * the next.
 */
export function RevokeInviteModal({
  open,
  onClose,
  invite,
  onRevoked,
  onGone,
}: {
  open: boolean;
  onClose: () => void;
  invite: { id: string; email: string } | null;
  onRevoked: () => void;
  /** Any failure: the list may be stale (a 410 means it was redeemed or
   *  revoked elsewhere), so the page reads it again. */
  onGone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    if (!invite) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend("DELETE", `/api/team/invites/${invite.id}`);
      onRevoked();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke that invitation.");
      onGone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Revoke invitation"
      footer={
        <>
          <button className="gw-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="gw-btn gw-btn--danger" disabled={busy} onClick={() => void revoke()}>
            {busy ? "Revoking…" : "Revoke invitation"}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12, fontSize: 13, lineHeight: 1.6 }}>
        <div>
          Revoke the invitation for <strong>{invite?.email}</strong>?
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12.5 }}>
          <li>The link stops working immediately and cannot be restored.</li>
          <li>You can invite this address again later.</li>
        </ul>
        {error && (
          <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
