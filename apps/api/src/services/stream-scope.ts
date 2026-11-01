/*
 * The router's log streams narrowed to one chain or one router by their own
 * labels, where the log agent puts them there: the fleet's labels each stream
 * `chain` (the spec lower-cased) and `service_name` (`<tenant>-<router id
 * lower-cased>`), the labels the ruler's recorded counts carry too, and the
 * ones the Transactions chart already reads its newest minutes by.
 *
 * Why it matters: a line filter doesn't narrow what Loki reads. Narrowing a
 * list to a chain by its upstreams' names fails where those names serve other
 * chains - a vendor's name is on every chain it serves - and a busy chain's
 * lines with the same name fill a read's line limit in seconds, leaving the
 * chain asked for empty. A stream label is exact, and Loki opens only that
 * chain's chunks, so the same budget covers far more of the window.
 *
 * Where the streams carry no such label, or Loki doesn't say, `narrow`
 * answers null and the lists read as before.
 */

import type { LokiClient } from "./loki-client.js";

export const CHAIN_LABEL = "chain";
export const ROUTER_LABEL = "service_name";

/** How far back the labels' values are looked up, and how long the answer is kept. */
const LOOK_BACK_MS = 24 * 3600_000;
const KEEP_MS = 10 * 60_000;

/** A label value spliced into a selector: a plain token only. */
export const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The router's selector with one more label matcher; null when it isn't a plain `{…}` selector. */
export function withMatcher(selector: string, label: string, value: string): string | null {
  if (!SAFE_VALUE.test(value) || !/\}\s*$/.test(selector)) return null;
  return selector.replace(/\}\s*$/, `, ${label}="${value}"}`);
}

/** The tenant the selector pins, when it names one: `service_name` is `<tenant>-<router id lower-cased>`. */
const clusterOf = (selector: string) => /\bcluster="([^"]+)"/.exec(selector)?.[1] ?? null;

export class StreamScope {
  private readonly kept = new Map<string, { at: number; values: Set<string> | null }>();

  constructor(
    private readonly loki: LokiClient,
    private readonly selector: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The values a label takes on the router's streams over the last day; null when Loki didn't say. */
  private async values(label: string): Promise<Set<string> | null> {
    const hit = this.kept.get(label);
    const t = this.now();
    if (hit && t - hit.at < KEEP_MS) return hit.values;
    const got = await this.loki.labelValues(label, this.selector, t - LOOK_BACK_MS, t);
    const values = got ? new Set(got) : null;
    this.kept.set(label, { at: t, values });
    return values;
  }

  /**
   * The router's selector narrowed to one router (its `service_name`) or else
   * to one chain (`chain`, the spec lower-cased, as the recorded counts match
   * it); null when the streams can't be narrowed that way.
   */
  async narrow(spec?: string, routerId?: string): Promise<string | null> {
    if (routerId) {
      // As the Transactions chart names a router (transactions-over-time.ts): <tenant>-<id lower-cased>,
      // exactly where the selector names the tenant, else the one value ending in -<id>.
      const id = routerId.toLowerCase();
      const cluster = clusterOf(this.selector);
      const routers = [...((await this.values(ROUTER_LABEL)) ?? [])];
      const own = cluster ? routers.filter((v) => v === `${cluster}-${id}`) : routers.filter((v) => v.endsWith(`-${id}`));
      const narrowed = own.length === 1 ? withMatcher(this.selector, ROUTER_LABEL, own[0]!) : null;
      if (narrowed) return narrowed;
    }
    if (spec) {
      const chains = await this.values(CHAIN_LABEL);
      const chain = spec.toLowerCase();
      if (chains?.has(chain)) return withMatcher(this.selector, CHAIN_LABEL, chain);
    }
    return null;
  }
}
