"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiPost } from "@/lib/api-client";
import type { MemberSummary } from "./ChangeRoleModal";

/**
 * Clearing somebody's authenticator — the lost-phone path, and the only one.
 *
 * A confirmation rather than an inline button because of what it does: the
 * member's sessions end immediately and their authenticator stops working, so
 * somebody in the middle of their day is signed out with no warning. Naming
 * them, and saying what happens next, is the difference between an admin doing
 * this deliberately and doing it to the row above the one they meant.
 *
 * What it deliberately does not offer is a new code. An admin who could set
 * somebody's second factor could sign in as them — the same reason no admin can
 * set a password here either.
 */
export function ResetTwoFactorModal({
  open,
  onClose,
  member,
  onReset,
}: {
  open: boolean;
  onClose: () => void;
  member: MemberSummary | null;
  /** After the api has confirmed it; `emailed` when they were told by email. */
  onReset: (emailed: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ notified?: string }>(
        `/api/team/members/${member.id}/2fa/reset`,
        {},
      );
      onReset(res?.notified === "email");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset 2FA.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reset 2FA"
      footer={
        <>
          <button className="gw-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="gw-btn gw-btn--danger" disabled={busy} onClick={() => void reset()}>
            {busy ? "Resetting…" : "Reset 2FA"}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12, fontSize: 13, lineHeight: 1.6 }}>
        <div>
          Clear the authenticator for <strong>{member?.name || member?.email}</strong>
          {member?.name ? <span style={{ color: "var(--text-3)" }}> ({member.email})</span> : null}?
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12.5 }}>
          <li>Their existing key stops working and cannot be restored.</li>
          <li>They are signed out of every device immediately.</li>
          <li>They set up a new authenticator the next time they sign in.</li>
          <li>You will never see or set their code.</li>
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
