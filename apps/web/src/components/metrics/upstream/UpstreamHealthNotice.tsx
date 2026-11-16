"use client";

import { useState } from "react";
import type { ErrorRequestsReport, HealthState } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { upstreamHealthNotice } from "@/lib/upstream-presentation";
import { sinceWords } from "@/lib/health";
import { errorType } from "@/components/metrics/request-log";

/** How far back the router's logs are read for a provider's last errors. */
const LOG_SPAN_MS = 3_600_000;

/**
 * A provider that is not operational, said on the page rather than in a
 * tooltip, in as few words as carry it: since when, why, and - for an
 * unhealthy one - the error most of its failed requests had in the last hour,
 * with a link to those requests. The status is the latest one, whatever
 * window the page is on.
 */
export function UpstreamHealthNotice({ health, reason, since, sinceOrEarlier, spec, name, onOpenErrors }: {
  health: HealthState;
  reason?: string;
  since?: number | null;
  sinceOrEarlier?: boolean;
  /** The provider and its chain, to read its last errors; left out, none are read. */
  spec?: string;
  name?: string;
  /** Opens the Errors tab on this provider's failed requests over the span read. */
  onOpenErrors?: (range: { from: number; to: number }) => void;
}) {
  if (health === "operational") return null;
  const color = health === "unhealthy" ? "var(--err)" : "var(--warn)";
  const when = health === "unhealthy" ? sinceWords(since, sinceOrEarlier) : null;
  // With a time, the status and the time are one phrase; the reason follows it.
  const lead = when ? `Unhealthy ${when}.` : null;
  return (
    <div role="alert" style={{ padding: "12px 14px", marginBottom: 12, border: `1px solid ${color}`, borderRadius: 8, background: "var(--hover)", fontSize: 13, display: "grid", gap: 6 }}>
      <div style={{ color }}>
        {lead ? <><span style={{ fontWeight: 600 }}>{lead}</span> {reason}</> : upstreamHealthNotice(health, reason)}
      </div>
      {health === "unhealthy" && spec && name && <LastErrors spec={spec} name={name} onOpenErrors={onOpenErrors} />}
    </div>
  );
}

/**
 * The error most of the provider's failed requests had in the last hour, from
 * the router's logs, with how many of them and a link to those requests. One
 * line. Nothing until the logs answer, when they can't be read, and when they
 * hold no failed request at it.
 */
function LastErrors({ spec, name, onOpenErrors }: { spec: string; name: string; onOpenErrors?: (range: { from: number; to: number }) => void }) {
  // One span per mount: the read's key must not move with the clock.
  const [span] = useState(() => { const to = Date.now(); return { from: to - LOG_SPAN_MS, to }; });
  const { data } = useApi<ErrorRequestsReport>(
    `/api/error-requests?from=${span.from}&to=${span.to}&spec=${encodeURIComponent(spec)}&upstream=${encodeURIComponent(name)}`, 0);
  if (!data?.available) return null;
  const failed = data.rows.flatMap((r) => r.attempts.filter((a) => a.upstream.toLowerCase() === name.toLowerCase() && a.outcome === "failed"));
  if (!failed.length) return null;
  const byType = new Map<string, { label: string; count: number }>();
  for (const a of failed) {
    const t = errorType(a);
    byType.set(t.key, { label: t.label, count: (byType.get(t.key)?.count ?? 0) + 1 });
  }
  const top = [...byType.values()].sort((a, b) => b.count - a.count)[0]!;
  return (
    <div style={{ fontSize: 12, color: "var(--text-2)" }}>
      <strong style={{ color: "var(--text)" }}>{top.label.charAt(0).toUpperCase() + top.label.slice(1)}</strong> on {top.count} of {failed.length}{data.more ? "+" : ""} failed attempts in the last hour
      {onOpenErrors && (
        <button onClick={() => onOpenErrors(span)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: "0 0 0 8px", fontSize: 12, fontWeight: 600, fontFamily: "inherit" }}>
          See the requests
        </button>
      )}
    </div>
  );
}
