"use client";

import type { MetricWindow, UpstreamMetrics } from "@sr/shared";
import { healthColor, healthLabel, HEALTH_UNKNOWN_HINT } from "@/lib/health";
import { pollColor, pollSummary, qosHint, qosIsStale, qosValue } from "@/lib/upstream-signals";

/* PMEmpty — an upstream the router routed no requests to in this window.
 *
 * The design prototype's version asserted "probes are passing" and "Probes
 * healthy · standing by as backup" as static text, on every row, whatever the
 * upstream's real state and whatever its role. That was a fabrication of
 * exactly the kind the honesty contract exists to stop: it named a probe result
 * nothing had read, on a panel whose whole reason for existing is that we have
 * no traffic-derived numbers to show.
 *
 * What replaces it is the same shape filled with things the router really
 * reports without traffic — its live QoS score, its own block polls, and the
 * tip it last saw. "No traffic" turns out to be a long way from "no data". */

export function PMEmpty({
  pm,
  name,
  chainName,
  timeWindow,
}: {
  pm: UpstreamMetrics;
  name: string;
  chainName: string;
  timeWindow: MetricWindow;
}) {
  const qos = qosValue(pm);
  const polls = pollSummary(pm.polls);
  /* Whether the router is telling us anything at all about this upstream.
     "The router still watches this upstream" is a claim, and on a row with no
     score, no answered poll and no tip it is not one we can make — that would
     be the same invention as the "probes are passing" line this replaced. */
  const polled = pm.polls !== null && pm.polls.ok + pm.polls.failed > 0;
  const watched = qos !== null || polled || pm.latestBlock !== null;
  const roleLine =
    pm.role === "backup"
      ? "A backup only serves when the primaries cannot."
      : pm.role === "primary"
        ? "On a primary over a busy window, that is worth a look."
        : null;

  return (
    <div className="gw-card" style={{ padding: "40px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-4)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l2 6 4-12 2 6h6" />
      </svg>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-2)" }}>
          No requests routed to {name} in this window
        </div>
        <div style={{ fontSize: 13, color: "var(--text-3)", marginTop: 6, maxWidth: 420, lineHeight: 1.6 }}>
          Traffic, latency and error rate need real requests. {roleLine}{roleLine ? " " : ""}
          {watched
            ? "The router still watches it:"
            : "Nothing else is being reported for it either."}
        </div>
      </div>

      {/* Every value here is read, never assumed. A row the router does not
          report is omitted rather than filled with an optimistic default. */}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 10 }}>
        <Fact label="Status" title={pm.health === "unknown" ? HEALTH_UNKNOWN_HINT : undefined}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: healthColor(pm.health), boxShadow: `0 0 6px ${healthColor(pm.health)}` }} />
            <span style={{ color: healthColor(pm.health), fontWeight: 600 }}>{healthLabel(pm.health)}</span>
          </span>
        </Fact>

        {qos != null && (
          <Fact label="QoS" title={qosHint(pm)}>
            <span className="gw-mono gw-tnum" style={{ fontWeight: 700, color: qos > 97 ? "var(--ok)" : qos > 90 ? "var(--warn)" : "var(--err)", opacity: qosIsStale(pm) ? 0.55 : 1 }}>
              {Math.round(qos)}
            </span>
            {qosIsStale(pm) && <span style={{ color: "var(--text-4)" }}> old</span>}
          </Fact>
        )}

        {polls !== null && (
          <Fact
            label={`Block polls · ${timeWindow}`}
            title="The router polls every configured upstream for its latest block, whether or not it routes requests to it. Zero polls means the poll gate suppressed them — served traffic or a peer's poll already refreshed the tip — not that the upstream failed."
          >
            <span style={{ color: pollColor(pm.polls) }}>{polls}</span>
          </Fact>
        )}

        {pm.latestBlock != null && (
          <Fact label="Latest block" title={`The head this upstream reports on ${chainName}.`}>
            <span className="gw-mono gw-tnum">{pm.latestBlock.toLocaleString("en-US")}</span>
            {pm.behindSec != null && pm.behindSec >= 1 && (
              <span style={{ color: "var(--text-3)" }}> · {Math.round(pm.behindSec)}s behind</span>
            )}
            {pm.stale && <span style={{ color: "var(--warn)" }}> · tip frozen</span>}
          </Fact>
        )}
      </div>
    </div>
  );
}

function Fact({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div
      title={title}
      style={{ padding: "8px 13px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--hover)", display: "flex", flexDirection: "column", gap: 3, minWidth: 120 }}
    >
      <span style={{ fontSize: 9, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ fontSize: 13, color: "var(--text-2)" }}>{children}</span>
    </div>
  );
}
