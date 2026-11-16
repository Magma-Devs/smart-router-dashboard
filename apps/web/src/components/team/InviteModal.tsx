"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiPost } from "@/lib/api-client";
import { type Role } from "@sr/shared";
import { labelStyle } from "@/lib/styles";
import { RoleBadge, RolePicker } from "./bits";
import { useDeploymentMode } from "./deployment-mode";

interface InviteResponse {
  invite: { id: string; email: string; role: Role; expiresAt: string };
  /** Present whenever the admin has to carry it: always on-prem, and on managed
   *  only when the send did not happen. */
  url?: string;
  delivery: "link" | "email";
  /** Managed, but nothing was sent — SES refused it, or no transport is
   *  configured. Worth wording differently from on-prem: one is the design,
   *  the other is something an operator should go and fix. */
  deliveryFallback?: boolean;
}

export function InviteModal({
  open,
  onClose,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("read_only");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResponse | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const managed = useDeploymentMode() === "managed";

  function reset() {
    setEmail("");
    setRole("read_only");
    setError(null);
    setResult(null);
    setCopied("idle");
  }

  function close() {
    // The request in flight returns a link that is shown once. Closing now
    // would drop it, and the invitation would sit pending with no link anyone
    // holds.
    if (busy) return;
    reset();
    onClose();
  }

  // The link is shown once, so "Copied" has to be true: an admin who closes the
  // dialog on a copy that failed has lost the link. `navigator.clipboard` is
  // undefined outside a secure context — an on-prem dashboard on plain http.
  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<InviteResponse>("/api/team/invites", { email, role });
      setResult(res);
      onInvited();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send that invitation.");
    } finally {
      setBusy(false);
    }
  }

  // Two states in one modal: the form, then the link, which is shown exactly
  // once and cannot be read back afterwards.
  return (
    <Modal
      open={open}
      onClose={close}
      dismissible={!result}
      title={result ? "Invitation created" : "Invite teammate"}
      footer={
        result ? (
          <button className="gw-btn gw-btn--primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="gw-btn" disabled={busy} onClick={close}>
              Cancel
            </button>
            <button
              className="gw-btn gw-btn--primary"
              disabled={busy || !email}
              onClick={() => void submit()}
            >
              {busy ? "Creating…" : "Create invitation"}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13 }}>
            <strong>{result.invite.email}</strong> has been invited as{" "}
            <RoleBadge role={result.invite.role} />
          </div>
          {/* An invitation is not an account yet: the first thing an admin
              does after inviting is look for the person in Members. */}
          <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6 }}>
            They appear in Members once they accept. Until then they are in <strong>Invites</strong>
            .
          </div>
          {result.url ? (
            <>
              <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.6 }}>
                {result.deliveryFallback ? (
                  <>
                    <strong>The email could not be sent</strong>, so pass this link to them yourself
                    and tell an operator that mail is not working. The invitation itself is fine.
                  </>
                ) : (
                  <>This deployment has no mail server, so pass this link to them yourself.</>
                )}{" "}
                It works once, and <strong>you will not be able to see it again</strong>.
              </div>
              <div
                className="gw-mono"
                style={{
                  fontSize: 11.5,
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 7,
                  padding: "10px 12px",
                  wordBreak: "break-all",
                  userSelect: "all",
                }}
              >
                {result.url}
              </div>
              <button className="gw-btn" onClick={() => void copyLink(result.url!)}>
                {copied === "copied" ? "Copied" : "Copy link"}
              </button>
              {copied === "failed" && (
                <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
                  Couldn&apos;t copy it here. Select the link above and copy it by hand.
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>
              We&apos;ve emailed them a join link. It expires in{" "}
              {daysUntil(result.invite.expiresAt)}.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ ...labelStyle, marginBottom: 6 }}>Email address</div>
            <input
              className="gw-input"
              type="email"
              placeholder="colleague@yourcompany.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {/* Managed emails the link to this address, so nobody else holds
                it; on-prem the admin carries it, and the warning is theirs. */}
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
              {managed
                ? "We email them a link. The account is created with this address."
                : "The account is created with this address. Whoever holds the link can accept it, so give it to this person only."}
            </div>
          </div>
          <div>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Role</div>
            <RolePicker value={role} onChange={setRole} gap={6} />
          </div>
          {error && (
            <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** "7 days" / "1 day" — read off the invitation, whose lifetime differs by
 *  deployment shape, rather than written into the copy. */
function daysUntil(iso: string): string {
  const days = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000));
  return days === 1 ? "1 day" : `${days} days`;
}
