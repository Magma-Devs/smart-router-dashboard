"use client";

import { useState } from "react";
import { Modal } from "@/components/gateway/Modal";
import { apiSend } from "@/lib/api-client";
import type { MemberSummary } from "./ChangeRoleModal";

interface ResetLinkResponse {
  url: string;
  expiresAt: string;
}

/**
 * An admin generating a password-reset link for somebody else.
 *
 * **An admin never sets another person's password.** The ticket is explicit
 * ("nobody sets somebody else's password, ever"), so this hands over a link and
 * the holder chooses the value — there is deliberately no password field here,
 * and the api has no endpoint that would accept one.
 *
 * The link is shown once and copied by hand. On-prem that is the design; in
 * managed it is also what happens for now, because no mail transport exists
 * yet — so the copy says "nothing is emailed" rather than "this deployment has
 * no mail server", which stays true either way.
 *
 * It sits behind a confirmation rather than firing on click because generating
 * one is the first half of an account takeover if the wrong person asked for
 * it. That is also why the api records it with the admin's address and device
 * attached, and why there is no password field here or endpoint that accepts
 * one.
 */
export function ResetLinkModal({
  open,
  onClose,
  member,
}: {
  open: boolean;
  onClose: () => void;
  member: MemberSummary | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ResetLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setBusy(false);
    setError(null);
    setResult(null);
    setCopied(false);
  }

  function close() {
    reset();
    onClose();
  }

  async function generate() {
    if (!member) return;
    setBusy(true);
    setError(null);
    try {
      setResult(
        await apiSend<ResetLinkResponse>("POST", `/api/team/members/${member.id}/reset-link`),
      );
    } catch (e) {
      // The api's own message is better than anything generic: it names the
      // account when there is no password to reset, rather than failing blankly.
      setError(e instanceof Error ? e.message : "Could not generate a reset link.");
    } finally {
      setBusy(false);
    }
  }

  const who = member?.name || member?.email || "";

  return (
    <Modal
      open={open}
      onClose={close}
      title={result ? "Reset link created" : "Generate a reset link"}
      footer={
        result ? (
          <button className="gw-btn gw-btn--primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button className="gw-btn" onClick={close}>
              Cancel
            </button>
            <button
              className="gw-btn gw-btn--primary"
              disabled={busy || !member}
              onClick={() => void generate()}
            >
              {busy ? "Generating…" : "Generate link"}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Give this to <strong>{who}</strong>. It works once, expires{" "}
            {relativeExpiry(result.expiresAt)}, and{" "}
            <strong>you will not be able to see it again</strong>.
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
              void navigator.clipboard.writeText(result.url);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.6 }}>
            Opening it signs nobody in. They choose a new password, and every session that account
            had ends.
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12, fontSize: 13, lineHeight: 1.6 }}>
          <div>
            <strong>{who}</strong>
            {member?.name ? (
              <span style={{ color: "var(--text-3)" }}> ({member.email})</span>
            ) : null}{" "}
            will be able to set a new password using a single-use link.
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)", fontSize: 12.5 }}>
            <li>You never see or choose their password — only they do.</li>
            <li>Nothing is emailed — you hand the link over yourself.</li>
            <li>It is shown once, and cannot be read back afterwards.</li>
            <li>Using it ends every session that account currently has.</li>
          </ul>
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

/** "in 24 hours" / "in 2 hours" — the TTL differs by deployment mode, so it is
 *  read off the response rather than hardcoded to on-prem's 24. */
function relativeExpiry(iso: string): string {
  const hours = Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000);
  if (hours < 1) return "within the hour";
  if (hours === 1) return "in an hour";
  return `in ${hours} hours`;
}
