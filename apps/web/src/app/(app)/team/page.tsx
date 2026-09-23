"use client";

/**
 * Team — the access-review surface.
 *
 * "Who still has access" is a question nothing else can answer for us: we hold
 * the accounts and don't sync with anyone's identity system, so nothing tells
 * us when somebody leaves the customer's company. This list is the answer, and
 * it exports, because that is the artifact an auditor asks for first.
 */

import { useState } from "react";
import useSWR from "swr";
import { apiGet, apiDownload, apiSend } from "@/lib/api-client";
import { roleAtLeast, type Role } from "@sr/shared";
import { getAuthState } from "@/lib/auth-store";
import { InitialsAvatar, RoleBadge, relativeTime, shortDate } from "@/components/team/bits";
import { InviteModal } from "@/components/team/InviteModal";
import { ChangeRoleModal, type MemberSummary } from "@/components/team/ChangeRoleModal";
import { RemoveMemberModal } from "@/components/team/RemoveMemberModal";

const TABS = ["members", "invites"] as const;
type Tab = (typeof TABS)[number];

interface MembersResponse {
  members: Array<{
    id: string;
    name: string | null;
    email: string;
    role: Role;
    twoFactorEnabled: boolean | null;
    lastActiveAt: string | null;
    joinedAt: string;
  }>;
  adminCount: number;
  soleAdmin: boolean;
}

interface InvitesResponse {
  invites: Array<{
    id: string;
    email: string;
    role: Role;
    createdAt: string;
    expiresAt: string;
    resendCount: number;
    state: "pending" | "expired" | "revoked";
  }>;
}

export default function TeamPage() {
  const [tab, setTab] = useState<Tab>("members");
  const [showInvite, setShowInvite] = useState(false);
  const [changing, setChanging] = useState<MemberSummary | null>(null);
  const [removing, setRemoving] = useState<MemberSummary | null>(null);
  const [busyInvite, setBusyInvite] = useState<string | null>(null);
  const [freshLink, setFreshLink] = useState<{ id: string; email: string; url: string } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [busyReset, setBusyReset] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<
    { email: string; url: string; expiresAt: string } | { email: string; error: string } | null
  >(null);

  const members = useSWR<MembersResponse>("/api/team/members", apiGet, { refreshInterval: 30000 });
  const me = getAuthState().user;
  // My role as the api enforces it: the row, which this list is and which
  // refreshes every 30s. The token's role is the one I signed in with and can be
  // a month stale, so after a role change it would draw controls that 403 and
  // hide ones that work. Until the list arrives, no admin controls.
  const myRole = members.data?.members.find((m) => m.email === me?.email)?.role;
  const isAdmin = roleAtLeast(myRole, "admin");
  // Only admins may read invitations, so don't even ask otherwise — a 403 in
  // the console is noise, not information.
  const invites = useSWR<InvitesResponse>(isAdmin ? "/api/team/invites" : null, apiGet);

  async function inviteAction(invite: { id: string; email: string }, action: "resend" | "revoke") {
    setBusyInvite(invite.id);
    setInviteError(null);
    // A link belongs to one invitation. Drop the last one before acting, so a
    // failed action can never leave it on screen beside a different row.
    setFreshLink(null);
    try {
      if (action === "resend") {
        const res = await apiSend<{ url: string }>("POST", `/api/team/invites/${invite.id}/resend`);
        setFreshLink({ id: invite.id, email: invite.email, url: res.url });
      } else {
        await apiSend("DELETE", `/api/team/invites/${invite.id}`);
      }
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusyInvite(null);
      // Either way: a 410 means this list is stale — the invitation was
      // redeemed or revoked elsewhere — and the row should stop offering it.
      void invites.mutate();
    }
  }

  async function exportCsv() {
    setExportError(null);
    try {
      await apiDownload("/api/team/members.csv", "members.csv");
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "The export failed.");
    }
  }

  // On-prem there is no mail server, so this link is how a member who forgot
  // their password gets back in. The admin hands it over; the holder chooses
  // the password.
  async function resetPassword(m: MemberSummary) {
    setBusyReset(m.id);
    try {
      const res = await apiSend<{ url: string; expiresAt: string }>(
        "POST",
        `/api/team/members/${m.id}/reset-link`,
      );
      setResetLink({ email: m.email, url: res.url, expiresAt: res.expiresAt });
    } catch (e) {
      setResetLink({
        email: m.email,
        error: e instanceof Error ? e.message : "Could not create a reset link.",
      });
    } finally {
      setBusyReset(null);
    }
  }

  return (
    <div className="gw-page">
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <h1>Team</h1>
          <p className="lede">Everyone with access to this dashboard, and what they can do.</p>
        </div>
        <div className="gw-row" style={{ gap: 8 }}>
          <button
            className="gw-btn"
            onClick={() => void exportCsv()}
          >
            Export CSV
          </button>
          {isAdmin && (
            <button className="gw-btn gw-btn--primary" onClick={() => setShowInvite(true)}>
              Invite
            </button>
          )}
        </div>
      </div>

      {/* A prompt, never a block — admin has to stay transferable, or a
          departing employee's account can't be removed. */}
      {members.data?.soleAdmin && isAdmin && (
        <div
          style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            background: "rgba(255,57,0,0.05)", border: "1px solid rgba(255,57,0,0.25)",
            borderRadius: 8, padding: "10px 12px", marginBottom: 16, fontSize: 12.5,
          }}
        >
          <span>
            <strong>You are the only administrator.</strong> If you lose access to this account,
            nobody can manage people or approve changes. Consider inviting a second admin.
          </span>
        </div>
      )}

      {exportError && (
        <div role="alert" style={{ fontSize: 12, color: "var(--err)", marginBottom: 12 }}>{exportError}</div>
      )}

      <div className="gw-row" style={{ gap: 0, borderBottom: "1px solid var(--line)", marginBottom: 20 }}>
        {TABS.filter((t) => t === "members" || isAdmin).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "8px 16px", fontSize: 13, fontWeight: tab === t ? 600 : 400,
            border: "none", background: "transparent", cursor: "pointer",
            color: tab === t ? "var(--text)" : "var(--text-3)",
            borderBottom: `2px solid ${tab === t ? "var(--brand)" : "transparent"}`,
            marginBottom: -1, fontFamily: "var(--font-ui)", textTransform: "capitalize",
          }}>
            {t}
            {t === "invites" && invites.data?.invites.length ? ` (${invites.data.invites.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "members" && (
        <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
          {/* An access review that silently shows nobody is worse than one that
              says it couldn't load. */}
          {members.error && (
            <div role="alert" style={{ padding: "12px 14px", fontSize: 12, color: "var(--err)", borderBottom: "1px solid var(--line)" }}>
              Could not load the member list: {members.error instanceof Error ? members.error.message : "request failed"}
            </div>
          )}
          <table className="gw-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>2FA</th>
                <th style={{ textAlign: "right" }}>Last active</th>
                <th style={{ textAlign: "right" }}>Joined</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {members.data?.members.map((m) => {
                // The store carries the signed-in address, not an id.
                const self = !!me?.email && m.email === me.email;
                return (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <InitialsAvatar name={m.name || m.email} size={30} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>
                            {m.name || m.email}
                            {self && <span style={{ color: "var(--text-3)", fontWeight: 400 }}> · you</span>}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>{m.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><RoleBadge role={m.role} /></td>
                    <td>
                      {/* Not "No" — two-factor doesn't exist yet, and "No" would
                          be true today and wrong the day it ships. */}
                      <span style={{ fontSize: 12, color: "var(--text-3)" }}>
                        {m.twoFactorEnabled === null ? "—" : m.twoFactorEnabled ? "Yes" : "No"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>
                      {relativeTime(m.lastActiveAt)}
                    </td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>
                      {shortDate(m.joinedAt)}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {isAdmin && !self && (
                        <>
                          <button
                            className="gw-btn"
                            style={{ fontSize: 11, padding: "4px 8px", marginRight: 6 }}
                            onClick={() => setChanging(m)}
                          >
                            Change role
                          </button>
                          <button
                            className="gw-btn"
                            style={{ fontSize: 11, padding: "4px 8px", marginRight: 6 }}
                            disabled={busyReset === m.id}
                            onClick={() => void resetPassword(m)}
                          >
                            Reset password
                          </button>
                          <button
                            className="gw-btn gw-btn--danger"
                            style={{ fontSize: 11, padding: "4px 8px" }}
                            onClick={() => setRemoving(m)}
                          >
                            Remove
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {resetLink && (
            <div style={{ padding: "12px 14px", borderTop: "1px solid var(--line)", fontSize: 12 }}>
              {"url" in resetLink ? (
                <>
                  <div style={{ marginBottom: 6, color: "var(--text-2)" }}>
                    Password reset link for <strong>{resetLink.email}</strong>. Hand it to them
                    yourself — it works once, until {new Date(resetLink.expiresAt).toLocaleString()},
                    and is not shown again. Any earlier link for them no longer works.
                  </div>
                  <div className="gw-mono" style={{ fontSize: 11, wordBreak: "break-all", userSelect: "all" }}>
                    {resetLink.url}
                  </div>
                </>
              ) : (
                <div role="alert" style={{ color: "var(--err)" }}>{resetLink.error}</div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "invites" && isAdmin && inviteError && (
        <div role="alert" style={{ fontSize: 12, color: "var(--err)", marginBottom: 12 }}>{inviteError}</div>
      )}

      {tab === "invites" && isAdmin && (
        invites.error ? (
          <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
            Could not load invitations: {invites.error instanceof Error ? invites.error.message : "request failed"}
          </div>
        ) : !invites.data ? null : invites.data.invites.length ? (
          <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
            <table className="gw-table">
              <thead>
                <tr>
                  <th>Email</th><th>Role</th><th>State</th>
                  <th style={{ textAlign: "right" }}>Sent</th>
                  <th style={{ textAlign: "right" }}>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invites.data.invites.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontSize: 13 }}>{i.email}</td>
                    <td><RoleBadge role={i.role} /></td>
                    <td>
                      <span className={"gw-tag" + (i.state === "pending" ? " gw-tag--info" : "")}>
                        {i.state}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>{shortDate(i.createdAt)}</td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>{shortDate(i.expiresAt)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {i.state !== "revoked" && (
                        <>
                          <button
                            className="gw-btn"
                            style={{ fontSize: 11, padding: "4px 8px", marginRight: 6 }}
                            disabled={busyInvite === i.id}
                            onClick={() => void inviteAction(i, "resend")}
                          >
                            New link
                          </button>
                          <button
                            className="gw-btn gw-btn--danger"
                            style={{ fontSize: 11, padding: "4px 8px" }}
                            disabled={busyInvite === i.id}
                            onClick={() => void inviteAction(i, "revoke")}
                          >
                            Revoke
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {freshLink && (
              <div style={{ padding: "12px 14px", borderTop: "1px solid var(--line)", fontSize: 12 }}>
                <div style={{ marginBottom: 6, color: "var(--text-2)" }}>
                  New link for <strong>{freshLink.email}</strong> — the previous one no longer works.
                  Shown once.
                </div>
                <div className="gw-mono" style={{ fontSize: 11, wordBreak: "break-all", userSelect: "all" }}>
                  {freshLink.url}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="gw-empty" style={{ minHeight: "30vh" }}>
            <h2>No pending invitations</h2>
            <p>Invite a teammate to give them access.</p>
            <button className="gw-btn gw-btn--primary" onClick={() => setShowInvite(true)}>
              Invite teammate
            </button>
          </div>
        )
      )}

      <InviteModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        onInvited={() => void invites.mutate()}
      />
      <ChangeRoleModal
        key={`role-${changing?.id ?? "none"}`}
        open={!!changing}
        member={changing}
        onClose={() => setChanging(null)}
        onChanged={() => void members.mutate()}
      />
      <RemoveMemberModal
        key={`remove-${removing?.id ?? "none"}`}
        open={!!removing}
        member={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          // A reset link for someone who no longer has an account is dead.
          if (resetLink?.email === removing?.email) setResetLink(null);
          void members.mutate();
        }}
      />
    </div>
  );
}
