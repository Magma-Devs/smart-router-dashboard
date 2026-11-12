"use client";

/* Port of SR_Dashboard/magma/pages.jsx AccountPage. Inline styles are verbatim
 * from the prototype.
 *
 * Change password and Active sessions act on the signed-in account. Basic
 * details carries the REAL build provenance from the api's /version endpoint.
 * Connected accounts is a statement, not a control: a provider links itself by
 * verified address at sign-in. The theme toggle lives in the Topbar.
 *
 * With AUTH_MODE=disabled there are no accounts, so only Basic details renders:
 * the other cards post to routes the api never registers in that mode. */

import type { CSSProperties, ReactNode } from "react";
import { useApi } from "@/hooks/use-api";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { TwoFactorCard } from "@/components/account/TwoFactorCard";
import { SessionsCard } from "@/components/account/SessionsCard";
import { useAuthMode } from "@/components/gateway/auth-mode";
import { LocalTime } from "@/components/gateway/LocalTime";

interface VersionInfo {
  commit: string;
  version: string;
  env: string;
  startedAt: string;
  uptimeSec: number;
}

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

  const fl: CSSProperties = { fontSize: 11, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 600, marginBottom: 8 };

  const build: { label: string; value: ReactNode }[] = [
    { label: "Version", value: version?.version ?? "—" },
    { label: "Commit", value: version?.commit ?? "—" },
    { label: "Environment", value: version?.env ?? "—" },
    { label: "Started", value: version ? <LocalTime t={version.startedAt} format="dateTime" /> : "—" },
    { label: "Uptime", value: version ? fmtUptime(version.uptimeSec) : "—" },
  ];

  return (
    <div className="gw-page" style={{ maxWidth: 720 }}>
      <h1 style={{ marginBottom: 20 }}>Account Settings</h1>

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
        {/* No provider list and no Connect buttons. Which providers this
            deployment offers is server-side configuration this page cannot
            see, and linking needs no button: a Google or GitHub sign-in whose
            verified address matches an account links to it (upsertOAuthUser). */}
        <div className="gw-card" style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Connected accounts</div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.65 }}>
            Where this deployment offers Google or GitHub sign-in, signing in with an account whose
            verified address matches this one links it here the first time you use it - on GitHub,
            that has to be your primary address. Nothing on this page disconnects one.
          </div>
        </div>

        <TwoFactorCard />

        <ChangePasswordCard />

        <SessionsCard />
        </>
      )}
    </div>
  );
}
