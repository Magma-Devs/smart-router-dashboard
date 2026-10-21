"use client";

/* The Transactions tab's chart - transactions over the page window, a bar per
 * stretch of the clock (10 minutes on an hour, longer on days), each bar split
 * by result: the list's results in the list's colours, and Failed on chain.
 * Live data: /api/transactions/over-time - the store's recorded per-minute
 * counts, with the newest minutes, and a store that records none, counted
 * from the router's logs. Hover a bar for its counts; the legend adds up the
 * window. It follows the page's window and chain or router, not the exact
 * times the list can be set to. */

import { useMemo } from "react";
import { WINDOWS, type MetricWindow, type TransactionsOverTime, type TxResult } from "@sr/shared";
import { ColumnChart, type Layer } from "@/components/gateway/charts";
import { SkelLine } from "@/components/gateway/Skel";
import { Tip } from "@/components/gateway/Tip";
import { useApi } from "@/hooks/use-api";
import { barSpanWords, barWords, gridTimes, hhmm, timeTicks } from "@/lib/chart-time";
import { fmtComma } from "@/lib/format";
import { TT } from "@/lib/tooltips";

/**
 * A transaction's result as the tab draws it - the list's tags and the chart's
 * bars alike. Two results share the list's red, so the chart stripes Router
 * error and draws Failed on chain lighter.
 */
export const TX_RESULT: Record<TxResult, { label: string; color: string; hatch?: boolean; opacity?: number }> = {
  accepted: { label: "Accepted", color: "var(--ok)" },
  rejected: { label: "Rejected", color: "var(--err)" },
  "failed-on-chain": { label: "Failed on chain", color: "var(--err)", opacity: 0.35 },
  failed: { label: "Router error", color: "var(--err)", hatch: true },
  unknown: { label: "Unknown", color: "var(--text-4)" },
};

/** Bottom to top. */
const ORDER: TxResult[] = ["accepted", "rejected", "failed-on-chain", "failed", "unknown"];

/** A legend swatch drawn as the bar is: striped, lighter or solid. */
function Swatch({ r }: { r: TxResult }) {
  const s = TX_RESULT[r];
  const background = s.hatch ? `repeating-linear-gradient(45deg, ${s.color} 0 2px, transparent 2px 4px)` : s.color;
  return <span style={{ width: 9, height: 9, borderRadius: 2, background, opacity: s.opacity ?? 0.8, flexShrink: 0, border: s.hatch ? `1px solid ${s.color}` : undefined, boxSizing: "border-box" }} />;
}

const PAD_X = 44;
const PAD_R = 12;

export function TransactionsChart({ win, specQ, routerIdQ, exactRange }: {
  win: MetricWindow;
  /** `&spec=…` or "". */
  specQ: string;
  /** `&routerId=…` or "". */
  routerIdQ: string;
  /** The list is set to exact times: the chart still covers the page window, and says so. */
  exactRange: boolean;
}) {
  const { data, error, isLoading } = useApi<TransactionsOverTime>(`/api/transactions/over-time?window=${win}${specQ}${routerIdQ}`);
  const times = useMemo(() => gridTimes(data?.grid), [data]);
  const layers: Layer[] = useMemo(
    () => ORDER.filter((r) => data?.counts[r]).map((r) => ({ name: TX_RESULT[r].label, values: data!.counts[r]!, color: TX_RESULT[r].color, hatch: TX_RESULT[r].hatch, opacity: TX_RESULT[r].opacity })),
    [data],
  );
  const shown = ORDER.filter((r) => data?.counts[r]);
  const totals = shown.map((r) => (data!.counts[r] ?? []).reduce((a, b) => a + b, 0));
  const total = totals.reduce((a, b) => a + b, 0);
  const step = data?.grid.stepSec ?? 0;
  const dom: [number, number] | undefined = data ? [data.asOf - WINDOWS[win].rangeSeconds, data.asOf] : undefined;
  const partial = (i: number) => data?.partialFrom != null && (times[i] ?? 0) > data.partialFrom;

  let body: React.ReactNode;
  if (isLoading && !data) body = <div style={{ height: 150, display: "grid", alignItems: "center" }}><SkelLine w="60%" /></div>;
  else if (error && !data) body = <Quiet>The counts couldn&apos;t be loaded. The chart tries again on its next refresh.</Quiet>;
  else if (data && !data.available) {
    body = <Quiet>{data.reason === "shared-chain"
      ? "Not split per router on a chain several routers serve: the logs don't say which router wrote a line."
      : data.reason === "unreachable" ? "The router's logs didn't answer in time." : "Neither the store nor the router's logs can be read."}</Quiet>;
  } else if (data && total === 0) body = <Quiet>No transactions in the last {WINDOWS[win].label}.</Quiet>;
  else if (data) {
    body = (
      <>
        <div style={{ height: 150 }}>
          <ColumnChart stacks={layers} id="txot" integerY xs={times} barSpan={step} xDomain={dom} xTicks={timeTicks(dom)} padX={PAD_X} padR={PAD_R}
            tooltip={(i) => (
              <>
                <div className="gw-mono" style={{ color: "var(--text-3)", marginBottom: 6 }}>{barWords(times[i]!, step, data.asOf)}</div>
                {shown.map((r) => (
                  <div key={r} style={{ display: "flex", alignItems: "center", gap: 7, padding: "2px 0" }}>
                    <Swatch r={r} />
                    <span style={{ flex: 1, color: "var(--text-2)" }}>{TX_RESULT[r].label}</span>
                    <span className="gw-mono gw-tnum" style={{ color: "var(--text)", fontWeight: 600 }}>{fmtComma(data.counts[r]?.[i] ?? 0)}</span>
                  </div>
                ))}
                {partial(i) && <div style={{ marginTop: 6, color: "var(--text-4)" }}>Its newest minutes aren&apos;t counted yet.</div>}
              </>
            )} />
        </div>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", columnGap: 18, rowGap: 6, marginTop: 6, paddingLeft: PAD_X }}>
          <span className="gw-mono" style={{ fontSize: 10, color: "var(--text-4)", textTransform: "uppercase", letterSpacing: "0.06em" }}>This window</span>
          {shown.map((r, k) => (
            <span key={r} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
              <Swatch r={r} />
              <span style={{ fontSize: 11, color: "var(--text-2)" }}>{TX_RESULT[r].label}</span>
              <span className="gw-mono gw-tnum" style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>{fmtComma(totals[k]!)}</span>
            </span>
          ))}
        </div>
        {data.partialFrom != null && (
          <div style={{ marginTop: 6, paddingLeft: PAD_X, fontSize: 11, color: "var(--text-4)" }}>
            Transactions since {hhmm(data.partialFrom * 1000)} aren&apos;t counted yet: the store records them a couple of minutes late, and the logs didn&apos;t fill them in.
          </div>
        )}
      </>
    );
  }

  return (
    <div className="gw-card" style={{ padding: "13px 16px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", fontSize: 12, color: "var(--text-3)", fontWeight: 500 }}>
          Transactions over time<Tip text={TT.txOverTime!} />
        </span>
        <span style={{ fontSize: 11, color: "var(--text-4)" }}>
          {step ? `a bar per ${barSpanWords(step)}` : ""}{exactRange ? `${step ? " · " : ""}the last ${WINDOWS[win].label}, not the times you picked` : ""}
        </span>
      </div>
      {body}
    </div>
  );
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <div style={{ height: 120, display: "grid", placeItems: "center", fontSize: 12, color: "var(--text-4)", textAlign: "center" }}>{children}</div>;
}
