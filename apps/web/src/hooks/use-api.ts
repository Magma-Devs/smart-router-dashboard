"use client";

import { useEffect, useSyncExternalStore } from "react";
import useSWR from "swr";
import { apiGet } from "@/lib/api-client";
import { getIdleResumes, idlePhaseNow, isPollingPaused, subscribeIdle, watchPoll } from "@/lib/idle-store";
import { gatedPollMs, pollMsForKey } from "@/lib/poll";
import { errorRetryDelayMs } from "@/lib/retry";
import { readEnded, readStarted, trackViewProblem } from "@/lib/usage";
import { ApiError } from "@/lib/api-client";

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

/** A view slower than this is noted in the usage data (MAG-5373). */
const SLOW_VIEW_MS = 10_000;

/** `apiGet`, noting a read that failed or took over 10 s in the usage data. */
async function timedGet<T>(path: string): Promise<T> {
  const t0 = Date.now();
  const read = readStarted();
  try {
    const out = await apiGet<T>(path);
    const ms = Date.now() - t0;
    if (ms > SLOW_VIEW_MS) trackViewProblem(path, "slow", ms / 1000);
    readEnded(read, true);
    return out;
  } catch (err) {
    // A refusal of what was asked (400, 404) is the request's, not the screen's:
    // only a server error or a read that never got an answer is a problem.
    const serverSide = !(err instanceof ApiError) || err.statusCode >= 500;
    if (serverSide) trackViewProblem(path, "did-not-load", (Date.now() - t0) / 1000);
    readEnded(read, !serverSide);
    throw err;
  }
}

/**
 * Thin SWR wrapper around the dashboard API. Polls realtime panels, a metrics
 * read over a window no faster than the window's cadence (`pollMsForKey`),
 * every poll through the idle gate: 4x slower after 10 minutes with nobody at
 * the page, paused after an hour (`lib/idle-store.ts`). While a new path
 * loads, the last path's data stays up unless `keepPreviousData` is false -
 * off where showing one query's data under another would mislead. A failed
 * read asks again on SWR's backoff, and a 429 when the api says
 * (`lib/retry.ts`).
 */
export function useApi<T>(path: string | null, refreshMs = 15000, { keepPreviousData = true }: { keepPreviousData?: boolean } = {}) {
  const ms = path ? pollMsForKey(path, refreshMs) : 0;
  const resumes = useSyncExternalStore(subscribeIdle, getIdleResumes, noResumes);
  // What a return from idle re-reads: keys that poll.
  useEffect(() => (path && ms > 0 ? watchPoll(path) : undefined), [path, ms]);
  return useSWR<T>(path, (p: string) => timedGet<T>(p), {
    refreshInterval: pollTimer(ms, resumes),
    isPaused: isPollingPaused,
    revalidateOnFocus: false,
    keepPreviousData,
    // SWR's own backoff, except that a 429 waits as long as the api asks.
    onErrorRetry: (err, _key, config, revalidate, opts) => {
      if (config.errorRetryCount !== undefined && opts.retryCount > config.errorRetryCount) return;
      setTimeout(() => void revalidate(opts), errorRetryDelayMs(err, opts.retryCount, config.errorRetryInterval));
    },
  });
}
