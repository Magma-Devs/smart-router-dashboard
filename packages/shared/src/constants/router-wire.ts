/**
 * The Smart Router's wire names, in both spellings.
 *
 * The router renamed every header it owns: reply headers `Lava-<X>` became
 * `Smart-Router-<X>`, and request directives `lava-<x>` became
 * `smartrouter-<x>`. The cut is hard on the router's side: a router from
 * before the rename reads and writes only the old names, a router from after
 * it only the new ones. The dashboard is pointed at both, so it speaks both:
 *
 * - **Reading a reply**: either spelling is taken, the new one first
 *   (`readRouterHeader`).
 * - **Sending a directive**: both spellings go on the request
 *   (`routerDirectiveHeaders`). A router strips the directives it knows and
 *   drops any other header its chain spec doesn't declare, so the spelling it
 *   doesn't know reaches neither the upstream nor the cache key. Detecting the
 *   router's generation first would save one header, and would leave the first
 *   request, and every request across an upgrade, unpinned without an error.
 *
 * The two spellings are written out per name rather than derived: the
 * cross-validation reply headers are `lava-cross-validation-*` and
 * `smartrouter-cross-validation-*`, which no prefix rule over the others gives.
 */

/** One wire name as the router spells it now and as it did before the rename. */
export interface RouterWireName {
  /** `Smart-Router-*` / `smartrouter-*`: a router from after the rename. */
  readonly current: string;
  /** `Lava-*` / `lava-*`: every router before it. */
  readonly legacy: string;
}

/** The reply headers the dashboard reads off a router's answer. */
export const ROUTER_REPLY_HEADERS = {
  /** The upstream(s) that served the relay, or `Cached`. */
  providerAddress: { current: "Smart-Router-Provider-Address", legacy: "Lava-Provider-Address" },
  /** How many times the relay was retried before this answer. */
  retries: { current: "Smart-Router-Retries", legacy: "Lava-Retries" },
  /** The router's request id, the GUID on its log lines. */
  guid: { current: "Smart-Router-Guid", legacy: "Lava-Guid" },
  crossValidationStatus: {
    current: "smartrouter-cross-validation-status",
    legacy: "lava-cross-validation-status",
  },
  crossValidationAgreeing: {
    current: "smartrouter-cross-validation-agreeing-providers",
    legacy: "lava-cross-validation-agreeing-providers",
  },
  crossValidationDisagreeing: {
    current: "smartrouter-cross-validation-disagreeing-providers",
    legacy: "lava-cross-validation-disagreeing-providers",
  },
} as const satisfies Record<string, RouterWireName>;

/** The request directives the dashboard sets. */
export const ROUTER_DIRECTIVE_HEADERS = {
  /** Pin the relay to one upstream. */
  selectProvider: { current: "smartrouter-select-provider", legacy: "lava-select-provider" },
  /** Skip the router's relay cache. Its presence is the signal. */
  forceCacheRefresh: {
    current: "smartrouter-force-cache-refresh",
    legacy: "lava-force-cache-refresh",
  },
} as const satisfies Record<string, RouterWireName>;

/** Both spellings of a name, the current one first. */
export function routerWireNames(name: RouterWireName): [string, string] {
  return [name.current, name.legacy];
}

/** Anything with the `get` of a fetch `Headers`: a name in any case, the value or null. */
export interface HeaderReader {
  get(name: string): string | null;
}

/**
 * A router reply header under either spelling, the current one first.
 *
 * Null only when the reply carries neither. An empty value is an answer and
 * is returned as one: an empty disagreeing-providers list says nobody
 * disagreed.
 */
export function readRouterHeader(headers: HeaderReader, name: RouterWireName): string | null {
  return headers.get(name.current) ?? headers.get(name.legacy);
}

/** The directives the dashboard can set on a request through a router. */
export interface RouterDirectives {
  selectProvider?: string;
  forceCacheRefresh?: boolean;
}

/**
 * The directives as request headers, each under both spellings so that a
 * router of either generation reads its own. The current spelling comes
 * first. Nothing set gives no headers.
 */
export function routerDirectiveHeaders(d: RouterDirectives): Record<string, string> {
  const headers: Record<string, string> = {};
  if (d.selectProvider) {
    for (const name of routerWireNames(ROUTER_DIRECTIVE_HEADERS.selectProvider))
      headers[name] = d.selectProvider;
  }
  if (d.forceCacheRefresh) {
    for (const name of routerWireNames(ROUTER_DIRECTIVE_HEADERS.forceCacheRefresh))
      headers[name] = "true";
  }
  return headers;
}
