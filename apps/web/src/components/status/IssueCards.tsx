"use client";

/**
 * The Issues tab: one written issue per affected chain, in severity sections.
 *
 * This REPLACES the metric rows. A row saying "38.9% errors · line 5% · was
 * 0.13% this time last week" is the measurement, and the measurement is not
 * the thing the reader wants — they want the gist: what is happening, simply
 * put, and why. The numbers are still there, on the finding rows the issue
 * cites, one disclosure away.
 *
 * Short numbered facts and a bottom line, copied from how this team already
 * writes these in Slack. The points walk the chain — what is failing, why,
 * what the router did, and why the failover did or did not save it — but they
 * are ONE fact per line, not four labelled paragraphs. The paragraph version
 * read as an essay, which is the thing a bottom line exists to avoid.
 *
 * Severity sections are fixed (Critical · Degraded · Config) because that is
 * the page's own vocabulary. The toggle is a secondary ORDER — by chain, or by
 * time, which answers "what just started" rather than "what is worst".
 *
 * There is no analyse button. The api computes these on a loop and the page
 * reads the warm cache, because the page already knows which chains have
 * issues the moment it loads — a button would only ask the reader to start
 * the wait themselves.
 */
import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";

interface Issue {
  severity: "critical" | "degraded" | "config";
  spec: string;
  chain: string;
  title: string;
  points: string[];
  bottomLine: string;
  findingIds: string[];
  /** Newest activity across the findings behind it. Drives the by-time order. */
  lastSeenUnix?: number | null;
}

interface Answer {
  ok: true;
  issues: Issue[];
  logsAvailable: boolean;
  configAvailable: boolean;
}
interface Refusal {
  ok: false;
  reason: string;
  detail?: string;
}

const SECTIONS = [
  { key: "critical", label: "Critical", color: "var(--err, #ef4444)" },
  { key: "degraded", label: "Degraded", color: "var(--warn, #f59e0b)" },
  { key: "config", label: "Config & callers", color: "var(--text-3, #64748b)" },
] as const;

function ago(unix?: number | null): string | null {
  if (!unix) return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function refusalText(r: Refusal): string {
  if (r.reason === "disabled") return "AI is not enabled on this deployment.";
  if (r.reason === "auth_required") return "AI needs sign-in on this deployment.";
  return `Could not reach the model. ${r.detail ?? ""}`.trim();
}

function Card({ issue, color }: { issue: Issue; color: string }) {
  const when = ago(issue.lastSeenUnix);
  return (
    <div style={{ borderLeft: `3px solid ${color}`, padding: "10px 0 12px 12px", marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{issue.chain}</span>
        <span style={{ fontSize: 9.5, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{issue.spec}</span>
        <span style={{ flex: 1 }} />
        {when && <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>{when}</span>}
      </div>

      <div style={{ fontSize: 12.5, fontWeight: 600, margin: "3px 0 7px" }}>{issue.title}</div>

      {/* One fact per line, numbered. The shape this team already writes in. */}
      <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
        {issue.points.map((p, i) => (
          <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--text-2)" }}>
            {p}
          </li>
        ))}
      </ol>

      {issue.bottomLine && (
        <div style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 7, color: "var(--text)" }}>
          <span style={{ fontWeight: 700 }}>Bottom line: </span>
          {issue.bottomLine}
        </div>
      )}
    </div>
  );
}

export function IssueCards({ chainsAffected }: { chainsAffected: string[] }) {
  const { timeWindow, scopeQ } = useFilters();
  const [order, setOrder] = useState<"chain" | "time">("chain");

  // Polled, not pressed. `warming` comes back while a window is still being
  // computed, so the poll keeps asking until it lands.
  const { data } = useApi<Answer | Refusal>(`/api/ai/issues?window=${timeWindow}${scopeQ}`);
  const issues = data?.ok ? data.issues : null;
  const refusal = data && !data.ok ? data : null;
  const warming = refusal?.reason === "warming";

  const sorted = (list: Issue[]): Issue[] =>
    order === "time"
      ? [...list].sort((a, b) => (b.lastSeenUnix ?? 0) - (a.lastSeenUnix ?? 0))
      : [...list].sort((a, b) => a.chain.localeCompare(b.chain));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {(["chain", "time"] as const).map((k) => (
          <button
            key={k}
            onClick={() => setOrder(k)}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 4,
              cursor: "pointer",
              background: order === k ? "var(--brand)" : "transparent",
              color: order === k ? "#fff" : "var(--text-3)",
              border: `1px solid ${order === k ? "var(--brand)" : "var(--border, #333)"}`,
            }}
          >
            By {k}
          </button>
        ))}
      </div>

      {/* Naming the chains it is working through is the difference between
          "loading" and "stuck" — and it is a wait nobody asked for, so it
          should at least say what it is doing. */}
      {warming && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          Reading errors and config for {chainsAffected.length}{" "}
          {chainsAffected.length === 1 ? "chain" : "chains"}
          {chainsAffected.length ? ` — ${chainsAffected.slice(0, 4).join(", ")}` : ""}
          {chainsAffected.length > 4 ? "…" : ""}
        </div>
      )}

      {refusal && !warming && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>{refusalText(refusal)}</div>
      )}

      {issues && issues.length === 0 && (
        // Not "all clear" — the page never says that. No rule crossed.
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          No chain crossed a rule in this window.
        </div>
      )}

      {issues &&
        SECTIONS.map(({ key, label, color }) => {
          const rows = sorted(issues.filter((i) => i.severity === key));
          // An empty section is wallpaper — the page's own rule.
          if (rows.length === 0) return null;
          return (
            <section key={key} className="gw-card">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 8,
                  paddingBottom: 6,
                  borderBottom: "1px solid var(--border, #222)",
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 99, background: color }} />
                <span style={{ fontSize: 12, fontWeight: 700 }}>{label}</span>
                <span style={{ fontSize: 11, color: "var(--text-4)" }}>{rows.length}</span>
              </div>
              {rows.map((i) => (
                <Card key={i.spec} issue={i} color={color} />
              ))}
            </section>
          );
        })}
    </div>
  );
}
