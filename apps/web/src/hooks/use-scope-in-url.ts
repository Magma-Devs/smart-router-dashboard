"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { resolveScope, scopeFromSearch, tabFromSearch, type PageScope } from "@/lib/chain-drawer";

interface ScopeActions {
  selectChain: (spec: string | null) => void;
  /** Picks a router and its chain; null keeps the chain. */
  selectRouter: (id: string | null) => void;
}

/** The page's tabs; the first is the default and stays out of the URL. */
export interface PageTabs<T extends string> {
  tab: T;
  setTab: (tab: T) => void;
  tabs: readonly [T, ...T[]];
}

/**
 * The page's chain, router and tab in its URL
 * (`?chain=ETH1&router=eth-prod&tab=upstreams`), both ways. A link opens the
 * page on them. A change of chain or router - the drawer, a dropdown, a
 * drill-in - becomes a history entry, so Back returns to the one before, tab
 * included; a change of tab alone rewrites the entry it is on, since the tabs
 * are one screen. A URL that already means the current scope but spells it
 * otherwise (a malformed value, an unknown router, a router under the wrong
 * chain) is corrected in place, so Back never lands on a copy of the same view.
 *
 * They stay the page's own, as `FiltersProvider` wants: another page's URL has
 * none, so neither follows you to the next screen, and Back to another page
 * leaves the filters alone while that page loads.
 *
 * `routers` is the config's list, null until it and the collector's scope list
 * have answered: a router from the URL is picked only once the config says
 * which chain it serves and the scope list says which scrape target it is.
 * One the config doesn't have reads as none; see `resolveScope`. A pick made
 * while the router waits wins over the URL.
 */
export function useScopeInUrl<T extends string>(
  scope: PageScope,
  actions: ScopeActions,
  routers: { id: string; spec: string }[] | null,
  view: PageTabs<T>,
): void {
  const path = usePathname();
  // Read at event time (Back/Forward, the config arriving), so refreshed after every render.
  const latest = useRef({ scope, actions, routers, path, view });
  useEffect(() => {
    latest.current = { scope, actions, routers, path, view };
  });
  /** What the URL asked for, until the filters show it: nothing is written back meanwhile. */
  const pending = useRef<PageScope | undefined>(undefined);
  /** Where the URL's own steps leave the filters while its router waits for the config. */
  const interim = useRef<PageScope | undefined>(undefined);

  // The filters and the tab into the URL, from the refs.
  const write = useCallback(() => {
    const { scope: now, routers: known, view: v } = latest.current;
    const tab = v.tab === v.tabs[0] ? null : v.tab;
    const url = new URL(window.location.href);
    const q = url.searchParams;
    if (q.get("chain") === now.chain && q.get("router") === now.router && q.get("tab") === tab) return;
    const meant = resolveScope(scopeFromSearch(url.search), known);
    const same = meant.chain === now.chain && meant.router === now.router;
    for (const [key, value] of [["chain", now.chain], ["router", now.router], ["tab", tab]] as const) {
      if (value) q.set(key, value);
      else q.delete(key);
    }
    if (same) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, []);

  // The URL into the filters and, unless only its router is still owed, the tab.
  const adopt = useCallback((withTab: boolean) => {
    const { scope: now, actions: act, routers: known, path: here, view: v } = latest.current;
    // Back/Forward to another page: that page's URL is not this one's scope.
    if (window.location.pathname !== here) return;
    const tab = withTab ? tabFromSearch(window.location.search, v.tabs) : v.tab;
    if (tab !== v.tab) {
      v.setTab(tab);
      // Shown from the next render; a write before then must carry it already.
      latest.current = { ...latest.current, view: { ...v, tab } };
    }
    const want = resolveScope(scopeFromSearch(window.location.search), known);
    if (want.chain === now.chain && want.router === now.router) {
      pending.current = undefined;
      write(); // the URL may spell it otherwise (an unknown router)
      return;
    }
    pending.current = want;
    if (want.router !== null && known !== null) {
      interim.current = want;
      act.selectRouter(want.router);
      return;
    }
    // The router, if any, follows once the config is read (the effect below).
    interim.current = { chain: want.chain, router: null };
    if (now.router !== null) act.selectRouter(null);
    act.selectChain(want.chain);
  }, [write]);

  // URL → filters: on arrival, and on Back/Forward.
  useEffect(() => {
    const onPop = () => adopt(true);
    onPop();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [adopt]);

  // A router from the URL, once the config has been read - unless the filters
  // moved off where the URL left them meanwhile: that pick wins. The tab was
  // read on arrival, and may have been changed by hand since.
  const loaded = routers !== null;
  useEffect(() => {
    if (!loaded || !pending.current?.router) return;
    const { scope: now } = latest.current;
    const mid = interim.current;
    if (mid !== undefined && (mid.chain !== now.chain || mid.router !== now.router)) {
      pending.current = undefined;
      write();
      return;
    }
    adopt(false);
  }, [loaded, adopt, write]);

  // Filters → URL: every change, wherever it came from.
  useEffect(() => {
    const want = pending.current;
    if (want !== undefined) {
      if (want.chain !== scope.chain || want.router !== scope.router) return;
      // Shown now; the URL may still spell it otherwise (`?router=` alone).
      pending.current = undefined;
    }
    write();
  }, [scope.chain, scope.router, view.tab, write]);
}
