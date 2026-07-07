"use client";

/* MetricsTab — port of the design prototype's DSHMetrics root container
   (SR_Dashboard/magma/page-dashboard.jsx ~1132 + 1304-1305 + 1828), split
   into the three lettered section files to keep each reviewable. The root
   div's inline styles are verbatim. */

import type { DashboardData, MetricWindow } from "@sr/shared";
import { MetricsTabSectionA } from "./MetricsTabSectionA";
import { MetricsTabSectionB } from "./MetricsTabSectionB";
import { MetricsTabSectionC } from "./MetricsTabSectionC";

export function MetricsTab({
  win,
  apiWindow,
  data,
  chains,
}: {
  /** Design window key ("1h" | "3h" | "24h" | "7d" | "custom:…") for chart axis labels. */
  win: string;
  /** The API window actually fetched (feeds the §19 methods table). */
  apiWindow: MetricWindow;
  data: DashboardData | undefined;
  /** Header multiselect selection ([] = all) — filters per-chain series client-side. */
  chains: string[];
}) {
  return (
    <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 28 }}>
      <MetricsTabSectionA win={win} data={data} chains={chains} />
      <MetricsTabSectionB win={win} data={data} />
      <MetricsTabSectionC win={win} apiWindow={apiWindow} data={data} />
    </div>
  );
}
