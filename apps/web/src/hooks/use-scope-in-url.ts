"use client";

import { useCallback, useEffect, useRef } from "react";
import { scopeFromSearch, type PageScope } from "@/lib/chain-drawer";

interface ScopeActions {
  selectChain: (spec: string | null) => void;
  /** Picks a router and its chain; null keeps the chain. */
  selectRouter: (id: string | null) => void;
}

/**
 * The page's chain and router in its URL (`?chain=ETH1&router=eth-prod`), both
 * ways. A link opens the page on them, and every change - the drawer, a
 * dropdown, a drill-in - becomes a history entry, so Back returns to the one
 * before.
 *
 * They stay the page's own, as `FiltersProvider` wants: another page's URL has
 * none, so neither follows you to the next screen.
 *
 * `routers` is the config's list, null until it has been read: a router from
 * the URL is picked only once the config says which chain it serves, and one
 * the config doesn't have reads as none.
 */
export function useScopeInUrl(
  scope: PageScope,
  actions: ScopeActions,
  routers: { id: string; spec: string }[] | null,
): void {
  // Read at event time (Back/Forward, the config arriving), so refreshed after every render.
  const latest = useRef({ scope, actions, routers });
  useEffect(() => {
    latest.current = { scope, actions, routers };
  });
  /** What the URL asked for, until the filters show it: nothing is written back meanwhile. */
  const pending = useRef<PageScope | undefined>(undefined);

  // Reads the refs when called, so one function serves every call.
  const adopt = useCallback(() => {
    const { scope: now, actions: act, routers: known } = latest.current;
    let want = scopeFromSearch(window.location.search);
    if (want.router !== null && known !== null) {
      const r = known.find((x) => x.id === want.router);
      want = r ? { chain: r.spec, router: r.id } : { chain: want.chain, router: null };
    }
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
      if (want.chain === scope.chain && want.router === scope.router) pending.current = undefined;
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get("chain") === scope.chain && url.searchParams.get("router") === scope.router) return;
    for (const [key, value] of [["chain", scope.chain], ["router", scope.router]] as const) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.pushState(null, "", url);
  }, [scope.chain, scope.router]);
}
