"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isMetricWindow, type MetricWindow } from "@sr/shared";

/** Page-level time-window filter, shared across the dashboard screens.
 *  Persisted to localStorage ("sr:window"); read once on mount (SSR-safe). */

const STORAGE_KEY = "sr:window";

interface FiltersContextValue {
  timeWindow: MetricWindow;
  setTimeWindow: (w: MetricWindow) => void;
}

const FiltersContext = createContext<FiltersContextValue | null>(null);

export function FiltersProvider({ children }: { children: React.ReactNode }) {
  const [timeWindow, setTimeWindowState] = useState<MetricWindow>("1d");

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

  const value = useMemo(() => ({ timeWindow, setTimeWindow }), [timeWindow, setTimeWindow]);

  return <FiltersContext.Provider value={value}>{children}</FiltersContext.Provider>;
}

export function useFilters(): FiltersContextValue {
  const ctx = useContext(FiltersContext);
  if (!ctx) throw new Error("useFilters must be used within <FiltersProvider>");
  return ctx;
}
