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
 *
 * Naming one router: every reader that picks a router by `service_name` -
 * these streams, the recorded counts, the scraped series - goes through the
 * `serviceName*` helpers below, so the id is lower-cased (and, in a regex,
 * escaped) in one place. The chart labels a router's pods with its id
 * lower-cased (`app.smart-router-id: {{ $router.id | lower }}`), the fleet's
 * collector stamps `service_name` = `<tenant>-<that label>` on the pods' log
 * streams and scraped series alike, and the log ruler's counts keep the stream
 * label. The values file the dashboard reads keeps the id as written,
 * capitals and all: the chart's own default ids are `Ethereum` and `CosmosHub`.
 */

import type { LokiClient } from "./loki-client.js";
import { escapeRe } from "./router-log.js";

export const CHAIN_LABEL = "chain";
export const ROUTER_LABEL = "service_name";
/** The label the fleet's log agent puts on a router's `relay_end` lines, as `relay_end="1"`. */
export const RELAY_END_LABEL = "relay_end";

/** How far back the labels' values are looked up, and how long the answer is kept. */
const LOOK_BACK_MS = 24 * 3600_000;
const KEEP_MS = 10 * 60_000;
/** The stretch before a read's start, and at its end, the `relay_end` label is looked up over. */
const EDGE_MS = 5 * 60_000;
/** How long an answer about the `relay_end` label is kept, per minute of a read's start and end. */
const RELAY_END_KEEP_MS = 60_000;

/** A label value spliced into a selector: a plain token only. */
export const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The router's selector with one more label matcher; null when it isn't a plain `{…}` selector. */
export function withMatcher(selector: string, label: string, value: string): string | null {
  if (!SAFE_VALUE.test(value) || !/\}\s*$/.test(selector)) return null;
  return selector.replace(/\}\s*$/, `, ${label}="${value}"}`);
}

/** A router id as `service_name` carries it: lower-cased, as the chart labels the router's pods. */
export const serviceNameId = (routerId: string): string => routerId.toLowerCase();

/** One router's `service_name` where the tenant is known: `<tenant>-<id lower-cased>`. */
export const serviceNameOf = (tenant: string, routerId: string): string => `${tenant}-${serviceNameId(routerId)}`;

/** Whether a `service_name` value is this router's where the tenant isn't known: it ends in `-<id lower-cased>`. */
export const isServiceNameOf = (value: string, routerId: string): boolean => value.endsWith(`-${serviceNameId(routerId)}`);

/**
 * Whether matching this router's `service_name` by its end would take in
 * another router's too: one of `others` (the chain's other router ids) that
 * the label carries as this one's id, or as an id ending in `-<id>`
 * (`archive-eth` for `eth`). Compared lower-cased, as the label carries them.
 */
export function serviceNameClash(routerId: string, others: readonly string[]): boolean {
  const own = serviceNameId(routerId);
  return others.some((o) => {
    const id = serviceNameId(o);
    return id === own || id.endsWith(`-${own}`);
  });
}

/**
 * The matcher for one router's series or streams where the tenant isn't
 * known, in PromQL or LogQL: `service_name=~".+-<id>"`, the id lower-cased
 * and regex-escaped (a `.` in it matches only a dot), then escaped again for
 * the quoted string. Null for an id that isn't a plain token.
 */
export function serviceNameMatcher(routerId: string): string | null {
  if (!SAFE_VALUE.test(routerId)) return null;
  const regex = `.+-${escapeRe(serviceNameId(routerId))}`;
  return `${ROUTER_LABEL}=~"${regex.replace(/\\/g, "\\\\")}"`;
}

/** The tenant the selector pins, when it names one: `service_name` is `<tenant>-<router id lower-cased>`. */
const clusterOf = (selector: string) => /\bcluster="([^"]+)"/.exec(selector)?.[1] ?? null;

export class StreamScope {
  private readonly kept = new Map<string, { at: number; values: Set<string> | null }>();
  private readonly relayEndKept = new Map<string, { at: number; labelled: boolean }>();

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
      // <tenant>-<id lower-cased>, exactly where the selector names the tenant, else the one value ending in -<id>.
      const cluster = clusterOf(this.selector);
      const routers = [...((await this.values(ROUTER_LABEL)) ?? [])];
      const own = cluster
        ? routers.filter((v) => v === serviceNameOf(cluster, routerId))
        : routers.filter((v) => isServiceNameOf(v, routerId));
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

  /**
   * `selector` narrowed to the router's `relay_end` lines (`relay_end="1"`)
   * for a read from `startMs` to `endMs`, where the log agent labels them
   * through the whole read; else `selector` as it is. Labelled streams must
   * hold lines in the five minutes before the start and in the read's last
   * five, by the series index (`hasStreams`): a line written before the label
   * existed carries none, and a deployment whose agent sets no such label, or
   * a Loki that doesn't say, reads every line as before. Only a read of
   * `relay_end` lines alone may use it.
   */
  async relayEnd(selector: string, startMs: number, endMs: number): Promise<string> {
    const narrowed = withMatcher(selector, RELAY_END_LABEL, "1");
    if (!narrowed) return selector;
    const key = `${selector} ${Math.floor(startMs / 60_000)} ${Math.floor(endMs / 60_000)}`;
    const t = this.now();
    const hit = this.relayEndKept.get(key);
    if (hit && t - hit.at < RELAY_END_KEEP_MS) return hit.labelled ? narrowed : selector;
    const [before, last] = await Promise.all([
      this.loki.hasStreams(narrowed, startMs - EDGE_MS, startMs),
      this.loki.hasStreams(narrowed, Math.max(startMs, endMs - EDGE_MS), endMs),
    ]);
    const labelled = before === true && last === true;
    for (const [k, v] of this.relayEndKept) if (t - v.at >= RELAY_END_KEEP_MS) this.relayEndKept.delete(k);
    this.relayEndKept.set(key, { at: t, labelled });
    return labelled ? narrowed : selector;
  }
}
