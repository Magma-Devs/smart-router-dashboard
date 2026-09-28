"use client";

/* ChainsTable — every chain with its raw numbers for the window, no praise.
 * Parked: the Status page does not render it for now (the "Chains" tab was
 * removed 2026-08-19 — the raw columns read as unexplained errors; anything
 * that matters must surface as an Issue). Kept so it can come back as a
 * drill-in rather than a tab. */

import type { ChainStatusRow } from "@sr/shared";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { fmtComma } from "@/lib/format";

export function ChainsTable({ rows, onJump }: { rows: ChainStatusRow[]; onJump: (spec: string) => void }) {
  // Two glyphs, two meanings. "—" is a measured zero. "n/a" is "fewer than
  // 300 requests, so a 1% rate is indistinguishable from zero" — and it must
  // never look like a clean zero.
  const p = (v: number | null, insufficient: boolean) =>
    v == null
      ? insufficient
        ? <span title="Fewer than 300 requests in this window — too few to judge a 1% rate" style={{ color: "var(--text-4)" }}>n/a</span>
        : "—"
      : `${(v * 100).toFixed(2)}%`;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640, fontSize: 12 }}>
        <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Every chain with its failure numbers for this window
        </caption>
        <thead>
          <tr>
            {[
              ["Chain", "Chain — click a name in a finding to jump to it here"],
              ["Requests", "Customer requests in this window"],
              ["No answer", "Share of upstream relays that got no reply — refused, timed out, rate limited"],
              ["Error answers", "Share of replies that were error bodies — the relay succeeded, the answer did not"],
              ["Answers ≥10s", "Customer answers slower than 10 seconds — successes your client may have timed out on"],
              ["Attempts/req", "Upstream attempts per customer request, with the same window a week earlier in parentheses"],
              ["State", "see finding — a rule crossed; no rule crossed; not enough traffic — under 300 requests"],
            ].map(([h, tip], i) => (
              <th key={h} scope="col" title={tip} style={{ textAlign: i === 0 ? "left" : "right", padding: "8px 14px 8px 4px",
                fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 700,
                color: "var(--text-3)", borderBottom: "1px solid var(--line-2)", whiteSpace: "nowrap", cursor: "help" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.spec} style={{ borderBottom: "1px solid var(--line)" }}>
              <td style={{ padding: "8px 14px 8px 18px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <ChainBadge spec={c.spec} size={14} />
                  <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.name}</span>
                </span>
              </td>
              <td className="gw-mono gw-tnum" style={{ textAlign: "right", padding: "8px 14px 8px 4px", color: "var(--text-3)" }}>{fmtComma(c.requests)}</td>
              <td className="gw-mono gw-tnum" style={{ textAlign: "right", padding: "8px 14px 8px 4px",
                color: c.noAnswerRate != null && c.noAnswerRate >= 0.01 ? "var(--warn)" : "var(--text-3)" }}>{p(c.noAnswerRate, c.state === "insufficient")}</td>
              <td className="gw-mono gw-tnum" style={{ textAlign: "right", padding: "8px 14px 8px 4px",
                color: c.errorAnswerRate != null && c.errorAnswerRate >= 0.01 ? "var(--warn)" : "var(--text-3)" }}>{p(c.errorAnswerRate, c.state === "insufficient")}</td>
              {/* Raw count, never hidden by a threshold: four slow answers on a
                  quiet chain is exactly what an SRE greps for. */}
              <td className="gw-mono gw-tnum" style={{ textAlign: "right", padding: "8px 14px 8px 4px",
                color: c.slowAnswers > 0 ? "var(--text-2)" : "var(--text-4)" }}>{c.slowAnswers > 0 ? fmtComma(c.slowAnswers) : "—"}</td>
              <td className="gw-mono gw-tnum" style={{ textAlign: "right", padding: "8px 14px 8px 4px", color: "var(--text-3)" }}>
                {c.attemptsPerRequest == null ? "—" : (
                  <span title={c.attemptsPerRequest < 1
                    ? "Below 1.0: some requests were answered without an upstream attempt (cache, or a request the router rejected itself)"
                    : "Upstream attempts per customer request — 1.0 means no retries or hedges were needed"}>
                    {c.attemptsPerRequest.toFixed(2)}
                  </span>
                )}
                {c.attemptsPerRequestWas != null && (
                  <span title="Same ratio, same window a week earlier" style={{ color: "var(--text-4)", fontSize: 10.5 }}> ({c.attemptsPerRequestWas.toFixed(2)})</span>
                )}
              </td>
              <td style={{ textAlign: "right", padding: "8px 18px 8px 4px", fontSize: 11, whiteSpace: "nowrap",
                color: c.state === "finding" ? "var(--err)" : c.state === "insufficient" ? "var(--text-4)" : "var(--text-3)" }}>
                {c.state === "finding"
                  ? <a href={`#finding-${c.spec}`} onClick={(e) => { e.preventDefault(); onJump(c.spec); }}
                      style={{ color: "var(--err)", textDecoration: "underline dotted", textUnderlineOffset: 3 }}>see finding ↑</a>
                  : c.state === "insufficient" ? "not enough traffic to judge" : "no rule crossed"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
