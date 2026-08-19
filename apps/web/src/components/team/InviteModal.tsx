"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiPost } from "@/lib/api-client";
import { ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@sr/shared";
import { labelStyle } from "@/lib/styles";

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
  const [copied, setCopied] = useState(false);

  function reset() {
    setEmail("");
    setRole("read_only");
    setError(null);
    setResult(null);
    setCopied(false);
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

  // Two states in one modal: the form, then — on-prem — the link, which is
  // shown exactly once and cannot be read back afterwards.
  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={result ? "Invitation created" : "Invite teammate"}
      footer={
        result ? (
          <button
            className="gw-btn gw-btn--primary"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Done
          </button>
        ) : (
          <>
            <button
              className="gw-btn"
              onClick={() => {
                reset();
                onClose();
              }}
            >
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
            {ROLE_LABELS[result.invite.role]}.
          </div>
          {/* An invitation is not an account yet, and nothing on screen said so:
              the first thing an admin does after inviting is look for the person
              in Members, where they will not be until they redeem. */}
          <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6 }}>
            They are in <strong>Invites</strong> until they open the link and choose a password. The
            account — and their row in Members — is created at that moment, with this address.
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
              <button
                className="gw-btn"
                onClick={() => {
                  void navigator.clipboard.writeText(result.url!);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--text-2)" }}>
              We&apos;ve emailed them a join link. It expires in seven days.
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
            <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
              The invitation can only be accepted by this address.
            </div>
          </div>
          <div>
            <div style={{ ...labelStyle, marginBottom: 8 }}>Role</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
            </div>
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
