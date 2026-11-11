"use client";

/* ProvidersView — the Providers page: how each provider behaves across every
 * chain, and the report to send one. Its own page in the menu, beside Metrics
 * (how the routers behave) and Upstreams (where they are set up).
 *
 * Like Metrics with its chains, the providers are a list beside the sidebar
 * (ProvidersDrawer, put in the shell's slot through a portal): "All
 * providers" is the comparison table, a row is that provider's page. The
 * view is in the URL through the Metrics page's own hook (`useScopeInUrl`):
 * the chain (a change is a history entry), the window and `provider` (a pick
 * rewrites the entry it is on, as a focus does on Metrics). The page reads the
 * first provider on the server. No config router: the provider reads don't
 * take one, so the page has no router select and its URL no `router`. A chain
 * row opens that upstream on the Metrics page's Upstreams tab
 * (`?tab=upstreams&upstream=&upstreamChain=`, lib/view-in-url.ts). */

import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { ProvidersReport } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { PageActions, RouterHeader } from "@/components/gateway/RouterHeader";
import { PAGE_DRAWER_SLOT_ID } from "@/components/gateway/Shell";
import { useChainFilter, useChainOptions, withMutedRows } from "@/hooks/use-chain-options";
import { useScopeInUrl } from "@/hooks/use-scope-in-url";
import { windowFromSearch } from "@/lib/view-in-url";
import { ProvidersWithReports } from "./ProviderReport";
import { ProvidersDrawer } from "./ProvidersDrawer";

const PROVIDER_ID = /^[A-Za-z0-9 ._-]{1,64}$/;
/** One view: the URL hook's tab is fixed. */
const TABS = ["providers"] as const;
const keepTab = () => {};
/** The provider reads take no config router, so a `router` in a link reads as none. */
const NO_ROUTERS: { id: string; spec: string }[] = [];
const noRouter = () => {};
/** The slot never changes once the shell is drawn: nothing to subscribe to. */
const noSubscribe = () => () => {};

export function ProvidersView({ initialProvider = null }: { initialProvider?: string | null }) {
  const router = useRouter();
  const { timeWindow, setTimeWindow, scopeQ, linkWindow, windowSettled } = useFilters();
  const { chain, select: selectChain } = useChainFilter();
  const { chains: chainRows } = useChainOptions();
  const chains = withMutedRows(chainRows, (c) => (c.hasTraffic ? false : "no traffic yet"));
  // The same read the list below makes: one request, shared by the two.
  const listRes = useApi<ProvidersReport>(`/api/metrics/providers?window=${timeWindow}${scopeQ}`, 60_000);

  const [providerId, select] = useState<string | null>(initialProvider);
  useScopeInUrl({ chain, router: null }, { selectChain, selectRouter: noRouter }, NO_ROUTERS, {
    tab: "providers", setTab: keepTab, tabs: TABS,
    // The window only once it is the viewer's for good, as on Metrics.
    params: { window: windowSettled ? timeWindow : undefined, provider: providerId },
    adoptParams: (search) => {
      const w = windowFromSearch(search);
      if (w.window) linkWindow(w.window);
      const id = new URLSearchParams(search).get("provider");
      const next = id && PROVIDER_ID.test(id) ? id : null;
      select(next);
      return { window: w.window ?? (windowSettled ? timeWindow : undefined), provider: next };
    },
  });

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
          timeWindow={timeWindow} setTimeWindow={setTimeWindow} withActions={false} withRouter={false} />
      </div>
      <ProvidersWithReports timeWindow={timeWindow} chainFilter={chain} selectedId={providerId} onSelect={select}
        onOpenUpstream={(ref) =>
          router.push(`/metrics?tab=upstreams&upstream=${encodeURIComponent(ref.endpointId)}&upstreamChain=${encodeURIComponent(ref.spec)}`)
        } />
    </div>
  );
}
