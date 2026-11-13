/**
 * When a failed api read asks again. Pure, so the rules are tested without a
 * browser; `useApi` hands the delay to SWR.
 */

/** The longest a `Retry-After` is waited out. A longer one is either a mistake
 *  or a date far in the future, and a read that never asks again looks stuck. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** The soonest a rate-limited read asks again, whatever the header says. */
const MIN_RETRY_AFTER_MS = 1_000;

/**
 * A `Retry-After` value as milliseconds from `now`: delta-seconds or an
 * HTTP-date (RFC 9110 §10.2.3). Null when it is absent or neither.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  // A date names its day and month. `Date.parse` alone takes "-5" and "1.5"
  // for years.
  if (!/[a-z]/i.test(raw)) return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** What a failed read carries that decides its retry: the status, and for a
 *  429 when the api said to come back (`ApiError` in `api-client.ts`). */
interface FailedRead {
  statusCode?: unknown;
  retryAt?: unknown;
}

/** Whether the api turned a read away for now, rather than failing it. */
export function isRateLimited(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as FailedRead).statusCode === 429;
}

/**
 * How long a failed read waits before it asks again.
 *
 *  - **429**: until the api's `Retry-After`, which `ApiError.retryAt` carries.
 *    Asking sooner is refused again and spends the same allowance. Held
 *    between a second and ten minutes.
 *  - **Anything else**, or a 429 that named no time: SWR's own exponential
 *    backoff, unchanged — the interval doubled per attempt up to 2^8, with
 *    jitter so a page's panels do not all ask again in the same instant.
 */
export function errorRetryDelayMs(
  err: unknown,
  retryCount: number,
  intervalMs: number,
  now = Date.now(),
  random: () => number = Math.random,
): number {
  if (isRateLimited(err)) {
    const retryAt = (err as FailedRead).retryAt;
    if (typeof retryAt === "number" && Number.isFinite(retryAt)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, retryAt - now));
    }
  }
  return ~~((random() + 0.5) * (1 << Math.min(retryCount, 8))) * intervalMs;
}
