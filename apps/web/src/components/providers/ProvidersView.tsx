"use client";

/* ProvidersView — the Providers page: how each provider behaves across every
 * chain, and the report to send one. Its own page in the menu, beside Metrics
 * (how the routers behave) and Upstreams (where they are set up). The window
 * and the chain come from the shared FiltersProvider; the chain belongs to
 * this page, as it does on every page. A chain row opens that upstream on the
 * Metrics page's Upstreams tab. */

import { useRouter } from "next/navigation";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { PageActions, RouterHeader } from "@/components/gateway/RouterHeader";
import { useChainFilter, useChainOptions, withMutedRows } from "@/hooks/use-chain-options";
import { ProvidersWithReports } from "./ProviderReport";

export function ProvidersView() {
  const router = useRouter();
  const { timeWindow, setTimeWindow } = useFilters();
  const { chain, select: selectChain } = useChainFilter();
  const { chains: chainRows } = useChainOptions();
  const chains = withMutedRows(chainRows, (c) => (c.hasTraffic ? false : "no traffic yet"));

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      <div className="gw-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Providers</h1>
        <PageActions timeWindow={timeWindow} setTimeWindow={setTimeWindow} chainFilter={chain ?? "all"} />
      </div>
      <div style={{ marginBottom: 20 }}>
        <RouterHeader chains={chains} chainFilter={chain ?? "all"} setChainFilter={(v) => selectChain(v === "all" ? null : v)}
          timeWindow={timeWindow} setTimeWindow={setTimeWindow} withActions={false} />
      </div>
      <ProvidersWithReports timeWindow={timeWindow} chainFilter={chain}
        onOpenUpstream={(ref) =>
          router.push(`/metrics?chain=${encodeURIComponent(ref.spec)}&tab=upstreams&upstream=${encodeURIComponent(ref.endpointId)}`)
        } />
    </div>
  );
}
