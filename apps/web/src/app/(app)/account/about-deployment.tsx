"use client";

import type { ReactNode } from "react";
import { LocalTime } from "@/components/gateway/LocalTime";
import { Skel } from "@/components/gateway/Skel";
import { useApi } from "@/hooks/use-api";

/** The api's `/version`. */
export interface VersionInfo {
  commit: string;
  version: string;
  /** The api's NODE_ENV. Every published image sets `production`. */
  env: string;
  startedAt: string;
  uptimeSec: number;
}

/** A commit as a build records it. The api answers "unknown" when the image
 *  was built without GIT_COMMIT, and a build outside git records "dev". */
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** The api's version when APP_VERSION was not set at build time. */
const NO_VERSION = "0.0.0";

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec % 60}s`;
}

/**
 * The facts worth a row. A value the build did not record has no row, rather
 * than a placeholder that reads like an answer. The runtime mode is shown only
 * when it is not `production`: every published image runs as production, so
 * there it says nothing about which deployment this is.
 */
export function deploymentFacts(v: VersionInfo): { label: string; value: ReactNode }[] {
  const facts: { label: string; value: ReactNode }[] = [];
  if (v.version && v.version !== NO_VERSION) facts.push({ label: "Version", value: v.version });
  if (COMMIT.test(v.commit)) facts.push({ label: "Commit", value: v.commit.slice(0, 12) });
  if (v.env && v.env !== "production") facts.push({ label: "Runtime mode", value: v.env });
  facts.push({ label: "Started", value: <LocalTime t={v.startedAt} format="dateTime" /> });
  facts.push({ label: "Uptime", value: fmtUptime(v.uptimeSec) });
  return facts;
}

/** What an operator reads off a deployment: its build and how long it has run. */
export function AboutDeployment({
  version,
  error,
}: {
  version: VersionInfo | undefined;
  error: boolean;
}) {
  return (
    <section className="gw-card" style={{ marginBottom: 14 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 12px" }}>About this deployment</h2>
      {version ? (
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr",
            gap: "8px 12px",
            margin: 0,
            fontSize: 12.5,
          }}
        >
          {deploymentFacts(version).map((f) => (
            <div key={f.label} style={{ display: "contents" }}>
              <dt style={{ color: "var(--text-3)" }}>{f.label}</dt>
              <dd className="gw-mono" style={{ margin: 0, color: "var(--text-2)" }}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : error ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-3)" }}>
          Could not read this deployment&rsquo;s version. Reload to try again.
        </p>
      ) : (
        <div aria-busy="true" style={{ display: "grid", gap: 10 }}>
          <Skel w={180} />
          <Skel w={220} />
          <Skel w={140} />
        </div>
      )}
      <UsageNote />
    </section>
  );
}

/**
 * Said only where this deployment sends usage data (MAG-5373): what goes,
 * what never does. Nothing at all where it is off.
 */
function UsageNote() {
  const { data } = useApi<{ enabled: boolean }>("/api/usage/config", 0);
  if (!data?.enabled) return null;
  return (
    <p style={{ margin: "14px 0 0", fontSize: 12, color: "var(--text-3)", lineHeight: 1.5 }}>
      This dashboard sends anonymous usage data to Magma: pages opened, searches and clicks. Never names, emails,
      request IDs, hashes or anything typed.
    </p>
  );
}
