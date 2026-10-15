"use client";

/* The Metrics page's hint about recording rules. The api reads windows of
   3h and up from the store's recorded series when the store evaluates the
   recording rules (docs/RECORDING-RULES.md) and falls back to the raw
   families otherwise — correct either way, slow without. This says which
   case the deployment is in, only when there is something to do about it:
   nothing when the rules are in place and cover every window, nothing when
   recorded reads are configured off. */
import { useApi } from "@/hooks/use-api";
import type { RecordedReadsState } from "@sr/shared";

const DOCS_URL = "https://github.com/Magma-Devs/smart-router-dashboard/blob/main/docs/RECORDING-RULES.md";

function ago(sec: number | null): string {
  if (sec === null) return "";
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${(sec / 3600).toFixed(sec < 36000 ? 1 : 0)} h`;
  return `${(sec / 86400).toFixed(1)} days`;
}

export function RecordedReadsNotice() {
  const { data } = useApi<RecordedReadsState>("/api/metrics/reads", 60_000);
  if (!data || data.from === null || data.reason === "off" || data.reason === "unprobed") return null;

  let lead: string;
  let detail: string;
  if (data.reason === "absent") {
    lead = "Long windows read the raw series: this store has no recording rules for the router metrics.";
    detail = `A 3-day view scans every raw histogram series on every refresh. With the rules in place, windows of ${data.from} and up read a few hundred recorded series instead, and the numbers stay within a fraction of a percent.`;
  } else if (data.reason === "stale") {
    lead = "The recorded series are behind, so every window reads the raw series.";
    detail = `The newest recorded sample is ${ago(data.ageSec)} old — the store's ruler has stopped evaluating the recording rules, or is behind. Reads switch back on their own once it catches up.`;
  } else {
    // Fresh. Worth a word only while the history is shorter than some window the page offers.
    const uncovered = data.windows.raw.filter((w) => data.windows.recorded.length > 0 || w !== data.from);
    const longest = data.windows.recorded[data.windows.recorded.length - 1];
    if (data.historySec === null || !uncovered.some((w) => w !== "5m" && w !== "15m" && w !== "30m" && w !== "1h")) return null;
    lead = `The recording rules have ${ago(data.historySec)} of history.`;
    detail = `Windows up to ${longest ?? data.from} read the recorded series; wider ones read the raw series until the history covers them, or until the rules are backfilled.`;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 9,
        padding: "10px 12px",
        borderRadius: 8,
        background: "rgba(96,165,250,0.08)",
        border: "1px solid rgba(96,165,250,0.22)",
        fontSize: 12,
        color: "var(--text-2)",
        lineHeight: 1.5,
        marginBottom: 16,
      }}
      role="status"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <div>
        <strong style={{ color: "var(--text)", fontWeight: 600 }}>{lead}</strong> {detail}{" "}
        <a href={DOCS_URL} target="_blank" rel="noreferrer" style={{ color: "var(--info)" }}>
          The rules and what they change
        </a>
        .
      </div>
    </div>
  );
}
