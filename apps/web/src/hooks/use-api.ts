"use client";

import { useEffect, useSyncExternalStore } from "react";
import useSWR from "swr";
import { apiGet } from "@/lib/api-client";
import { getIdleResumes, idlePhaseNow, isPollingPaused, subscribeIdle, watchPoll } from "@/lib/idle-store";
import { gatedPollMs, pollMsForKey } from "@/lib/poll";

const noResumes = () => 0;

// One interval function per interval and return from idle. SWR re-arms a
// poll's timer when the function changes, so a resume restarts every poll
// at the normal cadence instead of after the slowed tick still pending.
let timersFor = 0;
const timers = new Map<number, () => number>();
function pollTimer(ms: number, resumes: number): number | (() => number) {
  if (ms <= 0) return 0;
  if (resumes !== timersFor) {
    timers.clear();
    timersFor = resumes;
  }
  let timer = timers.get(ms);
  if (!timer) {
    timer = () => gatedPollMs(ms, idlePhaseNow());
    timers.set(ms, timer);
  }
  return timer;
}

/**
 * Thin SWR wrapper around the dashboard API. Polls realtime panels, a metrics
 * read over a window no faster than the window's cadence (`pollMsForKey`),
 * every poll through the idle gate: 4x slower after 10 minutes with nobody at
 * the page, paused after an hour (`lib/idle-store.ts`). While a new path
 * loads, the last path's data stays up unless `keepPreviousData` is false -
 * off where showing one query's data under another would mislead.
 */
export function useApi<T>(path: string | null, refreshMs = 15000, { keepPreviousData = true }: { keepPreviousData?: boolean } = {}) {
  const ms = path ? pollMsForKey(path, refreshMs) : 0;
  const resumes = useSyncExternalStore(subscribeIdle, getIdleResumes, noResumes);
  // What a return from idle re-reads: keys that poll.
  useEffect(() => (path && ms > 0 ? watchPoll(path) : undefined), [path, ms]);
  return useSWR<T>(path, (p: string) => apiGet<T>(p), {
    refreshInterval: pollTimer(ms, resumes),
    isPaused: isPollingPaused,
    revalidateOnFocus: false,
    keepPreviousData,
  });
}
