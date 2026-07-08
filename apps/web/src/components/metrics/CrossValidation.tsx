"use client";

/* CrossValidation — response-correctness panel. Ported verbatim from the
 * design prototype (page-metrics.jsx CrossValidation). Live data:
 * /api/metrics/cross-validation. When the cross_validation_* family isn't
 * emitted yet the panel keeps FULL design chrome with "—" values — while the
 * router's REAL consistency counters (consistency_total /
 * consistency_success_total) are surfaced in their own strip. */

import { buildChainMetaByIndex, type CrossValidationReport, type MetricWindow } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { Tip } from "@/components/gateway/Tip";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { ThCol } from "@/components/gateway/SortTable";
import { fmtComma, fmtNum } from "@/lib/format";

const CV_TIP = "A **sampled subset** of requests is sent to several upstreams at once and their responses compared.\n\n**Matching the majority = agreement; differing = disagreement** — catching wrong, stale, or forked answers that latency and error metrics miss.\n\nCoverage is the **sampled subset only**, not all traffic.";

export function CrossValidation({ tw }: { tw: MetricWindow }) {
  const { data: cv } = useApi<CrossValidationReport>(`/api/metrics/cross-validation?window=${tw}`);

  const rounds = cv?.rounds ?? null;
  const consensusPct = cv?.consensusRate != null ? cv.consensusRate * 100 : null;
  const noConsensus = cv?.disagreements ?? null;
  const consistency = cv?.consistency ?? { total: 0, caught: 0 };

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)", display: "inline-flex", alignItems: "center", marginBottom: 18 }}>
        Cross-validation · response correctness<Tip text={CV_TIP} />
      </div>

      {/* 3 headline stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20, marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid var(--line)" }}>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: rounds == null ? "var(--text-4)" : "var(--text)" }}>{rounds != null ? fmtNum(rounds) : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>requests cross-validated</div>
        </div>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: consensusPct != null ? "var(--ok)" : "var(--text-4)" }}>{consensusPct != null ? consensusPct.toFixed(2) + "%" : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>reached consensus</div>
        </div>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: noConsensus == null ? "var(--text-4)" : noConsensus > 0 ? "var(--warn)" : "var(--text)" }}>{noConsensus != null ? fmtComma(noConsensus) : "—"}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>no consensus — upstreams disagreed</div>
        </div>
      </div>

      {/* REAL consistency counters — always emitted on this build */}
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)", marginBottom: 12 }}>
        Consistency checks <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--text-4)" }}>— always-on head-freshness verification (consistency_total)</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20, marginBottom: 24, paddingBottom: 24, borderBottom: "1px solid var(--line)" }}>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>{fmtNum(consistency.total)}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>responses checked</div>
        </div>
        <div>
          <div className="gw-mono gw-tnum" style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, color: consistency.caught > 0 ? "var(--warn)" : "var(--text)" }}>{fmtComma(consistency.caught)}</div>
          <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 8 }}>stale responses caught</div>
        </div>
        <div />
      </div>

      {/* per-chain disagreement table */}
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-3)", marginBottom: 12 }}>
        Disagreement rate by chain <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--text-4)" }}>— how often responses on each chain were non-consensus</span>
      </div>
      <table className="gw-table">
        <thead>
          <tr>
            <ThCol>Chain</ThCol>
            <ThCol align="right">Rounds</ThCol>
            <ThCol align="right">Disagreements</ThCol>
            <ThCol align="right">Disagreement rate</ThCol>
          </tr>
        </thead>
        <tbody>
          {(cv?.byChain ?? []).map((p) => {
            const meta = buildChainMetaByIndex(p.spec);
            return (
              <tr key={p.spec}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ChainBadge spec={p.spec} size={16} />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{meta.name}</span>
                  </div>
                </td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text-2)" }}>{fmtComma(p.rounds)}</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12, color: "var(--text-4)" }}>—</span></td>
                <td style={{ textAlign: "right" }}><span className="gw-mono gw-tnum" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-4)" }}>—</span></td>
              </tr>
            );
          })}
          {cv && cv.byChain.length === 0 && (
            <tr><td colSpan={4} style={{ padding: "20px 12px", textAlign: "center", color: "var(--text-4)", fontSize: 12.5 }}>
              {cv.emitted ? "No cross-validation samples this window." : "Cross-validation counters appear once the feature fires on this build."}
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
