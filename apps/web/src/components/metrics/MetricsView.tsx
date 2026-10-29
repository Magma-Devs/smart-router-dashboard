"use client";

/* MetricsView — the Metrics page body, ported verbatim from the design
 * prototype (page-metrics.jsx MetricsPage): RouterHeader, the four tabs
 * (Overview / Upstreams / Errors / Transactions - the Errors tab folds the
 * prototype's error breakdown and our retry breakdown into one, the
 * transaction tab is ours, and the prototype's Traffic tab is gone), and the
 * cross-tab
 * chain-filter banner. Exported standalone so both /metrics and the
 * chrome-less /standalone route can render it. timeWindow AND the chain come
 * from the shared FiltersProvider — the chain narrows every tab here, and the
 * Upstreams page reads the same selection, so filtering on one page and
 * walking to the other keeps it. RouterOverview's "View upstreams →" drill-in
 * sets it too, and a bar on the Upstreams tab's "Errors over time" opens the
 * Errors tab on its own requests. The whole view is in the URL - chain,
 * router, tab, window and the tab's focus - so a copied link opens it
 * (`useScopeInUrl`, `lib/view-in-url.ts`). */

import { useState } from "react";
import { buildChainMetaByIndex, WINDOWS, type MetricWindow } from "@sr/shared";
import { useFilters } from "@/components/gateway/FiltersProvider";
import { useChainFilter, useChainOptions, withMutedRows } from "@/hooks/use-chain-options";
import { useScopeInUrl } from "@/hooks/use-scope-in-url";
import { useRouterFilter, useRouterOptions } from "@/hooks/use-router-options";
import { PageActions, RouterHeader } from "@/components/gateway/RouterHeader";
import { ChainBadge } from "@/components/gateway/ChainBadge";
import { useChainDrawer } from "@/components/gateway/ChainDrawer";
import { linkRequest } from "@/lib/request-in-url";
import { scopeFromSearch } from "@/lib/chain-drawer";
import {
  focusFromSearch, hasFocus, NO_FOCUS, sameFocus, spanNotice, viewParams, windowFromSearch, windowNotice,
  type SpanNote, type UpstreamPick, type ViewFocus,
} from "@/lib/view-in-url";
import { LinkNotice } from "./LinkNotice";
import { HeroPanel } from "./HeroPanel";
import { CurrentlyUnavailable } from "./CurrentlyUnavailable";
import { RouterOverview } from "./RouterOverview";
import { ChainTrafficByProvider } from "./ChainTrafficByProvider";
import { ChainAvailability } from "./ChainAvailability";
import { ErrorsBreakdown, type ErrorsFocus, type ErrorsJump } from "./ErrorsBreakdown";
import { TransactionLog } from "./TransactionLog";
import { UpstreamMetricsTab } from "./upstream/UpstreamMetricsTab";

/** The first is the default, and the only one the URL leaves out. */
const TABS = ["metrics", "upstreams", "errors", "transactions"] as const;
type Tab = (typeof TABS)[number];

/** Something in a link the page couldn't open as it was: its times, or its window. */
type LinkNote = { span: SpanNote } | { window: string };

export function MetricsView() {
  const { timeWindow, setTimeWindow: saveWindow, linkWindow, windowSettled } = useFilters();
  const { chain, select: selectChain } = useChainFilter();
  // With the chains drawer open, the drawer is the chain and router control.
  const { visible: drawerOpen } = useChainDrawer();
  const [tab, setTab] = useState<Tab>("metrics");
  const activeChain = chain;
  const setChainFilter = (v: string) => selectChain(v === "all" ? null : v);

  /* What is in focus inside the tab - the Overview's open router row and its
     tile, the Upstreams tab's upstream, the Errors list's upstream and times -
     in the URL beside the tab (lib/view-in-url.ts). `linked`: it came from a
     link and nobody has changed it since, so a part of it that no longer
     exists is said rather than quietly swapped. */
  const [focus, setFocus] = useState<ViewFocus>(NO_FOCUS);
  const [linked, setLinked] = useState(false);
  /** What the page says about a link it couldn't open as it was. */
  const [notices, setNotices] = useState<LinkNote[]>([]);
  const byHand = (f: (prev: ViewFocus) => ViewFocus) => { setFocus(f); setLinked(false); setNotices([]); };
  /* What the Errors tab opens on: a bar's requests or a link's, until the
     next one - `seq` remounts it. Its own filters report back into `focus`. */
  const [errorsOpen, setErrorsOpen] = useState<{ seq: number; focus: ErrorsFocus | null }>({ seq: 0, focus: null });
  const openErrorsOn = (f: ErrorsFocus | null) => setErrorsOpen((o) => ({ seq: o.seq + 1, focus: f }));
  /* Picking a tab yourself clears the focus - "Errors" from the tab bar is
     the whole window, as it always was - and a request in the URL is the
     tab's it was opened on (`?request=`): another tab drops it. */
  const pickTab = (t: Tab) => {
    if (t !== tab) linkRequest(null);
    setTab(t);
    byHand(() => NO_FOCUS);
    openErrorsOn(null);
  };
  const setTimeWindow = (w: MetricWindow) => { saveWindow(w); setNotices([]); };
  /* A bar clicked on the Upstreams tab: the Errors tab opens on that
     upstream's chain, the upstream, and the bar's stretch of time. */
  const openErrors = (jump: ErrorsJump) => {
    if (jump.spec) setChainFilter(jump.spec);
    const range = { from: jump.from, to: jump.to };
    byHand(() => ({ ...NO_FOCUS, upstream: { name: jump.upstream, spec: jump.spec }, range }));
    openErrorsOn({ upstream: jump.upstream, range });
    setTab("errors");
  };

  /* Config ∪ traffic (see useChainOptions). A configured chain that has served
     nothing is offered but dimmed: every panel here would be empty for it, and
     saying so beats leaving it out of the list. */
  const { routerId, routers, scopeUnavailable, select: selectRouter } = useRouterFilter();
  const activeRouter = routers.find((r) => r.id === routerId) ?? null;
  // The chain, router, tab, window and focus are in the URL: a link opens
  // them, Back the ones before.
  const { routers: configRouters, loaded: routersLoaded } = useRouterOptions();
  useScopeInUrl({ chain, router: routerId }, { selectChain, selectRouter }, routersLoaded ? configRouters : null, {
    tab, setTab, tabs: TABS,
    // The window only once it is the viewer's for good: the saved one is read after this first renders.
    params: viewParams(tab, focus, chain, windowSettled ? timeWindow : undefined),
    adoptParams: (search, t) => {
      const said: LinkNote[] = [];
      const w = windowFromSearch(search);
      if (w.window) linkWindow(w.window);
      const shown = w.window ?? (windowSettled ? timeWindow : undefined);
      if (w.unknown) said.push({ window: w.unknown });
      const { focus: next, span } = focusFromSearch(search, t, Date.now());
      if (span) said.push({ span });
      if (t === "errors" && (t !== tab || !sameFocus(next, focus))) {
        openErrorsOn(hasFocus(next) ? { upstream: next.upstream?.name ?? null, range: next.range } : null);
      }
      setFocus(next);
      setLinked(hasFocus(next));
      setNotices(said);
      return viewParams(t, next, scopeFromSearch(search).chain, shown);
    },
    // An upstream belongs to its chain: a new chain or router opens on the first.
    onNewScope: (t) => {
      const next = t === "upstreams" ? { ...focus, upstream: null } : focus;
      setFocus(next);
      return viewParams(t, next, chain, windowSettled ? timeWindow : undefined);
    },
  });
  const { chains: chainRows } = useChainOptions();
  const routedChains = withMutedRows(chainRows, (c) => (c.hasTraffic ? false : "no traffic yet"));
  const chainObj = activeChain
    ? routedChains.find((c) => c.spec === activeChain) ?? {
        spec: activeChain,
        name: buildChainMetaByIndex(activeChain).name,
        color: buildChainMetaByIndex(activeChain).color,
      }
    : null;

  return (
    <div className="gw-page gw-metrics-inter" style={{ paddingBottom: 60 }}>
      {/* The title - the chain's own name once one is picked - and the page's
          actions beside it: refresh, the window, the logs. */}
      <div className="gw-row" style={{ justifyContent: "space-between", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {chainObj ? (
          <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 10 }}>
            <ChainBadge spec={chainObj.spec} size={24} />
            {chainObj.name}
          </h1>
        ) : (
          <h1 style={{ margin: 0 }}>Metrics</h1>
        )}
        <PageActions timeWindow={timeWindow} setTimeWindow={setTimeWindow} chainFilter={activeChain ?? "all"} />
      </div>
      {/* Beside the chains drawer the drawer picks the chain and the router. */}
      {!drawerOpen && (
        <div style={{ marginBottom: 20 }}>
          <RouterHeader chains={routedChains} chainFilter={activeChain ?? "all"} setChainFilter={setChainFilter}
            timeWindow={timeWindow} setTimeWindow={setTimeWindow} withActions={false} />
        </div>
      )}
      {/* The tabs outgrow a narrow screen: they scroll sideways rather than
          wrap each label onto two lines. */}
      <div style={{ display: "flex", borderBottom: "1px solid var(--line)", marginBottom: 24, overflowX: "auto", overflowY: "hidden" }}>
        {([["metrics", "Overview"], ["upstreams", "Upstreams"], ["errors", "Errors"], ["transactions", "Transactions"]] as [Tab, string][]).map(([k, l]) => (
          // A request in the URL is the tab's it was opened on (`?request=`): another tab drops it.
          <button key={k} onClick={() => pickTab(k)} style={{
            whiteSpace: "nowrap", flexShrink: 0,
            padding: "8px 20px", border: "none", background: "transparent",
            fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
            color: tab === k ? "var(--text)" : "var(--text-3)",
            borderBottom: tab === k ? "2px solid var(--brand)" : "2px solid transparent",
            marginBottom: -1, transition: "color 0.15s",
          }}>{l}</button>
        ))}
      </div>

      {/* Only when the chain is the whole story — a router selection implies its
          chain and its own banner says so, so two banners would say it twice.
          And not beside the chains drawer, where the picked row says it. */}
      {activeChain && !activeRouter && !drawerOpen && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "9px 14px", borderRadius: 9, background: "rgba(255,57,0,0.06)", border: "1px solid rgba(255,57,0,0.22)" }}>
          <ChainBadge spec={activeChain} size={16} />
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>Viewing <strong style={{ color: "var(--text)" }}>{chainObj ? chainObj.name : activeChain}</strong> - clear to see all chains.</span>
          <span style={{ flex: 1 }} />
          <button onClick={() => selectChain(null)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Clear filter</button>
        </div>
      )}

      {/* A router selection reaches the upstream roster for certain — those rows
          are keyed per upstream. It reaches the chain-level panels only when the
          collector attaches a per-router target label, because the router
          labels its own series with the chain and never with itself. Saying
          which of the two is happening beats letting the reader assume. */}
      {activeRouter && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20, padding: "9px 14px", borderRadius: 9, background: "var(--hover)", border: "1px solid var(--line-2)" }}>
          <ChainBadge spec={activeRouter.spec} size={16} />
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            Router <strong className="gw-mono" style={{ color: "var(--text)" }}>{activeRouter.id}</strong>
            {scopeUnavailable
              ? ` - its upstreams and failed attempts are filtered to what it declares, and the rest of the page to ${activeRouter.chainName}, its chain. Panels that aggregate by chain can't go further: no metric says which router served a request, so a second router on ${activeRouter.chainName} would be counted in with it.`
              : " - every panel is scoped to it."}
          </span>
          <span style={{ flex: 1 }} />
          <button onClick={() => selectRouter(null)} style={{ border: "none", background: "none", color: "var(--brand)", cursor: "pointer", padding: 0, fontSize: 13, fontWeight: 600, fontFamily: "inherit" }}>Clear filter</button>
        </div>
      )}

      {notices.map((n) => {
        const text = "span" in n ? spanNotice(n.span, WINDOWS[timeWindow].label) : windowNotice(n.window, WINDOWS[timeWindow].label);
        return <LinkNotice key={text}>{text}</LinkNotice>;
      })}

      {tab === "metrics" && (
        <>
          <HeroPanel tw={timeWindow} spec={activeChain} />
          <CurrentlyUnavailable />
          {activeChain && <ChainTrafficByProvider spec={activeChain} timeWindow={timeWindow} />}
          {activeChain && <ChainAvailability spec={activeChain} timeWindow={timeWindow} />}
          <RouterOverview chainFilter={activeChain} timeWindow={timeWindow} onChainClick={(ch) => { setChainFilter(ch); pickTab("upstreams"); }}
            drill={{ row: focus.expand, tile: focus.tile }} linked={linked}
            onDrill={(d) => byHand((f) => ({ ...f, expand: d.row, tile: d.tile }))} />
        </>
      )}
      {tab === "upstreams" && (
        <UpstreamMetricsTab timeWindow={timeWindow} chainFilter={activeChain} onOpenErrors={openErrors}
          selected={focus.upstream} linked={linked} onSelect={(p: UpstreamPick) => byHand((f) => ({ ...f, upstream: p }))} />
      )}
      {tab === "errors" && (
        <ErrorsBreakdown key={errorsOpen.seq} chainFilter={activeChain} win={timeWindow} focus={errorsOpen.focus}
          onFocus={(e) => byHand((f) => ({ ...f, upstream: e.upstream ? { name: e.upstream, spec: activeChain } : null, range: e.range }))} />
      )}
      {tab === "transactions" && <TransactionLog chainFilter={activeChain} win={timeWindow} />}
    </div>
  );
}
