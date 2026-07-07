"use client";

import useSWR from "swr";
import { apiGet } from "@/lib/api-client";

/** Thin SWR wrapper around the dashboard API. Polls realtime panels. */
export function useApi<T>(path: string | null, refreshMs = 15000) {
  return useSWR<T>(path, (p: string) => apiGet<T>(p), {
    refreshInterval: refreshMs,
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
}
