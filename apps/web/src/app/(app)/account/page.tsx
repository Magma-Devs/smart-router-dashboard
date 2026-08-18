"use client";

/* Port of SR_Dashboard/magma/pages.jsx AccountPage. Inline styles are verbatim
 * from the prototype.
 *
 * Change password and Active sessions are now real (MAG-2729 slices 4-5) and
 * act on the signed-in account. Basic details carries the REAL build provenance
 * from the api's /version endpoint. The one disabled control is linking a
 * second provider, which doesn't exist yet and says so. Self-deletion is not a
 * control at all: it is a rule, and the "Leaving?" card states it. The theme
 * toggle lives in the Topbar.
 *
 * With AUTH_MODE=disabled there are no accounts, so only Basic details renders:
 * the other cards post to routes the api never registers in that mode. */

import type { CSSProperties } from "react";
import Link from "next/link";
import { useApi } from "@/hooks/use-api";
import { Notice } from "@/components/gateway/CloudNotice";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { SessionsCard } from "@/components/account/SessionsCard";
import { useAuthMode } from "@/components/gateway/auth-mode";

interface VersionInfo {
  commit: string;
  version: string;
  env: string;
  startedAt: string;
  uptimeSec: number;
}

const NOT_AVAILABLE = "Not available yet";

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

export default function AccountPage() {
  // The page survives AUTH_MODE=disabled because Basic details is not about an
  // account: it is what an operator reads off a self-hosted deployment.
  const authEnabled = useAuthMode();
  // REAL build provenance — same `${NEXT_PUBLIC_API_URL}/version` fetch as
  // before, via the shared api client (runtime-config base resolution).
  const { data: version } = useApi<VersionInfo>("/version", 60000);

  const providers = [
    { id: "google", label: "Google" },
    { id: "github", label: "GitHub" },
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
      <p className="lede">
        {authEnabled
          ? "Manage your credentials and session settings."
          : "Build and runtime details for this deployment."}
      </p>

      <div className="gw-card" style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Basic details</div>
        {build.map((f, i) => (
          <div key={f.label} style={{ marginBottom: i === build.length - 1 ? 0 : 12 }}>
            <div style={fl}>{f.label}</div>
            <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.value}</div>
          </div>
        ))}
      </div>

      {authEnabled && (
        <>
        <div className="gw-card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Connected accounts</div>
          <div style={{ marginBottom: 12 }}><Notice lead="Linking another provider isn't available yet." detail="You sign in with the method you joined with." compact /></div>
          <div style={{ display: "grid", gap: 7 }}>
            {providers.map(p => (
              <div key={p.id} className="gw-row" style={{ padding: "9px 11px", borderRadius: 7, background: "var(--bg)", border: "1px solid var(--line)", gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{p.label}</div>
                <button className="gw-btn" style={{ fontSize: 11, padding: "5px 9px" }} disabled title={NOT_AVAILABLE}>Connect</button>
              </div>
            ))}
          </div>
        </div>

        <ChangePasswordCard />

        <SessionsCard />

        {/* Not a notice, and not a disabled Delete button. Nothing deletes an
            account on any deployment, and nobody removes themselves — the
            ticket says both, and the api enforces the second in
            services/members.ts rather than trusting this screen. A greyed-out
            button would promise a feature nobody intends to build, so the card
            states the rule and names who can act instead. */}
        <div className="gw-card">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Leaving?</div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.65 }}>
            Accounts here are never deleted, and nobody can remove their own — including
            administrators. Ask another administrator to remove you from{" "}
            <Link href="/team" style={{ color: "var(--brand)" }}>
              Team
            </Link>
            .
            <div style={{ marginTop: 8 }}>
              Removal ends every session you have within one request and frees your address to be
              invited again later. Your name stays in the audit log permanently — that record is the
              point, and deleting the row would erase the trail it exists to keep.
            </div>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
