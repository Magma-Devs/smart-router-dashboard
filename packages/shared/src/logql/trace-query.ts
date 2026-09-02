/**
 * The one LogQL query this feature runs, and the validation that makes it safe
 * to build by concatenation.
 */

/** Widening search windows, in seconds — smallest first, stop at the first hit.
 *  The last is the bundled Loki's full retention (168h), so there is no point
 *  looking further back. */
export const TRACE_SEARCH_WINDOWS_SEC = [900, 3600, 21600, 86400, 604800] as const;

/**
 * A router GUID is `strconv.FormatUint(rand.Uint64(), 10)` — decimal digits,
 * never more than 20, and never above 2^64-1.
 *
 * This is the ONLY thing standing between user input and a LogQL string we
 * build by concatenation. It is a whitelist rather than an escape, which is
 * why the query below needs no quoting logic: a value that passes this cannot
 * contain a quote, a brace, or a pipe.
 */
export function isValidGuid(value: string): boolean {
  if (!/^[0-9]{1,20}$/.test(value)) return false;
  // 20 digits can still overflow uint64 (max 18446744073709551615).
  return BigInt(value) <= 18446744073709551615n;
}

/**
 * Every line carrying this GUID.
 *
 * The line filter comes BEFORE `| json` on purpose: Loki matches raw bytes far
 * more cheaply than it parses them, so filtering first is the difference
 * between a fast query and one that times out on a busy stream. The `| json`
 * + field match after it is what stops a coincidental substring hit (the GUID
 * appearing inside some other field) from joining the trail.
 *
 * `selector` is the deployment's stream selector — which labels a collector
 * attaches is a property of the deployment, not of the dashboard, the same way
 * `ROUTER_SCOPE_LABEL` is for Prometheus.
 */
export function buildTraceQuery(guid: string, selector: string): string {
  if (!isValidGuid(guid)) {
    throw new Error(`Refusing to build a query for a non-GUID value: ${JSON.stringify(guid)}`);
  }
  return `${selector} |= \`${guid}\` | json | GUID = \`${guid}\``;
}
