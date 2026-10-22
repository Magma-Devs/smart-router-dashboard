"use client";

import useSWR from "swr";
import { apiGet } from "@/lib/api-client";
import { pollMsForKey } from "@/lib/poll";

/**
 * Thin SWR wrapper around the dashboard API. Polls realtime panels, a metrics
 * read over a window no faster than the window's cadence (`pollMsForKey`).
 * While a new path loads, the last path's data stays up unless
 * `keepPreviousData` is false - off where showing one query's data under
 * another would mislead.
 */
export function useApi<T>(path: string | null, refreshMs = 15000, { keepPreviousData = true }: { keepPreviousData?: boolean } = {}) {
  return useSWR<T>(path, (p: string) => apiGet<T>(p), {
    refreshInterval: path ? pollMsForKey(path, refreshMs) : 0,
    revalidateOnFocus: false,
    keepPreviousData,
  });
}
