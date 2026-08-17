"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isMetricWindow, type MetricWindow } from "@sr/shared";

/** Page-level filters shared across the dashboard screens — the time window,
 *  the router scope and the chain. All three persist to localStorage
 *  ("sr:window" / "sr:router" / "sr:chain"); read once on mount (SSR-safe).
 *
 *  The router scope answers a question the metrics alone can't: the router
 *  labels its series with the CHAIN, so several routers serving one chain sum
 *  together. Picking one restricts every query to its scrape target (see the
 *  api's `?router=` param). `null` = all routers, the default.
 *
 *  The chain lives here for a plainer reason: the Metrics page and the
 *  Upstreams page both filter by it, and holding it in page state meant
 *  narrowing one and walking to the other silently showed everything again —
 *  while the two controls beside it kept their selection. `null` = all
 *  chains. It is a spec index (`ETH1`), the same value `?spec=` takes. */

const STORAGE_KEY = "sr:window";
const ROUTER_KEY = "sr:router";
const CHAIN_KEY = "sr:chain";

interface FiltersContextValue {
  timeWindow: MetricWindow;
  setTimeWindow: (w: MetricWindow) => void;
  /** Scope-label value of the selected router; null = every router. */
  router: string | null;
  setRouter: (r: string | null) => void;
  /** Spec index of the selected chain; null = every chain. */
  chain: string | null;
  setChain: (c: string | null) => void;
  /** `&router=…` (or "") to append to a metrics URL that already has params. */
  scopeQ: string;
  /** Same scope for a URL whose param list may be empty. */
  withScope: (url: string) => string;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const [timeWindow, setTimeWindowState] = useState<MetricWindow>("1d");
  const [router, setRouterState] = useState<string | null>(null);
  const [chain, setChainState] = useState<string | null>(null);

  useEffect(() => {
    // Read once on mount — this effect only runs client-side, so no SSR access.
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && isMetricWindow(saved)) setTimeWindowState(saved);
      const savedRouter = window.localStorage.getItem(ROUTER_KEY);
      if (savedRouter) setRouterState(savedRouter);
      const savedChain = window.localStorage.getItem(CHAIN_KEY);
      if (savedChain) setChainState(savedChain);
    } catch {
      /* localStorage unavailable (private mode etc.) — keep the default. */
    }
  }, []);

  const setTimeWindow = useCallback((w: MetricWindow) => {
    setTimeWindowState(w);
    try {
      window.localStorage.setItem(STORAGE_KEY, w);
    } catch {
      /* best-effort persistence */
    }
  }, []);

  const setRouter = useCallback((r: string | null) => {
    setRouterState(r);
    try {
      if (r) window.localStorage.setItem(ROUTER_KEY, r);
      else window.localStorage.removeItem(ROUTER_KEY);
    } catch {
      /* best-effort persistence */
    }
  }, []);

  const setChain = useCallback((c: string | null) => {
    setChainState(c);
    try {
      if (c) window.localStorage.setItem(CHAIN_KEY, c);
      else window.localStorage.removeItem(CHAIN_KEY);
    } catch {
      /* best-effort persistence */
    }
  }, []);

  const value = useMemo(() => {
    const param = router ? `router=${encodeURIComponent(router)}` : "";
    return {
      timeWindow,
      setTimeWindow,
      router,
      setRouter,
      chain,
      setChain,
      scopeQ: param ? `&${param}` : "",
      // Keeps the URL (and so the SWR cache key) clean when nothing is scoped.
      withScope: (url: string) => (param ? `${url}${url.includes("?") ? "&" : "?"}${param}` : url),
    };
  }, [timeWindow, setTimeWindow, router, setRouter, chain, setChain]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used within <FiltersProvider>");
  return ctx;
}
