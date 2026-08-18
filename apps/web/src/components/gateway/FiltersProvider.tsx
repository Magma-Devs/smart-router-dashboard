"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_WINDOW, isMetricWindow, type MetricWindow } from "@sr/shared";

/** The filters every dashboard screen shares, in two lifetimes.
 *
 *  **The time window persists** (localStorage `sr:window`, read once on mount,
 *  SSR-safe). It is a viewing preference — how far back you like to look — not
 *  a claim about what you're looking at, so carrying it between screens is a
 *  convenience rather than a surprise.
 *
 *  **The chain and the router belong to the page you set them on.** They narrow
 *  WHICH data a screen shows, and a narrowing that outlives its screen is a
 *  trap: you arrive somewhere showing a slice of reality with no memory of
 *  having asked for one. So they are stamped with the pathname that set them and
 *  read as empty anywhere else, so no frame of the new page ever renders under the
 *  old page's filter; an effect then retires the stamp, so coming BACK to a page
 *  starts clean too rather than restoring what you left. Tab switches WITHIN a
 *  page keep them; the tabs are one screen. Nothing is persisted: a filter that
 *  survives a reload is the same trap with a longer fuse.
 *
 *  Both router fields move together, because they are two halves of one
 *  selection: `router` is the collector's target label (narrows the PromQL — the
 *  api's `?router=`), `routerId` is the config router id (filters rows —
 *  `?routerId=`). See `hooks/use-router-options.ts`; nothing sets one without
 *  the other. `chain` is a spec index (`ETH1`), the value `?spec=` takes. */

const STORAGE_KEY = "sr:window";

/** The narrowing filters, and the page they were set on. */
interface Narrowing {
  path: string;
  chain: string | null;
  router: string | null;
  routerId: string | null;
}

const NOTHING = { chain: null, router: null, routerId: null } as const;

interface FiltersContextValue {
  timeWindow: MetricWindow;
  setTimeWindow: (w: MetricWindow) => void;
  /** Scope-label value of the selected router; null = every router. */
  router: string | null;
  setRouter: (r: string | null) => void;
  /** Spec index of the selected chain; null = every chain. */
  chain: string | null;
  setChain: (c: string | null) => void;
  /**
   * Config router id of the selected router; null = every router. The OTHER
   * router axis: `router` above is the collector's target label and narrows the
   * PromQL, this one identifies an entry in the mounted values file and filters
   * rows by what that entry declares. One chain can have several config
   * routers, and no series carries which — see `hooks/use-router-options.ts`.
   */
  routerId: string | null;
  setRouterId: (id: string | null) => void;
  /** `&router=…` (or "") to append to a metrics URL that already has params. */
  scopeQ: string;
  /** Same scope for a URL whose param list may be empty. */
  withScope: (url: string) => string;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const [timeWindow, setTimeWindowState] = useState<MetricWindow>(DEFAULT_WINDOW);
  const [narrowing, setNarrowing] = useState<Narrowing>({ path: "", ...NOTHING });
  const pathname = usePathname();

  useEffect(() => {
    // Read once on mount — this effect only runs client-side, so no SSR access.
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && isMetricWindow(saved)) setTimeWindowState(saved);
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

  // Only the CURRENT page's selection is visible — this is what makes the
  // reset instant: on the first render after navigating, the stamp already
  // fails to match, so no frame renders under the previous page's filter.
  const active = narrowing.path === pathname ? narrowing : NOTHING;

  // …and then the stamp is retired, so coming BACK to a page starts clean too.
  // Without this the state kept `path: "/metrics"` while you were on
  // /upstreams, and returning silently restored the filter you left behind —
  // the same trap, sprung on the way home. Synchronising with the router's
  // location is what an effect is for; the functional update returns `prev`
  // unchanged when the stamp already matches, so React bails out rather than
  // re-rendering the tree on every navigation.
  useEffect(() => {
    setNarrowing((prev) => (prev.path === pathname ? prev : { path: pathname, ...NOTHING }));
  }, [pathname]);

  const update = useCallback(
    (patch: Partial<Omit<Narrowing, "path">>) => {
      setNarrowing((prev) => ({
        // Editing one filter must not resurrect another page's leftovers.
        ...(prev.path === pathname ? prev : NOTHING),
        path: pathname,
        ...patch,
      }));
    },
    [pathname],
  );

  const setRouter = useCallback((r: string | null) => update({ router: r }), [update]);
  const setChain = useCallback((c: string | null) => update({ chain: c }), [update]);
  const setRouterId = useCallback((id: string | null) => update({ routerId: id }), [update]);

  const value = useMemo(() => {
    const param = active.router ? `router=${encodeURIComponent(active.router)}` : "";
    return {
      timeWindow,
      setTimeWindow,
      router: active.router,
      setRouter,
      chain: active.chain,
      setChain,
      routerId: active.routerId,
      setRouterId,
      scopeQ: param ? `&${param}` : "",
      // Keeps the URL (and so the SWR cache key) clean when nothing is scoped.
      withScope: (url: string) => (param ? `${url}${url.includes("?") ? "&" : "?"}${param}` : url),
    };
  }, [timeWindow, setTimeWindow, active, setRouter, setChain, setRouterId]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used within <FiltersProvider>");
  return ctx;
}
