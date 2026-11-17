/**
 * The dashboard's usage events (MAG-5373): what a visit opens, searches and
 * clicks, so the layout can be decided from what clients do. The web sends
 * them to the api (`POST /api/usage`), which keeps only what this catalog
 * allows and forwards it to the product-analytics store, tagged with the
 * tenant.
 *
 * Every field is a closed list, a yes/no, a bounded number, a chain's spec, a
 * window key or one of the api's listed reads. Nothing free-form is ever
 * kept: no user, no request ID or hash, no typed text, no filter value, no
 * node url. A field not listed here, or a value not in its form, is dropped
 * (`cleanUsageProps`), so a mistake in the web can't send one.
 */
import { WINDOWS } from "./windows.js";

export const USAGE_PAGES = ["metrics", "upstreams", "team", "audit", "account", "standalone", "other"] as const;
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
  visit_start: {
    arrived: ["link-request", "link", "typed"], page: USAGE_PAGES, tab: USAGE_TABS, window: "window", chain_picked: "bool",
    screen: ["phone", "tablet", "laptop", "wide"], theme: ["dark", "light"],
  },
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
  /**
   * Time to information: a page or tab has all its data on screen. Seconds
   * from opening it until its reads settled the first time, how many reads it
   * took and how many failed. Zero reads: everything came from the cache.
   */
  view_ready: { page: USAGE_PAGES, tab: USAGE_TABS, seconds: "seconds", reads: "count", failed: "count" },
  /** A "More about this" note held open: where the words on screen weren't enough. */
  help_open: { page: USAGE_PAGES, tab: USAGE_TABS },
  /** Three or more quick clicks in one spot: something didn't respond as expected. */
  rage_click: { page: USAGE_PAGES, tab: USAGE_TABS },
  /** Polling paused after an hour with nobody at the page: left open, likely on a screen. */
  idle_paused: { page: USAGE_PAGES, tab: USAGE_TABS },
  /** A read that failed (network or server error), or answered after 10 seconds. */
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
 * The api's reads, as a view is named: every GET path under `/api/`, with
 * `:id` where the path carries an id, a hash or something typed. A look-up's
 * path ends in what was typed (`/api/requests/<typed>`), which may be any
 * text, so a view is one of these and never a segment of the path itself.
 * The api's tests hold the list to the routes it registers.
 */
export const USAGE_VIEWS = [
  "/api/account/me",
  "/api/account/sessions",
  "/api/audit/catalog",
  "/api/audit/events",
  "/api/audit/tokens",
  "/api/config/routers",
  "/api/error-requests",
  "/api/error-requests/count",
  "/api/metrics/block-heights",
  "/api/metrics/chain-series",
  "/api/metrics/chains",
  "/api/metrics/cross-validation",
  "/api/metrics/dashboard",
  "/api/metrics/dashboard-summary",
  "/api/metrics/downtime-avoided",
  "/api/metrics/error-incidents",
  "/api/metrics/errors",
  "/api/metrics/methods",
  "/api/metrics/pulse",
  "/api/metrics/query",
  "/api/metrics/reads",
  "/api/metrics/retries",
  "/api/metrics/routers",
  "/api/metrics/routers-rollup",
  "/api/metrics/rps",
  "/api/metrics/specs",
  "/api/metrics/traffic",
  "/api/metrics/unavailable",
  "/api/metrics/upstream-detail",
  "/api/metrics/upstream-mix",
  "/api/metrics/upstream-peers",
  "/api/metrics/upstream-timeline",
  "/api/metrics/upstreams",
  "/api/metrics/websocket",
  "/api/requests/:id",
  "/api/team/invites",
  "/api/team/members",
  "/api/transactions",
  "/api/transactions/:id",
  "/api/transactions/over-time",
  "/api/usage/config",
] as const;

const VIEW_SET: ReadonlySet<string> = new Set(USAGE_VIEWS);

/**
 * An api path as a view name: the query dropped, then the listed view it is,
 * or the listed view it becomes with its last segment as `:id`. Null for a
 * path that is neither, so nothing off the list is ever a view.
 */
export function usageViewOf(path: string): string | null {
  const bare = path.split(/[?#]/)[0] ?? "";
  if (VIEW_SET.has(bare)) return bare;
  const withId = `${bare.slice(0, bare.lastIndexOf("/") + 1)}:id`;
  return VIEW_SET.has(withId) ? withId : null;
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
