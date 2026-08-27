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
import { ApiError, apiGet, apiDownload, apiSend } from "@/lib/api-client";
import { type Role } from "@sr/shared";
import { InitialsAvatar, RoleBadge, relativeTime, shortDate } from "@/components/team/bits";
import { InviteModal } from "@/components/team/InviteModal";
import { ChangeRoleModal, type MemberSummary } from "@/components/team/ChangeRoleModal";
import { RemoveMemberModal } from "@/components/team/RemoveMemberModal";
import { ResetLinkModal } from "@/components/team/ResetLinkModal";
import { useMe } from "@/hooks/use-me";

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
  const [resetting, setResetting] = useState<MemberSummary | null>(null);
  const [freshLink, setFreshLink] = useState<{ id: string; url: string } | null>(null);

  const members = useSWR<MembersResponse>("/api/team/members", apiGet, { refreshInterval: 30000 });
  // Only admins may read invitations, so don't even ask otherwise — a 403 in
  // the console is noise, not information.
  // Both from the live row, not the session — see `useMe`.
  const { me, isAdmin } = useMe();
  const invites = useSWR<InvitesResponse>(isAdmin ? "/api/team/invites" : null, apiGet);

  // SWR reports the thrown ApiError; 401 is the one worth wording differently,
  // because "sign in again" is actionable and "request failed" is not.
  const membersError = members.error as ApiError | undefined;
  const sessionExpired = membersError?.statusCode === 401;

  async function inviteAction(id: string, action: "resend" | "revoke") {
    setBusyInvite(id);
    try {
      if (action === "resend") {
        const res = await apiSend<{ url?: string }>("POST", `/api/team/invites/${id}/resend`);
        if (res?.url) setFreshLink({ id, url: res.url });
      } else {
        await apiSend("DELETE", `/api/team/invites/${id}`);
      }
      await invites.mutate();
    } finally {
      setBusyInvite(null);
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
            onClick={() => void apiDownload("/api/team/members.csv", "members.csv")}
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
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            background: "rgba(255,57,0,0.05)",
            border: "1px solid rgba(255,57,0,0.25)",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 16,
            fontSize: 12.5,
          }}
        >
          <span>
            <strong>You are the only administrator.</strong> If you lose access to this account,
            nobody can manage people or approve changes. Consider inviting a second admin.
          </span>
        </div>
      )}

      <div
        className="gw-row"
        style={{ gap: 0, borderBottom: "1px solid var(--line)", marginBottom: 20 }}
      >
        {TABS.filter((t) => t === "members" || isAdmin).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: tab === t ? 600 : 400,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: tab === t ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${tab === t ? "var(--brand)" : "transparent"}`,
              marginBottom: -1,
              fontFamily: "var(--font-ui)",
              textTransform: "capitalize",
            }}
          >
            {t}
            {t === "invites" && invites.data?.invites.length
              ? ` (${invites.data.invites.length})`
              : ""}
          </button>
        ))}
      </div>

      {/* A failed read must not look like an empty team.
       *
       * This table used to render its headers and nothing else whenever the
       * fetch failed, which is indistinguishable from "you are the only
       * member" — and on the one page whose whole job is answering "who still
       * has access", the wrong answer is the dangerous one. A 401 here means
       * the session is no longer usable, which the shell can't show because it
       * reads the signed-in user from a store filled at page load. */}
      {tab === "members" && membersError && (
        <div className="gw-card" style={{ padding: "18px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {sessionExpired ? "Your session is no longer valid" : "Could not load the member list"}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.6 }}>
            {sessionExpired ? (
              <>
                Sign out and sign in again — the api refused this session. Nothing about the team
                has changed; this page simply cannot read it.
              </>
            ) : (
              membersError.message
            )}
          </div>
        </div>
      )}

      {tab === "members" && !membersError && (
        <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
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
                            {self && (
                              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                                {" "}
                                · you
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>
                            {m.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <RoleBadge role={m.role} />
                    </td>
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
                            onClick={() => setResetting(m)}
                            title="Generate a single-use password-reset link to hand over"
                          >
                            Reset link
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
        </div>
      )}

      {tab === "invites" &&
        isAdmin &&
        (invites.data?.invites.length ? (
          <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
            <table className="gw-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>State</th>
                  <th style={{ textAlign: "right" }}>Sent</th>
                  <th style={{ textAlign: "right" }}>Expires</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invites.data.invites.map((i) => (
                  <tr key={i.id}>
                    <td style={{ fontSize: 13 }}>{i.email}</td>
                    <td>
                      <RoleBadge role={i.role} />
                    </td>
                    <td>
                      <span className={"gw-tag" + (i.state === "pending" ? " gw-tag--info" : "")}>
                        {i.state}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>
                      {shortDate(i.createdAt)}
                    </td>
                    <td style={{ textAlign: "right", fontSize: 12, color: "var(--text-3)" }}>
                      {shortDate(i.expiresAt)}
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {i.state !== "revoked" && (
                        <>
                          <button
                            className="gw-btn"
                            style={{ fontSize: 11, padding: "4px 8px", marginRight: 6 }}
                            disabled={busyInvite === i.id}
                            onClick={() => void inviteAction(i.id, "resend")}
                          >
                            New link
                          </button>
                          <button
                            className="gw-btn gw-btn--danger"
                            style={{ fontSize: 11, padding: "4px 8px" }}
                            disabled={busyInvite === i.id}
                            onClick={() => void inviteAction(i.id, "revoke")}
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
              <div
                style={{ padding: "12px 14px", borderTop: "1px solid var(--line)", fontSize: 12 }}
              >
                <div style={{ marginBottom: 6, color: "var(--text-2)" }}>
                  New link — the previous one no longer works. Shown once.
                </div>
                <div
                  className="gw-mono"
                  style={{ fontSize: 11, wordBreak: "break-all", userSelect: "all" }}
                >
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
        ))}

      <InviteModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        onInvited={() => {
          void invites.mutate();
          // Show the tab the new invitation is on. Without this the admin is
          // left looking at Members, where the person they just invited
          // correctly isn't, and nothing indicates where they went.
          setTab("invites");
        }}
      />
      <ChangeRoleModal
        open={!!changing}
        member={changing}
        onClose={() => setChanging(null)}
        onChanged={() => void members.mutate()}
      />
      <ResetLinkModal open={!!resetting} onClose={() => setResetting(null)} member={resetting} />

      <RemoveMemberModal
        open={!!removing}
        member={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => void members.mutate()}
      />
    </div>
  );
}
