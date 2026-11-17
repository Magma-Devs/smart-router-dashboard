/**
 * The dashboard's usage events (MAG-5373): what a visit opens, searches and
 * clicks, so the layout can be decided from what clients do. The web sends
 * them to the api (`POST /api/usage`), which keeps only what this catalog
 * allows and forwards it to the product-analytics store, tagged with the
 * tenant.
 *
 * Every field is a closed list, a yes/no, a bounded number, a chain's spec, a
 * window key or an api path with its ids taken out. Nothing free-form is ever
 * kept: no user, no request ID or hash, no typed text, no filter value, no
 * node url. A field not listed here, or a value not in its form, is dropped
 * (`cleanUsageProps`), so a mistake in the web can't send one.
 */
import { WINDOWS } from "./windows.js";

export const USAGE_PAGES = ["metrics", "upstreams", "team", "audit", "account", "other"] as const;
export const USAGE_TABS = ["metrics", "upstreams", "errors", "transactions", "request", "none"] as const;
const LISTS = ["errors", "transactions"] as const;

/** How one field is checked. */
export type UsageField =
  | readonly string[]
  | "bool"
  | "count"
  | "seconds"
  | "chain"
  | "window"
  | "view";

export const USAGE_EVENTS = {
  /** A visit begins: how it arrived, and where. */
  visit_start: { arrived: ["link-request", "link", "typed"], page: USAGE_PAGES, tab: USAGE_TABS, window: "window", chain_picked: "bool" },
  page_view: { page: USAGE_PAGES, tab: USAGE_TABS },
  tab_change: { from: USAGE_TABS, to: USAGE_TABS },
  chain_pick: { chain: "chain", from: ["list", "router-row", "cleared"] },
  router_pick: { from: ["list"] },
  time_range_change: { from: "window", to: "window" },
  /** A look-up answered: what kind of value, where it was typed, what came back. */
  search: {
    kind: ["request-id", "old-request-id", "hash", "other"],
    from: ["top-bar", "request-tab", "link"],
    result: ["found", "not-found", "stopped-early", "error", "unavailable"],
    seconds: "seconds",
    older: "bool",
  },
  row_open: {
    list: LISTS,
    result: ["recovered", "error-reply", "failed", "write-unknown", "unknown", "ok", "accepted", "rejected", "failed-on-chain"],
  },
  panel_open: { panel: ["router-row", "chart-tile", "provider", "see-requests", "errors-bar", "timeline-line", "grouped-error"] },
  filter_use: { list: LISTS, filter: ["view", "result", "retryable", "error-type", "customer", "method", "provider", "time"] },
  load_older: { list: LISTS },
  link_out: { target: ["grafana", "explorer", "try-it", "report-incident", "copy"] },
  /** A read that failed, or answered after 10 seconds. */
  view_problem: { view: "view", problem: ["did-not-load", "slow"], seconds: "seconds" },
  visit_end: { seconds: "seconds", active_seconds: "seconds", pages: "count", tabs: "count", events: "count" },
} as const satisfies Record<string, Record<string, UsageField>>;

export type UsageEventName = keyof typeof USAGE_EVENTS;

/** Values of one event's fields, as the web passes them. */
export type UsageProps = Record<string, string | number | boolean | null | undefined>;

export const USAGE_EVENT_NAMES = Object.keys(USAGE_EVENTS) as UsageEventName[];

/** At most this many events in one `POST /api/usage`. */
export const USAGE_BATCH_MAX = 50;

/** A visit's id: random, per browser tab, new after 30 minutes away. */
export const USAGE_VISIT_ID = /^[a-z0-9-]{8,64}$/;

const CHAIN = /^[A-Z0-9]{2,24}$/;
const MAX_SECONDS = 86_400;
const MAX_COUNT = 100_000;

export const isUsageEventName = (s: string): s is UsageEventName =>
  Object.prototype.hasOwnProperty.call(USAGE_EVENTS, s);

/**
 * An api path as a view name: the query dropped and every segment that isn't
 * a plain word (an id, a hash, a number) replaced by `:id`. Null when it isn't
 * an api path.
 */
export function usageViewOf(path: string): string | null {
  const bare = path.split(/[?#]/)[0] ?? "";
  if (!bare.startsWith("/api/")) return null;
  const parts = bare.split("/").slice(1).map((p) => (/^[a-z][a-z-]{0,39}$/.test(p) ? p : ":id"));
  const view = `/${parts.join("/")}`;
  return view.length <= 100 ? view : null;
}

function cleanValue(field: UsageField, v: unknown): string | number | boolean | undefined {
  if (Array.isArray(field)) return typeof v === "string" && field.includes(v) ? v : undefined;
  switch (field) {
    case "bool":
      return typeof v === "boolean" ? v : undefined;
    case "count":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), MAX_COUNT) : undefined;
    case "seconds":
      return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(Math.min(v, MAX_SECONDS) * 10) / 10 : undefined;
    case "chain":
      return typeof v === "string" && CHAIN.test(v) ? v : undefined;
    case "window":
      return typeof v === "string" && Object.prototype.hasOwnProperty.call(WINDOWS, v) ? v : undefined;
    case "view":
      return typeof v === "string" ? usageViewOf(v) ?? undefined : undefined;
    default:
      return undefined;
  }
}

/**
 * An event's fields as the catalog allows them: unknown fields and values not
 * in their form are left out. Null for an event the catalog doesn't name.
 */
export function cleanUsageProps(name: string, props: unknown): Record<string, string | number | boolean> | null {
  if (!isUsageEventName(name)) return null;
  const spec = USAGE_EVENTS[name] as Record<string, UsageField>;
  const out: Record<string, string | number | boolean> = {};
  if (props && typeof props === "object") {
    for (const [k, field] of Object.entries(spec)) {
      const v = cleanValue(field, (props as Record<string, unknown>)[k]);
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}
