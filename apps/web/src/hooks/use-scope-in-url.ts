"use client";

import { useCallback, useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { resolveScope, scopeFromSearch, type PageScope } from "@/lib/chain-drawer";

interface ScopeActions {
  selectChain: (spec: string | null) => void;
  /** Picks a router and its chain; null keeps the chain. */
  selectRouter: (id: string | null) => void;
}

/**
 * The page's chain and router in its URL (`?chain=ETH1&router=eth-prod`), both
 * ways. A link opens the page on them, and every change - the drawer, a
 * dropdown, a drill-in - becomes a history entry, so Back returns to the one
 * before. A URL that already means the current scope but spells it otherwise
 * (a malformed value, an unknown router, a router under the wrong chain) is
 * corrected in place, so Back never lands on a copy of the same view.
 *
 * They stay the page's own, as `FiltersProvider` wants: another page's URL has
 * none, so neither follows you to the next screen, and Back to another page
 * leaves the filters alone while that page loads.
 *
 * `routers` is the config's list, null until it and the collector's scope list
 * have answered: a router from the URL is picked only once the config says
 * which chain it serves and the scope list says which scrape target it is.
 * One the config doesn't have reads as none; see `resolveScope`.
 */
export function useScopeInUrl(
  scope: PageScope,
  actions: ScopeActions,
  routers: { id: string; spec: string }[] | null,
): void {
  const path = usePathname();
  // Read at event time (Back/Forward, the config arriving), so refreshed after every render.
  const latest = useRef({ scope, actions, routers, path });
  useEffect(() => {
    latest.current = { scope, actions, routers, path };
  });
  /** What the URL asked for, until the filters show it: nothing is written back meanwhile. */
  const pending = useRef<PageScope | undefined>(undefined);

  // Reads the refs when called, so one function serves every call.
  const adopt = useCallback(() => {
    const { scope: now, actions: act, routers: known, path: here } = latest.current;
    // Back/Forward to another page: that page's URL is not this one's scope.
    if (window.location.pathname !== here) return;
    const want = resolveScope(scopeFromSearch(window.location.search), known);
    if (want.chain === now.chain && want.router === now.router) {
      pending.current = undefined;
      return;
    }
    pending.current = want;
    if (want.router !== null && known !== null) {
      act.selectRouter(want.router);
      return;
    }
    // The router, if any, follows once the config is read (the effect below).
    if (now.router !== null) act.selectRouter(null);
    act.selectChain(want.chain);
  }, []);

  // URL → filters: on arrival, and on Back/Forward.
  useEffect(() => {
    adopt();
    window.addEventListener("popstate", adopt);
    return () => window.removeEventListener("popstate", adopt);
  }, [adopt]);

  // A router from the URL, once the config has been read.
  const loaded = routers !== null;
  useEffect(() => {
    if (loaded && pending.current?.router) adopt();
  }, [loaded, adopt]);

  // Filters → URL: every change, wherever it came from.
  useEffect(() => {
    const want = pending.current;
    if (want !== undefined) {
      if (want.chain !== scope.chain || want.router !== scope.router) return;
      // Shown now; the URL may still spell it otherwise (`?router=` alone).
      pending.current = undefined;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get("chain") === scope.chain && url.searchParams.get("router") === scope.router) return;
    const meant = resolveScope(scopeFromSearch(url.search), latest.current.routers);
    const same = meant.chain === scope.chain && meant.router === scope.router;
    for (const [key, value] of [["chain", scope.chain], ["router", scope.router]] as const) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    if (same) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
  }, [scope.chain, scope.router]);
}
