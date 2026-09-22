"use client";

/* IncidentsTab — bursts of final customer failures over the last 24h, each
 * explained in the words that go to the customer. The story is composed by
 * the api so every surface says it the same way; this component renders it
 * and hands it over with one copy. */

import { useState } from "react";
import type { IncidentsReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { fmtComma } from "@/lib/format";

const hhmm = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function CopyStory({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
      style={{ border: "1px solid var(--line-2)", background: "transparent", color: "var(--text-3)",
        borderRadius: 6, padding: "3px 9px", fontSize: 11, cursor: "pointer", fontFamily: "inherit" }}
    >
      {done ? "Copied" : "Copy for the customer"}
    </button>
  );
}

export function IncidentsTab() {
  const { data } = useApi<IncidentsReport>("/api/metrics/incidents", 60000);
  if (!data) {
    return <div className="gw-card" style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--text-4)" }}>Checking…</div>;
  }
  if (data.incidents.length === 0) {
    return (
      <div className="gw-card" style={{ padding: "14px 16px", fontSize: 12.5, color: "var(--text-3)" }}>
        No failure bursts in the last {data.lookbackHours} hours — no 5-minute stretch had 5 or more final customer failures.
      </div>
    );
  }
  return (
    <>
      {data.incidents.map((i) => {
        const mins = Math.max(1, Math.round((i.endUnix - i.startUnix) / 60));
        return (
          <div key={i.id} className="gw-card" style={{ padding: 0, overflow: "hidden", marginBottom: 11 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 16px",
              background: "var(--bg-2)", borderBottom: "1px solid var(--line)" }}>
              <ChainBadge spec={i.spec} size={14} />
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{i.chainName}</span>
              <span className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
                {hhmm(i.startUnix)}–{hhmm(i.endUnix)} · {mins} min
              </span>
              {i.ongoing && (
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 800 }}>ongoing</span>
              )}
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 10 }}>
                <span className="gw-mono gw-tnum" style={{ fontSize: 12.5, fontWeight: 700 }}>
                  {fmtComma(i.failures)} <span style={{ fontWeight: 400, color: "var(--text-3)" }}>failed</span>
                </span>
                <CopyStory text={`${i.chainName}, ${hhmm(i.startUnix)}–${hhmm(i.endUnix)}:\n${i.story.map((s) => `• ${s}`).join("\n")}`} />
              </span>
            </div>
            <ul style={{ margin: 0, padding: "11px 16px 12px 32px", fontSize: 12.5, lineHeight: 1.6, color: "var(--text-2)" }}>
              {i.story.map((s, idx) => <li key={idx}>{s}</li>)}
            </ul>
            {i.failedMethods.length > 0 && (
              <div style={{ padding: "0 16px 12px", fontSize: 11, color: "var(--text-4)" }}>
                from the logs:{" "}
                {i.failedMethods.slice(0, 3)
                  .map((m) => `${m.method ?? m.errorName ?? m.example.slice(0, 40)} ×${fmtComma(m.count)}`)
                  .join(" · ")}
              </div>
            )}
          </div>
        );
      })}
      <p style={{ fontSize: 11, color: "var(--text-4)", margin: "4px 2px" }}>
        An incident is a stretch of 5-minute buckets each with 5+ final customer failures, from{" "}
        <span className="gw-mono">smartrouter_requests_failed_total</span> · last {data.lookbackHours}h.
      </p>
    </>
  );
}
