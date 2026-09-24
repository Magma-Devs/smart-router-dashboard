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
 * Four lines, in the order people actually ask:
 *
 *   What's happening   the symptom, in their words
 *   Why                the cause, from the error text and the config
 *   Did it fail over   whether the router had somewhere to go — the step
 *                      nothing else on the page answers
 *   Can you work       the line that decides whether this gets escalated
 *
 * Severity sections are fixed (Critical · Degraded · Config) because that is
 * the page's own vocabulary. The toggle is a secondary ORDER — by chain, or by
 * time, which answers "what just started" rather than "what is worst".
 */
import { useEffect, useState } from "react";
import { apiPostResult } from "@/lib/api-client";
import { useFilters } from "@/components/gateway/FiltersProvider";

interface Issue {
  severity: "critical" | "degraded" | "config";
  spec: string;
  chain: string;
  title: string;
  whatHappened: string;
  whyItHappened: string;
  whatTheRouterTried: string;
  impact: string;
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

function Line({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div style={{ display: "flex", gap: 10, padding: "3px 0" }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--text-4)",
          minWidth: 104,
          flexShrink: 0,
          paddingTop: 2,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--text-2)" }}>{text}</span>
    </div>
  );
}

function Card({ issue, color }: { issue: Issue; color: string }) {
  const when = ago(issue.lastSeenUnix);
  return (
    <div style={{ borderLeft: `3px solid ${color}`, padding: "10px 0 12px 12px", marginBottom: 2 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{issue.chain}</span>
        <span style={{ fontSize: 9.5, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{issue.spec}</span>
        <span style={{ flex: 1 }} />
        {when && <span style={{ fontSize: 10.5, color: "var(--text-4)" }}>{when}</span>}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, margin: "3px 0 7px", color: "var(--text)" }}>{issue.title}</div>
      <Line label="What's happening" text={issue.whatHappened} />
      <Line label="Why" text={issue.whyItHappened} />
      <Line label="Did it fail over" text={issue.whatTheRouterTried} />
      <Line label="Can you work" text={issue.impact} />
    </div>
  );
}

export function IssueCards({ chainsAffected }: { chainsAffected: string[] }) {
  const { timeWindow, scopeQ } = useFilters();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [running, setRunning] = useState(false);
  const [order, setOrder] = useState<"chain" | "time">("chain");

  async function run() {
    setRunning(true);
    setRefusal(null);
    try {
      const { body } = await apiPostResult<Answer | Refusal>(
        `/api/ai/issues?window=${timeWindow}${scopeQ}`,
      );
      if (body.ok) setIssues(body.issues);
      else {
        setIssues(null);
        setRefusal(body);
      }
    } catch (err) {
      setIssues(null);
      setRefusal({ ok: false, reason: "model_call_failed", detail: String(err) });
    } finally {
      setRunning(false);
    }
  }

  // A changed window means the issues on screen describe a period nobody is
  // looking at any more. Cleared rather than left stale — an issue captioned
  // with the wrong window is worse than an empty section.
  useEffect(() => {
    setIssues(null);
  }, [timeWindow]);

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
        <span style={{ flex: 1 }} />
        <button className="gw-btn" onClick={run} disabled={running} style={{ fontSize: 11 }}>
          {running ? "Analysing…" : issues ? "Refresh" : "Explain these issues"}
        </button>
      </div>

      {refusal && <div style={{ fontSize: 12, color: "var(--text-3)" }}>{refusalText(refusal)}</div>}

      {/* Never a blank page while it runs: naming the chains it is working
          through is the difference between "loading" and "stuck". */}
      {running && !issues && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          Reading errors and config for {chainsAffected.length}{" "}
          {chainsAffected.length === 1 ? "chain" : "chains"} — {chainsAffected.slice(0, 4).join(", ")}
          {chainsAffected.length > 4 ? "…" : ""}
        </div>
      )}

      {!issues && !running && !refusal && (
        <div style={{ fontSize: 12, color: "var(--text-3)" }}>
          {chainsAffected.length === 0
            ? "No chain crossed a rule in this window."
            : `${chainsAffected.length} ${chainsAffected.length === 1 ? "chain has" : "chains have"} issues in this window.`}
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
