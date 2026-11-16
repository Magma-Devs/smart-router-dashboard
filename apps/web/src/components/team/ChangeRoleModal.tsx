"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiSend } from "@/lib/api-client";
import { isRole, type Role } from "@sr/shared";
import { RolePicker } from "./bits";

export interface MemberSummary {
  id: string;
  name: string | null;
  email: string;
  role: Role;
}

/** Mounted per member (the page keys it by id), so the selection and any
 *  error start fresh for each one rather than being synced in an effect. */
export function ChangeRoleModal({
  open,
  onClose,
  member,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  member: MemberSummary | null;
  /** After the api has confirmed it, with the role it confirmed. */
  onChanged: (role: Role) => void;
}) {
  const [role, setRole] = useState<Role>(member?.role ?? "read_only");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiSend<{ member?: { role?: unknown } }>(
        "PATCH",
        `/api/team/members/${member.id}`,
        {
          role,
        },
      );
      const confirmed = res?.member?.role;
      onChanged(isRole(confirmed) ? confirmed : role);
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
        <RolePicker value={role} onChange={setRole} />
        <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5 }}>
          This takes effect immediately, on whatever they have open right now, not at their next
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
