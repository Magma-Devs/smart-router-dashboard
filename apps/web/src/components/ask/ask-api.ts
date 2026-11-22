import type { SWRConfiguration } from "swr";
import { ApiError, apiGet, apiPost, apiSend } from "@/lib/api-client";
import { idlePhaseNow, isPollingPaused } from "@/lib/idle-store";
import { gatedPollMs } from "@/lib/poll";
import { errorRetryDelayMs } from "@/lib/retry";

/** The token is only a browser's existing dashboard session. This binding is
 * not authorization; the API still verifies the current session and ownership.
 * Undefined with accounts off, where no request carries a session. */
export function createAskApi(sessionToken: string | undefined) {
  return {
    get: <T>(path: string) => apiGet<T>(path, sessionToken),
    post: <T>(path: string, body: unknown) => apiPost<T>(path, body, sessionToken),
    send: <T>(method: "PATCH", path: string, body: unknown) =>
      apiSend<T>(method, path, body, sessionToken),
  };
}

/**
 * How an Ask read polls: `ms` (or `ms` of the newest data) through the idle
 * gate, as `useApi` does, so a chat left open slows and then stops with the
 * rest of the page. A failed read asks again on SWR's backoff (a 429 when the
 * api says); a refusal (disabled, signed out, not found) is not asked again.
 */
export function askPoll<T>(ms: number | ((data: T | undefined) => number)): SWRConfiguration<T> {
  return {
    refreshInterval: (data) => {
      const base = typeof ms === "function" ? ms(data) : ms;
      return base > 0 ? gatedPollMs(base, idlePhaseNow()) : 0;
    },
    isPaused: isPollingPaused,
    onErrorRetry: (err, _key, config, revalidate, opts) => {
      if (err instanceof ApiError && err.statusCode < 500 && err.statusCode !== 429) return;
      if (config.errorRetryCount !== undefined && opts.retryCount > config.errorRetryCount) return;
      setTimeout(
        () => void revalidate(opts),
        errorRetryDelayMs(err, opts.retryCount, config.errorRetryInterval),
      );
    },
  };
}
