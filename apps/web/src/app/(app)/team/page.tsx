"use client";

/**
 * Team — the access-review surface.
 *
 * "Who still has access" is a question nothing else can answer for us: we hold
 * the accounts and don't sync with anyone's identity system, so nothing tells
 * us when somebody leaves the customer's company. This list is the answer, and
 * it exports, because that is the artifact an auditor asks for first.
 */

import { useEffect, useState } from "react";
import { apiDownload, apiSend } from "@/lib/api-client";
import { ROLE_LABELS } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useMe } from "@/hooks/use-me";
import {
  InitialsAvatar,
  InviteStateChip,
  MagmaAccountTag,
  RoleBadge,
} from "@/components/team/bits";
import { LocalTime } from "@/components/gateway/LocalTime";
import { InviteModal } from "@/components/team/InviteModal";
import { ChangeRoleModal, type MemberSummary } from "@/components/team/ChangeRoleModal";
import { RemoveMemberModal } from "@/components/team/RemoveMemberModal";
import { ResetLinkModal } from "@/components/team/ResetLinkModal";
import { ResetTwoFactorModal } from "@/components/team/ResetTwoFactorModal";
import { RevokeInviteModal } from "@/components/team/RevokeInviteModal";
import { RowActions } from "@/components/team/RowActions";
import {
  closedCount,
  inviteActions,
  memberActions,
  memberListUpdates,
  pendingCount,
  twoFactorCell,
  visibleInvites,
  type InvitesResponse,
  type MembersResponse,
} from "@/components/team/team-state";

const TABS = ["members", "invites"] as const;
type Tab = (typeof TABS)[number];

/** How long a confirmation stays up. */
const NOTICE_MS = 10_000;

/** A column header a screen reader reads and the eye does not need. */
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

const who = (m: { name: string | null; email: string }) => m.name || m.email;

export default function TeamPage() {
  const [tab, setTab] = useState<Tab>("members");
  const [showInvite, setShowInvite] = useState(false);
  const [changing, setChanging] = useState<MemberSummary | null>(null);
  const [removing, setRemoving] = useState<MemberSummary | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; email: string } | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [busyInvite, setBusyInvite] = useState<string | null>(null);
  /** The outcome of the last resend: the link itself when the admin has to
   *  carry it, or just the address when it was emailed. */
  const [freshLink, setFreshLink] = useState<{
    id: string;
    email: string;
    url?: string;
    fallback: boolean;
  } | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<MemberSummary | null>(null);
  const [resettingTwoFactor, setResettingTwoFactor] = useState<MemberSummary | null>(null);
  /** What the last action did, said once it is done. Keyed so the same words
   *  twice in a row still restart the timer. */
  const [notice, setNotice] = useState<{ key: number; text: string } | null>(null);

  const members = useApi<MembersResponse>("/api/team/members", 30_000);
  const updateMembers = memberListUpdates(members.mutate);
  // Both from the live row, not the session — see `useMe`.
  const { me, isAdmin, twoFactor } = useMe();
  // The Invites tab is admin-only. Someone demoted while it is open would
  // otherwise be left looking at a tab bar with nothing selected and no panel.
  const shownTab: Tab = isAdmin ? tab : "members";
  // Only admins may read invitations, so don't even ask otherwise — a 403 in
  // the console is noise, not information. Read on open and after each
  // action, never polled.
  const invites = useApi<InvitesResponse>(isAdmin ? "/api/team/invites" : null, 0);
  const allInvites = invites.data?.invites ?? [];
  const pending = pendingCount(allInvites);
  const closed = closedCount(allInvites);
  const listed = visibleInvites(allInvites, showClosed);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const confirm = (text: string) => setNotice({ key: Date.now(), text });

  async function resend(invite: { id: string; email: string }) {
    setBusyInvite(invite.id);
    setInviteError(null);
    setNotice(null);
    // A link belongs to one invitation. Drop the last one before acting, so a
    // failed action can never leave it on screen beside a different row.
    setFreshLink(null);
    try {
      const res = await apiSend<{ url?: string; deliveryFallback?: boolean }>(
        "POST",
        `/api/team/invites/${invite.id}/resend`,
      );
      setFreshLink({
        id: invite.id,
        email: invite.email,
        url: res.url,
        fallback: res.deliveryFallback === true,
      });
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

  return (
    <div className="gw-page">
      <div
        className="gw-row"
        style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}
      >
        <h1 style={{ margin: 0 }}>Team</h1>
        <div className="gw-row" style={{ gap: 8 }}>
          <button className="gw-btn" onClick={() => void exportCsv()}>
            Export CSV
          </button>
          {isAdmin && (
            <button className="gw-btn gw-btn--primary" onClick={() => setShowInvite(true)}>
              Invite
            </button>
          )}
        </div>
      </div>

      {/* A prompt, never a block: admin has to stay transferable, or a
          departing employee's account can't be removed. */}
      {members.data?.soleAdmin && isAdmin && (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            background: "color-mix(in srgb, var(--warn) 6%, transparent)",
            border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)",
            borderRadius: 8,
            padding: "10px 12px",
            marginBottom: 16,
            fontSize: 12.5,
          }}
        >
          <span>
            <strong>You are the only administrator.</strong> If you lose access to this account,
            nobody can manage people. Consider inviting a second admin.
          </span>
        </div>
      )}

      {/* Mounted empty, so a screen reader announces each confirmation. */}
      <div role="status" aria-live="polite">
        {notice && (
          <div
            key={notice.key}
            style={{
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              justifyContent: "space-between",
              background: "color-mix(in srgb, var(--ok) 7%, transparent)",
              border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 16,
              fontSize: 12.5,
            }}
          >
            <span>{notice.text}</span>
            <button
              className="gw-btn gw-btn--ghost"
              style={{ padding: 2, fontSize: 11 }}
              aria-label="Dismiss"
              onClick={() => setNotice(null)}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {exportError && (
        <div role="alert" style={{ fontSize: 12, color: "var(--err)", marginBottom: 12 }}>
          {exportError}
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
              fontWeight: shownTab === t ? 600 : 400,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: shownTab === t ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${shownTab === t ? "var(--brand)" : "transparent"}`,
              marginBottom: -1,
              fontFamily: "var(--font-ui)",
              textTransform: "capitalize",
            }}
          >
            {t}
            {/* Invitations someone can still accept: revoked and expired
                ones are history, not work waiting. */}
            {t === "invites" && pending > 0 ? ` (${pending})` : ""}
          </button>
        ))}
      </div>

      {shownTab === "members" && (
        <div className="gw-card" style={{ padding: 0, overflowX: "auto" }}>
          {/* An access review that silently shows nobody is worse than one that
              says it couldn't load. */}
          {members.error && (
            <div
              role="alert"
              style={{
                padding: "12px 14px",
                fontSize: 12,
                color: "var(--err)",
                borderBottom: "1px solid var(--line)",
              }}
            >
              Could not load the member list:{" "}
              {members.error instanceof Error ? members.error.message : "request failed"}
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
                <th>
                  <span style={VISUALLY_HIDDEN}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {members.data?.members.map((m) => {
                // The store carries the signed-in address, not an id.
                const self = !!me?.email && m.email === me.email;
                const tfa = twoFactorCell(
                  m.twoFactorEnabled,
                  self ? (twoFactor?.daysLeft ?? null) : null,
                );
                return (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <InitialsAvatar name={m.name || m.email} size={30} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>
                            {m.name || m.email}
                            {self && (
                              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>
                                {" "}
                                · you
                              </span>
                            )}
                            {m.isMagmaAccount && <MagmaAccountTag />}
                          </div>
                          <div
                            style={{
                              fontSize: 11,
                              color: "var(--text-3)",
                              marginTop: 1,
                              overflowWrap: "anywhere",
                            }}
                          >
                            {m.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <RoleBadge role={m.role} />
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {/* "Not set up" is someone the dashboard is shut to until
                          they set up an authenticator (they joined and have
                          not, or an admin reset theirs), or the first admin
                          inside their grace period. Amber, not red: it asks
                          for attention, it is not an error. */}
                      <span
                        title={tfa.tip ?? undefined}
                        style={{
                          fontSize: 12,
                          color: tfa.tone === "plain" ? "var(--text-3)" : "var(--warn)",
                          fontWeight: tfa.tone === "plain" ? 400 : 600,
                          cursor: tfa.tip ? "help" : undefined,
                        }}
                      >
                        {tfa.label}
                      </span>
                    </td>
                    <td
                      style={{
                        textAlign: "right",
                        fontSize: 12,
                        color: "var(--text-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {/* Relative: the question is "is this person still around",
                          and nobody reads a timestamp to answer it. The tooltip
                          has the timestamp. */}
                      {m.lastActiveAt ? (
                        <LocalTime t={m.lastActiveAt} format="relative" />
                      ) : (
                        "Never"
                      )}
                    </td>
                    <td
                      style={{
                        textAlign: "right",
                        fontSize: 12,
                        color: "var(--text-3)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      <LocalTime t={m.joinedAt} format="date" />
                    </td>
                    <td style={{ textAlign: "right", width: 1 }}>
                      {isAdmin && !self && (
                        <RowActions
                          label={`Actions for ${who(m)}`}
                          actions={memberActions(m, {
                            changeRole: () => setChanging(m),
                            resetLink: () => setResetting(m),
                            resetTwoFactor: () => setResettingTwoFactor(m),
                            remove: () => setRemoving(m),
                          })}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {shownTab === "invites" && inviteError && (
        <div role="alert" style={{ fontSize: 12, color: "var(--err)", marginBottom: 12 }}>
          {inviteError}
        </div>
      )}

      {shownTab === "invites" &&
        (invites.error ? (
          <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
            Could not load invitations:{" "}
            {invites.error instanceof Error ? invites.error.message : "request failed"}
          </div>
        ) : !invites.data ? null : (
          <>
            {closed > 0 && (
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  color: "var(--text-2)",
                  marginBottom: 12,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(e) => setShowClosed(e.target.checked)}
                />
                Show revoked and expired ({closed})
              </label>
            )}
            {listed.length ? (
              <div className="gw-card" style={{ padding: 0, overflowX: "auto" }}>
                <table className="gw-table">
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Role</th>
                      <th>State</th>
                      <th style={{ textAlign: "right" }}>Sent</th>
                      <th style={{ textAlign: "right" }}>Expires</th>
                      <th>
                        <span style={VISUALLY_HIDDEN}>Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((i) => (
                      <tr key={i.id}>
                        <td style={{ fontSize: 13, overflowWrap: "anywhere" }}>{i.email}</td>
                        <td>
                          <RoleBadge role={i.role} />
                        </td>
                        <td>
                          <InviteStateChip state={i.state} />
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            fontSize: 12,
                            color: "var(--text-3)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <LocalTime t={i.createdAt} format="date" />
                        </td>
                        <td
                          style={{
                            textAlign: "right",
                            fontSize: 12,
                            color: "var(--text-3)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <LocalTime t={i.expiresAt} format="date" />
                        </td>
                        <td style={{ textAlign: "right", width: 1 }}>
                          {/* The button stays while a resend runs, so focus has
                              somewhere to be; its actions wait for the answer. */}
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {busyInvite === i.id && (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-3)",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                Resending…
                              </span>
                            )}
                            <RowActions
                              label={`Actions for the invitation to ${i.email}`}
                              actions={inviteActions(i, {
                                resend: () => void resend(i),
                                revoke: () => {
                                  setInviteError(null);
                                  setFreshLink(null);
                                  setRevoking(i);
                                },
                              }).map((a) => (busyInvite === i.id ? { ...a, disabled: true } : a))}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {freshLink && (
                  <div
                    style={{
                      padding: "12px 14px",
                      borderTop: "1px solid var(--line)",
                      fontSize: 12,
                    }}
                  >
                    {freshLink.url ? (
                      <>
                        <div style={{ marginBottom: 6, color: "var(--text-2)" }}>
                          {freshLink.fallback && (
                            <>
                              <strong>The email could not be sent</strong> - tell an operator that
                              mail is not working.{" "}
                            </>
                          )}
                          New link for <strong>{freshLink.email}</strong> - the previous one no
                          longer works. Shown once.
                        </div>
                        <div
                          className="gw-mono"
                          style={{ fontSize: 11, wordBreak: "break-all", userSelect: "all" }}
                        >
                          {freshLink.url}
                        </div>
                      </>
                    ) : (
                      <div style={{ color: "var(--text-2)" }}>
                        Emailed a new link to <strong>{freshLink.email}</strong> - the previous one
                        no longer works.
                      </div>
                    )}
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
            )}
          </>
        ))}

      <InviteModal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        onInvited={() => {
          setInviteError(null);
          void invites.mutate();
          // Show the tab the new invitation is on. Without this the admin is
          // left looking at Members, where the person they just invited
          // correctly isn't, and nothing indicates where they went.
          setTab("invites");
        }}
      />
      <ChangeRoleModal
        key={`role-${changing?.id ?? "none"}`}
        open={!!changing}
        member={changing}
        onClose={() => setChanging(null)}
        onChanged={(role) => {
          if (!changing) return;
          updateMembers.roleChanged(changing.id, role);
          confirm(`${who(changing)} is now ${ROLE_LABELS[role]}.`);
        }}
      />
      <ResetLinkModal
        key={`reset-${resetting?.id ?? "none"}`}
        open={!!resetting}
        onClose={() => setResetting(null)}
        member={resetting}
      />
      <ResetTwoFactorModal
        key={`reset-2fa-${resettingTwoFactor?.id ?? "none"}`}
        open={!!resettingTwoFactor}
        onClose={() => setResettingTwoFactor(null)}
        member={resettingTwoFactor}
        onReset={(emailed) => {
          if (!resettingTwoFactor) return;
          updateMembers.twoFactorReset(resettingTwoFactor.id);
          confirm(
            `2FA reset for ${who(resettingTwoFactor)}. They are signed out everywhere and set it up again at their next sign-in.` +
              (emailed ? " We emailed them to say so." : ""),
          );
        }}
      />
      <RemoveMemberModal
        key={`remove-${removing?.id ?? "none"}`}
        open={!!removing}
        member={removing}
        onClose={() => setRemoving(null)}
        onRemoved={() => {
          if (!removing) return;
          updateMembers.removed(removing.id);
          confirm(`Removed ${who(removing)}. They are signed out everywhere.`);
        }}
      />
      <RevokeInviteModal
        key={`revoke-${revoking?.id ?? "none"}`}
        open={!!revoking}
        invite={revoking}
        onClose={() => setRevoking(null)}
        onRevoked={() => {
          if (!revoking) return;
          void invites.mutate();
          confirm(`Revoked the invitation for ${revoking.email}.`);
        }}
        onGone={() => void invites.mutate()}
      />
    </div>
  );
}
