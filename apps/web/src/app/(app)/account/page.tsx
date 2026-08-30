"use client";

/* Port of SR_Dashboard/magma/pages.jsx AccountPage. Inline styles are verbatim
 * from the prototype.
 *
 * Change password and Active sessions are now real (MAG-2729 slices 4-5) and
 * act on the signed-in account. Basic details carries the REAL build provenance
 * from the api's /version endpoint. Nothing on this page is a disabled control
 * any more: the two that were — connected accounts and self-deletion — were
 * gated by hosting tier in the prototype and are gated by product rule here,
 * which is a different sentence and deserves different words.
 *
 * The prototype's "Connected accounts" card is gone rather than disabled: it
 * offered Google/GitHub/Discord, and social sign-in is deliberately out of
 * scope, so a greyed-out Connect button would promise something nobody intends
 * to build. The theme toggle lives in the Topbar. */

import Link from "next/link";
import type { CSSProperties } from "react";
import { useApi } from "@/hooks/use-api";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { SessionsCard } from "@/components/account/SessionsCard";

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

      {/* Not a CloudNotice, and not a disabled Delete button.
       *
       * Both said this was gated by hosting tier. It isn't: nothing deletes an
       * account in either shape, and nobody removes themselves in either
       * shape. The ticket is explicit on both counts — "removing a person is a
       * state change, not a row deletion" and "nobody can demote or remove
       * themselves" — and the api enforces the second at
       * `services/members.ts` rather than trusting this screen.
       *
       * A greyed-out "Delete account" next to "this is a Magma Cloud feature"
       * promised that paying would unlock it. It wouldn't. So the card states
       * the rule and names who can act instead. */}
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
    </div>
  );
}
