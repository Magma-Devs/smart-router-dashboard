"use client";

/* Port of SR_Dashboard/magma/pages.jsx AccountPage. Inline styles are verbatim
 * from the prototype.
 *
 * Change password and Active sessions are now real (MAG-2729 slices 4-5) and
 * act on the signed-in account. Basic details carries the REAL build provenance
 * from the api's /version endpoint. Self-service deletion stays disabled and
 * says why, rather than implying a shared login that no longer describes this
 * deployment.
 *
 * The prototype's "Connected accounts" card is gone rather than disabled: it
 * offered Google/GitHub/Discord, and social sign-in is deliberately out of
 * scope, so a greyed-out Connect button would promise something nobody intends
 * to build. The theme toggle lives in the Topbar. */

import type { CSSProperties } from "react";
import { useApi } from "@/hooks/use-api";
import { CloudNotice } from "@/components/gateway/CloudNotice";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { SessionsCard } from "@/components/account/SessionsCard";

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

  const fl: CSSProperties = {
    fontSize: 11,
    color: "var(--text-3)",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    fontWeight: 600,
    marginBottom: 8,
  };

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
            <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
              {f.value}
            </div>
          </div>
        ))}
      </div>

      <ChangePasswordCard />

      <SessionsCard />

      <div className="gw-card" style={{ borderColor: "rgba(239,68,68,0.3)" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--err)", marginBottom: 12 }}>
          Delete account
        </div>
        <div style={{ marginBottom: 12 }}>
          <CloudNotice
            feature="Deleting your own account"
            detail="ask an administrator to remove you. Removal is a state change, not a deletion — your name stays in the audit log, which is what makes the trail readable."
            compact
          />
        </div>
        <button className="gw-btn gw-btn--danger" disabled title={NOT_AVAILABLE}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
          </svg>
          Delete account
        </button>
      </div>
    </div>
  );
}
