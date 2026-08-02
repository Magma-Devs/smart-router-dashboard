"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isMetricWindow, type MetricWindow } from "@sr/shared";

/** Page-level filters shared across the dashboard screens — the time window
 *  and the router scope. Both persist to localStorage ("sr:window" /
 *  "sr:router"); read once on mount (SSR-safe).
 *
 *  The router scope answers a question the metrics alone can't: the router
 *  labels its series with the CHAIN, so several routers serving one chain sum
 *  together. Picking one restricts every query to its scrape target (see the
 *  api's `?router=` param). `null` = all routers, the default. */

const STORAGE_KEY = "sr:window";
const ROUTER_KEY = "sr:router";

interface FiltersContextValue {
  timeWindow: MetricWindow;
  setTimeWindow: (w: MetricWindow) => void;
  /** Scope-label value of the selected router; null = every router. */
  router: string | null;
  setRouter: (r: string | null) => void;
  /** `&router=…` (or "") to append to a metrics URL that already has params. */
  scopeQ: string;
  /** Same scope for a URL whose param list may be empty. */
  withScope: (url: string) => string;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const [timeWindow, setTimeWindowState] = useState<MetricWindow>("1d");
  const [router, setRouterState] = useState<string | null>(null);

  useEffect(() => {
    // Read once on mount — this effect only runs client-side, so no SSR access.
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && isMetricWindow(saved)) setTimeWindowState(saved);
      const savedRouter = window.localStorage.getItem(ROUTER_KEY);
      if (savedRouter) setRouterState(savedRouter);
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

  const value = useMemo(() => {
    const param = router ? `router=${encodeURIComponent(router)}` : "";
    return {
      timeWindow,
      setTimeWindow,
      router,
      setRouter,
      scopeQ: param ? `&${param}` : "",
      // Keeps the URL (and so the SWR cache key) clean when nothing is scoped.
      withScope: (url: string) => (param ? `${url}${url.includes("?") ? "&" : "?"}${param}` : url),
    };
  }, [timeWindow, setTimeWindow, router, setRouter]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used within <FiltersProvider>");
  return ctx;
}
