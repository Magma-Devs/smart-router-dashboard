/**
 * Grouping the Errors list: requests that failed the same way become one
 * line - "Data not held at blockfrost on Cardano, 51 requests" - instead of
 * 51 rows of the same thing. A burst (a provider down, a client sending
 * "nonce too low") is one problem, and should read as one.
 *
 * A group is: the chain, the error that decided the request, who caused it,
 * and whether the client received it. The deciding error is the failed try
 * whose answer went back to the client, else the last failed try, else the
 * request's own code (a write the router couldn't settle names one with no
 * failed try). Who caused it:
 *  - the client's request, when the router's code says so: a code the
 *    catalogue files under the request or the chain's rules (invalid params,
 *    nonce too low, already known), or a USER_* code it doesn't file under a
 *    provider. One group whichever provider answered: a bad request is bad at
 *    every provider. A CHAIN_* code can be a provider's (state pruned, block
 *    not found: data that provider doesn't hold), so the prefix alone never
 *    makes one the request's;
 *  - every provider, when two or more failed the request: the same error at
 *    each, or different ones ("Every provider failed"), which is pinned to
 *    the top - nothing came back that the client could use;
 *  - else the provider that gave it.
 * The relay cache ("Cached") is not a provider here.
 *
 * Pure: the list's rows in, groups out. It groups only the rows the list has
 * loaded - the newest 300 - and the view says which minutes they cover.
 */
import { explainRouterError, type ErrorRequestRow } from "@sr/shared";
import { blankIds, codeWords, errorType, isCache } from "@/components/metrics/request-log";

/** The results a client received as an error, or with no clear outcome. */
const REACHED: ReadonlySet<ErrorRequestRow["result"]> = new Set(["error-reply", "failed", "write-unknown"]);

/** Who caused a group's error. */
export type GroupCause = "request" | "every-provider" | "all-failed" | "provider" | "none";

export interface ErrorGroup {
  key: string;
  spec: string | null;
  /** The error: a router code, the message with its numbers blanked, or "all-failed". */
  errorKey: string;
  /** The error in words: the code's, or the first request's own message. */
  errorLabel: string;
  cause: GroupCause;
  /** The provider that gave the error, for `cause: "provider"`. */
  provider: string | null;
  /** How many providers failed, for `every-provider` / `all-failed`. */
  providerCount: number;
  /** Whether the client received the error (true) or a later try recovered it (false). */
  reached: boolean;
  /** Pinned above the rest whatever its size: every provider failed with different errors. */
  pinned: boolean;
  count: number;
  /** Oldest and newest request in the group, unix ms. */
  firstMs: number;
  lastMs: number;
  /** The methods in the group, most requests first. */
  methods: { method: string; count: number }[];
  /** The group's requests, newest first. */
  rows: ErrorRequestRow[];
}

/** Codes about the client's own request rather than a provider: the same
 *  answer from any healthy, up-to-date provider (the catalogue's `request`
 *  and `chain`). An uncatalogued or undetermined code is the request's only
 *  when it is a USER_ one. */
function isRequestCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const source = explainRouterError(code)?.source;
  if (source === "request" || source === "chain") return true;
  if (source === "provider" || source === "router") return false;
  return code.startsWith("USER_");
}

/** The error that decided a request, and who caused it. */
export function decidingError(r: ErrorRequestRow): { key: string; label: string; cause: GroupCause; provider: string | null; providerCount: number } {
  const failed = r.attempts.filter((a) => a.outcome === "failed" && !isCache(a.upstream));
  const decider = failed.find((a) => a.replied) ?? failed[failed.length - 1];
  if (decider) {
    const t = errorType(decider);
    const label = decider.code && decider.code !== "UNKNOWN_ERROR" ? t.label : (decider.message ?? t.label).slice(0, 64);
    if (isRequestCode(decider.code)) return { key: t.key, label, cause: "request", provider: null, providerCount: 0 };
    const providers = new Set(failed.map((a) => a.upstream));
    if (providers.size >= 2) {
      const sameError = failed.every((a) => errorType(a).key === t.key);
      if (sameError) return { key: t.key, label, cause: "every-provider", provider: null, providerCount: providers.size };
      if (REACHED.has(r.result)) return { key: "all-failed", label: "Every provider failed", cause: "all-failed", provider: null, providerCount: providers.size };
    }
    return { key: t.key, label, cause: "provider", provider: decider.upstream, providerCount: 1 };
  }
  if (r.errorCode && r.errorCode !== "UNKNOWN_ERROR") {
    return { key: r.errorCode, label: codeWords(r.errorCode), cause: isRequestCode(r.errorCode) ? "request" : "none", provider: null, providerCount: 0 };
  }
  const words = r.error ?? "no error recorded";
  return { key: "err:" + blankIds(words), label: words.slice(0, 64), cause: "none", provider: null, providerCount: 0 };
}

/** The rows as groups: pinned first, then the most requests; ties go to the newest. */
export function groupErrors(rows: readonly ErrorRequestRow[]): ErrorGroup[] {
  const by = new Map<string, ErrorGroup & { methodCounts: Map<string, number> }>();
  for (const r of rows) {
    const d = decidingError(r);
    const reached = REACHED.has(r.result);
    const who = d.cause === "provider" ? `p:${d.provider}` : d.cause;
    const key = [r.spec ?? "", d.key, who, reached ? "1" : "0"].join("|");
    let g = by.get(key);
    if (!g) {
      g = {
        key, spec: r.spec, errorKey: d.key, errorLabel: d.label, cause: d.cause, provider: d.provider, providerCount: d.providerCount,
        reached, pinned: d.cause === "all-failed", count: 0, firstMs: r.time, lastMs: r.time, methods: [], rows: [], methodCounts: new Map(),
      };
      by.set(key, g);
    }
    g.count++;
    g.rows.push(r);
    g.providerCount = Math.max(g.providerCount, d.providerCount);
    g.firstMs = Math.min(g.firstMs, r.time);
    g.lastMs = Math.max(g.lastMs, r.time);
    g.methodCounts.set(r.method, (g.methodCounts.get(r.method) ?? 0) + 1);
  }
  const groups: ErrorGroup[] = [...by.values()].map(({ methodCounts, ...g }) => ({
    ...g,
    methods: [...methodCounts].map(([method, count]) => ({ method, count })).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
    rows: g.rows.sort((a, b) => b.time - a.time),
  }));
  return groups.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.count - a.count || b.lastMs - a.lastMs);
}

/**
 * When a group's requests happened, as `n` counts across `[fromMs, toMs]` -
 * the group's small bar chart, on the same span for every group so bursts
 * line up. A request outside the span lands in the nearest end bucket; one
 * with no time is left out.
 */
export function groupBuckets(rows: readonly { time: number }[], fromMs: number, toMs: number, n: number): number[] {
  const out = new Array<number>(Math.max(1, n)).fill(0);
  const span = toMs - fromMs;
  for (const r of rows) {
    if (!Number.isFinite(r.time)) continue;
    const k = span > 0 ? Math.floor(((r.time - fromMs) / span) * out.length) : out.length - 1;
    out[Math.min(out.length - 1, Math.max(0, k))]!++;
  }
  return out;
}
