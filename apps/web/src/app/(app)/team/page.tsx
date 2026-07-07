"use client";

/* Port of SR_Dashboard/magma/page-team.jsx — Team page chrome (tabs:
 * members / invites / audit). Inline styles are verbatim from the
 * prototype. Self-hosted reality: this deployment uses a single shared
 * login with no user store — the members table shows one honest row, the
 * invites and audit tabs render honest empty states, and the invite flow
 * is visible but disabled (team accounts are a Magma Cloud feature).
 * Never fabricates members or events. */

import { useState } from "react";
import { InitialsAvatar, RoleBadge } from "@/components/team/bits";
import { InviteModal } from "@/components/team/InviteModal";

const TABS = ["members", "invites", "audit"] as const;
type Tab = (typeof TABS)[number];

export default function TeamPage() {
  const [showInvite, setShowInvite] = useState(false);
  const [tab, setTab] = useState<Tab>("members");

  return (
    <div className="gw-page">
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <h1>Team</h1>
          <p className="lede">Manage org members, roles, and pending invitations.</p>
        </div>
        <button className="gw-btn gw-btn--primary" onClick={() => setShowInvite(true)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
          Invite
        </button>
      </div>

      {/* Tab bar */}
      <div className="gw-row" style={{ gap: 0, borderBottom: "1px solid var(--line)", marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "8px 16px", fontSize: 13, fontWeight: tab === t ? 600 : 400,
            border: "none", background: "transparent", cursor: "pointer",
            color: tab === t ? "var(--text)" : "var(--text-3)",
            borderBottom: `2px solid ${tab === t ? "var(--brand)" : "transparent"}`,
            marginBottom: -1, fontFamily: "var(--font-ui)", textTransform: "capitalize",
          }}>
            {t}
          </button>
        ))}
      </div>

      {/* Members tab — single honest row: the deployment's shared login */}
      {tab === "members" && (
        <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
          <table className="gw-table">
            <thead>
              <tr><th>Member</th><th>Role</th><th style={{ textAlign: "right" }}>Last active</th><th style={{ textAlign: "right" }}>Joined</th><th></th></tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <InitialsAvatar name="Self-hosted" size={30} />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>Self-hosted deployment</div>
                      <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 1 }}>—</div>
                    </div>
                  </div>
                </td>
                <td><RoleBadge role="owner" /></td>
                <td style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>—</span>
                </td>
                <td style={{ textAlign: "right" }}>
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>—</span>
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Invites tab — no invite store on self-hosted: design empty state */}
      {tab === "invites" && (
        <div className="gw-empty" style={{ minHeight: "30vh" }}>
          <div className="gw-empty__icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          </div>
          <h2>No pending invitations</h2>
          <p>Invite teammates to join your org.</p>
          <button className="gw-btn gw-btn--primary" onClick={() => setShowInvite(true)}>Invite teammate</button>
        </div>
      )}

      {/* Audit tab — no team audit trail on self-hosted */}
      {tab === "audit" && (
        <div className="gw-empty" style={{ minHeight: "30vh" }}>
          <div className="gw-empty__icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          </div>
          <h2>No audit events</h2>
          <p>Team accounts are a Magma Cloud feature.</p>
        </div>
      )}

      <InviteModal open={showInvite} onClose={() => setShowInvite(false)} />
    </div>
  );
}
