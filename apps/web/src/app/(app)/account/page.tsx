"use client";

/* Port of SR_Dashboard/magma/pages.jsx AccountPage — Basic details,
 * Connected accounts, Change password, Active sessions, Sign out from all
 * devices, Delete account. Inline styles are verbatim from the prototype.
 * Self-hosted reality: this deployment uses a single shared login with no
 * user store — Basic details carries the REAL build provenance from the
 * api's /version endpoint, and the credential/session sections render the
 * design chrome with disabled controls and honest copy. The theme toggle
 * lives in the Topbar — not duplicated here. */

import type { CSSProperties } from "react";
import { useApi } from "@/hooks/use-api";
import { CloudNotice } from "@/components/gateway/CloudNotice";

interface VersionInfo {
  commit: string;
  version: string;
  env: string;
  startedAt: string;
  uptimeSec: number;
}

const NOT_AVAILABLE = "Not available on self-hosted deployments";

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

export default function AccountPage() {
  // REAL build provenance — same `${NEXT_PUBLIC_API_URL}/version` fetch as
  // before, via the shared api client (runtime-config base resolution).
  const { data: version } = useApi<VersionInfo>("/version", 60000);

  const providers = [
    { id: "google", label: "Google" },
    { id: "github", label: "GitHub" },
    { id: "discord", label: "Discord" },
  ];
  const fl: CSSProperties = { fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600, marginBottom: 8 };

  const build = [
    { label: "Version", value: version?.version ?? "—" },
    { label: "Commit", value: version?.commit ?? "—" },
    { label: "Environment", value: version?.env ?? "—" },
    { label: "Started", value: version ? new Date(version.startedAt).toLocaleString() : "—" },
    { label: "Uptime", value: version ? fmtUptime(version.uptimeSec) : "—" },
  ];

  return (
    <div className="gw-page" style={{ maxWidth: 720 }}>
      <h1>Account Settings</h1>
      <p className="lede">Manage your credentials and session settings.</p>

      <div className="gw-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Basic details</div>
        {build.map((f, i) => (
          <div key={f.label} style={{ marginBottom: i === build.length - 1 ? 0 : 12 }}>
            <div style={fl}>{f.label}</div>
            <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.value}</div>
          </div>
        ))}
      </div>

      <div className="gw-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Connected accounts</div>
        <div style={{ marginBottom: 12 }}><CloudNotice feature="OAuth sign-in" detail="this deployment uses a single shared login, so there are no per-user connected accounts." compact /></div>
        <div style={{ display: "grid", gap: 7 }}>
          {providers.map(p => (
            <div key={p.id} className="gw-row" style={{ padding: "9px 11px", borderRadius: 7, background: "var(--bg)", border: "1px solid var(--line)", gap: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{p.label}</div>
              <button className="gw-btn" style={{ fontSize: 11, padding: "5px 9px" }} disabled title={NOT_AVAILABLE}>Connect</button>
            </div>
          ))}
        </div>
      </div>

      <div className="gw-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Change password</div>
        <div style={{ marginBottom: 12 }}><CloudNotice feature="Password management" detail="this deployment authenticates with a single shared login configured at deploy time." compact /></div>
        <div style={{ display: "grid", gap: 9, maxWidth: 360 }}>
          <input className="gw-input" type="password" placeholder="Current password" disabled />
          <input className="gw-input" type="password" placeholder="New password" disabled />
          <input className="gw-input" type="password" placeholder="Repeat new password" disabled />
          <button className="gw-btn gw-btn--primary" style={{ alignSelf: "flex-start" }} disabled title={NOT_AVAILABLE}>Update password</button>
        </div>
      </div>

      <div className="gw-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Active sessions</div>
        <CloudNotice feature="Session tracking" detail="this dashboard uses a single shared login, so there are no per-user sessions to list." compact />
      </div>

      <div className="gw-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12 }}>Sign out from all devices</div>
        <div style={{ marginBottom: 12 }}><CloudNotice feature="Per-device sessions" detail="there are no per-user sessions to invalidate on this deployment." compact /></div>
        <button className="gw-btn" disabled title={NOT_AVAILABLE}>Sign out everywhere</button>
      </div>

      <div className="gw-card" style={{ borderColor: "rgba(239,68,68,0.3)" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--err)", marginBottom: 12 }}>Delete account</div>
        <div style={{ marginBottom: 12 }}><CloudNotice feature="Account deletion" detail="this deployment has no per-user account store to delete from." compact /></div>
        <button className="gw-btn gw-btn--danger" disabled title={NOT_AVAILABLE}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>
          Delete account
        </button>
      </div>
    </div>
  );
}
