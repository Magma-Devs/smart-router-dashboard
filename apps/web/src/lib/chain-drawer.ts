import type { HealthState } from "@sr/shared";
import { ERR_BAD_PCT, ERR_WARN_PCT } from "./colors";

/* The chains drawer's rules, kept out of the component so they can be tested:
 * what order the chains come in, and how a page URL names one. */

/** One row of the drawer: a chain and the numbers it is sorted by. */
export interface DrawerChain {
  spec: string;
  name: string;
  mainnet: boolean;
  health: HealthState;
  /** Requests in the page's window. */
  requests: number;
  /** Error rate in percent; null when the chain served nothing. */
  errPct: number | null;
  /** Declared in the values file but no traffic in the metrics yet. */
  noTraffic: boolean;
}

/** How urgently a chain needs a look: 0 comes first. */
export function attention(c: DrawerChain): number {
  if (c.health === "unhealthy") return 0;
  if (c.errPct !== null && c.errPct >= ERR_BAD_PCT) return 1;
  if (c.errPct !== null && c.errPct >= ERR_WARN_PCT) return 2;
  if (c.health === "operational") return 3;
  return 4; // no metrics in this window
}

/** Problems first, then the busiest, then by name, so equal rows keep one order. */
export function byAttention(rows: DrawerChain[]): DrawerChain[] {
  return [...rows].sort(
    (a, b) => attention(a) - attention(b) || b.requests - a.requests || a.name.localeCompare(b.name),
  );
}

/** A spec index as the api takes it (`?spec=`): a plain token. */
const SPEC_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
/** A config router id (`eth-prod`, `ETH1`): the values file's own name for it. */
const ROUTER_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** What a page URL narrows to: `?chain=ETH1&router=eth-prod`. */
export interface PageScope {
  chain: string | null;
  router: string | null;
}

/** The chain and router a page URL names. A malformed value reads as none. */
export function scopeFromSearch(search: string): PageScope {
  const q = new URLSearchParams(search);
  const chain = q.get("chain");
  const router = q.get("router");
  return {
    chain: chain !== null && SPEC_TOKEN.test(chain) ? chain : null,
    router: router !== null && ROUTER_TOKEN.test(router) ? router : null,
  };
}

/** The link to one chain's metrics (and one of its routers); null is every chain. */
export function chainHref(spec: string | null, router: string | null = null): string {
  if (!spec) return "/metrics";
  const q = new URLSearchParams({ chain: spec });
  if (router) q.set("router", router);
  return `/metrics?${q.toString()}`;
}
