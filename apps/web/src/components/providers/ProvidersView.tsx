"use client";

/* ProvidersView — the Providers page: how each provider behaves across every
 * chain, and the report to send one. Its own page in the menu, beside Metrics
 * (how the routers behave) and Upstreams (where they are set up).
 *
 * Like Metrics with its chains, the providers are a list beside the sidebar
 * (ProvidersDrawer, put in the shell's slot through a portal): "All
 * providers" is the comparison table, a row is that provider's page. The pick
 * is in the URL (`?provider=`): the page reads the first one on the server, a
 * pick is a history entry, and Back returns to the one before. The window and
 * the chain come from the shared FiltersProvider. A chain row opens that
 * upstream on the Metrics page's Upstreams tab. */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { ProvidersReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { PageActions, RouterHeader } from "@/components/gateway/RouterHeader";
import { PAGE_DRAWER_SLOT_ID } from "@/components/gateway/Shell";
import { useChainFilter, useChainOptions, withMutedRows } from "@/hooks/use-chain-options";
import { ProvidersWithReports } from "./ProviderReport";
import { ProvidersDrawer } from "./ProvidersDrawer";

const PROVIDER_ID = /^[A-Za-z0-9 ._-]{1,64}$/;
/** The slot never changes once the shell is drawn: nothing to subscribe to. */
const noSubscribe = () => () => {};

export function ProvidersView({ initialProvider = null }: { initialProvider?: string | null }) {
  const router = useRouter();
  const { timeWindow, setTimeWindow, scopeQ } = useFilters();
  const { chain, select: selectChain } = useChainFilter();
  const { chains: chainRows } = useChainOptions();
  const chains = withMutedRows(chainRows, (c) => (c.hasTraffic ? false : "no traffic yet"));
  // The same read the list below makes: one request, shared by the two.
  const listRes = useApi<ProvidersReport>(`/api/metrics/providers?window=${timeWindow}${scopeQ}`, 60_000);

  const [providerId, setProviderId] = useState<string | null>(initialProvider);
  const select = useCallback((id: string | null) => {
    setProviderId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("provider", id);
    else url.searchParams.delete("provider");
    window.history.pushState(null, "", url);
  }, []);
  // Back and Forward move between picks.
  useEffect(() => {
    const onPop = () => {
      const id = new URLSearchParams(window.location.search).get("provider");
      setProviderId(id && PROVIDER_ID.test(id) ? id : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // The shell's slot beside the sidebar: in the browser's DOM, never on the server.
  const slot = useSyncExternalStore(noSubscribe, () => document.getElementById(PAGE_DRAWER_SLOT_ID), () => null);

  const picked = providerId ? listRes.data?.providers.find((p) => p.id === providerId) : null;

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      {slot && createPortal(
        <ProvidersDrawer report={listRes.data} loading={listRes.isLoading} selectedId={providerId} onSelect={select} timeWindow={timeWindow} />,
        slot,
      )}
      <div className="gw-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>{picked ? picked.name : "Providers"}</h1>
        <PageActions timeWindow={timeWindow} setTimeWindow={setTimeWindow} chainFilter={chain ?? "all"} />
      </div>
      <div style={{ marginBottom: 20 }}>
        <RouterHeader chains={chains} chainFilter={chain ?? "all"} setChainFilter={(v) => selectChain(v === "all" ? null : v)}
          timeWindow={timeWindow} setTimeWindow={setTimeWindow} withActions={false} />
      </div>
      <ProvidersWithReports timeWindow={timeWindow} chainFilter={chain} selectedId={providerId} onSelect={select}
        onOpenUpstream={(ref) =>
          router.push(`/metrics?chain=${encodeURIComponent(ref.spec)}&tab=upstreams&upstream=${encodeURIComponent(ref.endpointId)}`)
        } />
    </div>
  );
}
