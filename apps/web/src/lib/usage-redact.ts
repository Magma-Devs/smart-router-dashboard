/**
 * What usage data may say about a URL or a clicked element (MAG-5373).
 *
 * The dashboard's URLs carry what was typed into a look-up (`?request=`), node
 * names (`?upstream=`), router ids, audit filters (`?actor=` is an address),
 * cursors, and invitation and reset tokens in the path; its elements carry
 * request IDs, hashes and customer ids in their ids, titles and labels. Every
 * event Mixpanel's browser SDK records goes through `redactUsageEvent` before
 * it is queued (the `on_track` hook) and again before it is sent
 * (`before_send_events`):
 *
 *   our own URL      the path, each segment kept only when it is one of the
 *                    routes' fixed segments (`USAGE_PATH_SEGMENTS`), else `:id`;
 *                    the query keys the dashboard writes, a value kept only
 *                    when it is from a fixed set (`tab`, `window`, `chain`,
 *                    `upstreamChain`, audit `group` and `size`), else `:id`;
 *                    any other key, and the fragment, dropped
 *   another site's   its origin only (`https://etherscan.io`)
 *   a clicked element its tag, classes, place among its siblings, role, type
 *                    and name, our own static ids (`gw-…`) and its link
 *                    target as above; titles, labels and text are dropped,
 *                    in `$elements`, in the click's `$target` and in `$el_id`
 *
 * Pure, so it is tested without a browser (`__tests__/usage-redact.test.ts`).
 */
import { AUDIT_GROUPS, isKnownSpecIndex, isMetricWindow, USAGE_TABS } from "@sr/shared";

/** Every fixed segment of the dashboard's routes (`src/app`). Any other segment reads `:id`. */
export const USAGE_PATH_SEGMENTS = [
  "metrics", "upstreams", "team", "audit", "account", "two-factor", "standalone",
  "login", "setup", "forgot-password", "invite", "reset", "ask",
] as const;

const SEGMENTS: ReadonlySet<string> = new Set(USAGE_PATH_SEGMENTS);
const TABS: ReadonlySet<string> = new Set(USAGE_TABS);
const GROUPS: ReadonlySet<string> = new Set(AUDIT_GROUPS);

/** Query keys whose value is kept when it is one of a fixed set, and that set. */
export const USAGE_FIXED_PARAMS: Record<string, (value: string) => boolean> = {
  tab: (v) => TABS.has(v),
  window: (v) => isMetricWindow(v) || v === "24h",
  chain: isKnownSpecIndex,
  upstreamChain: isKnownSpecIndex,
  group: (v) => GROUPS.has(v),
  size: (v) => v === "25" || v === "50" || v === "100",
};

/** The dashboard's other query keys: kept by name, the value always `:id`. */
export const USAGE_OPAQUE_PARAMS = [
  "request", "router", "upstream", "from", "to", "expand", "tile",
  "actor", "target", "older", "newer", "page", "callbackUrl", "error", "chat",
] as const;

const OPAQUE: ReadonlySet<string> = new Set(USAGE_OPAQUE_PARAMS);
const ID = ":id";

/** A path with every segment that isn't one of the routes' fixed segments as `:id`. */
export function redactPath(path: string): string {
  return path
    .split("/")
    .map((segment) => (segment === "" || SEGMENTS.has(segment) ? segment : ID))
    .join("/");
}

/** A query (`?a=1&b=2`, or without the `?`) with only what `USAGE_FIXED_PARAMS` and `USAGE_OPAQUE_PARAMS` allow. "" when nothing is left. */
export function redactSearch(search: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return "";
  }
  const kept: string[] = [];
  for (const [key, value] of params) {
    const fixed = Object.prototype.hasOwnProperty.call(USAGE_FIXED_PARAMS, key) ? USAGE_FIXED_PARAMS[key] : undefined;
    if (fixed) kept.push(`${key}=${fixed(value) ? encodeURIComponent(value) : ID}`);
    else if (OPAQUE.has(key)) kept.push(`${key}=${ID}`);
  }
  return kept.length ? `?${kept.join("&")}` : "";
}

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:|^\/\//i;

/**
 * A URL as usage data may carry it, `origin` being the dashboard's own: one of
 * ours by its route and fixed-set query values, another site's by its origin,
 * any other scheme by its scheme alone. A relative URL stays relative.
 * Mixpanel's `$direct` and anything that isn't a string pass as they are.
 */
export function redactUrl(value: unknown, origin: string): unknown {
  if (typeof value !== "string" || value === "" || value === "$direct") return value;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return ID;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return url.protocol;
  if (url.origin !== origin) return url.origin;
  return `${ABSOLUTE.test(value) ? url.origin : ""}${redactPath(url.pathname)}${redactSearch(url.search)}`;
}

/** Properties that hold a URL, a path or a query, whatever their value looks like. */
const URL_PROPS = ["$current_url", "$referrer", "$initial_referrer", "$el_attr__href", "url"];
const PATH_PROPS = ["current_url_path", "$pathname"];
const SEARCH_PROPS = ["current_url_search"];

/**
 * Properties the SDK copies out of the page's query on its own: campaign tags
 * (`utm_…`, and `initial_utm_…` on a profile), ad click ids, and a search
 * engine's query (`mp_keyword`). Dropped: the query rules above decide what of
 * an address is sent.
 */
const MARKETING_KEY = /^(initial_)?utm_|^(dclid|fbclid|gclid|ko_click_id|li_fat_id|msclkid|sccid|ttclid|twclid|wbraid|mp_keyword)$/;

/** What is kept of each element in autocapture's `$elements`. */
const ELEMENT_KEEP = new Set(["$tag_name", "$classes", "$nth_child", "$nth_of_type", "$attr-role", "$attr-type", "$attr-name"]);
const OWN_ID = /^gw-[a-z0-9-]+$/;

function redactElement(el: unknown, origin: string): unknown {
  if (!el || typeof el !== "object") return el;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(el as Record<string, unknown>)) {
    if (ELEMENT_KEEP.has(key)) out[key] = value;
    else if (key === "$attr-href") out[key] = redactUrl(value, origin);
    else if (key === "$id" && typeof value === "string" && OWN_ID.test(value)) out[key] = value;
  }
  return out;
}

/**
 * An event's properties as usage data may send them. Named URL, path and
 * query properties are redacted whatever they hold, and so is any other
 * string that is an http(s) URL; clicked elements (`$elements` and the
 * click's `$target`) keep only what `ELEMENT_KEEP` lists; `$el_id` stays only
 * when it is one of our own static ids; element text, every other
 * `$el_attr__`, and the campaign tags and click ids the SDK reads from the
 * address (`MARKETING_KEY`) go.
 */
export function redactUsageProps(props: Record<string, unknown>, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "$el_text" || (key.startsWith("$el_attr__") && key !== "$el_attr__href")) continue;
    if (MARKETING_KEY.test(key)) continue;
    if (key === "$el_id" && !(typeof value === "string" && OWN_ID.test(value))) continue;
    if (URL_PROPS.includes(key)) out[key] = redactUrl(value, origin);
    else if (PATH_PROPS.includes(key)) out[key] = typeof value === "string" ? redactPath(value) : value;
    else if (SEARCH_PROPS.includes(key)) out[key] = typeof value === "string" ? redactSearch(value) : value;
    else if (key === "$elements" && Array.isArray(value)) out[key] = value.map((el) => redactElement(el, origin));
    else if (key === "$target") out[key] = redactElement(value, origin);
    else if (typeof value === "string" && /^https?:\/\//i.test(value)) out[key] = redactUrl(value, origin);
    else out[key] = value;
  }
  return out;
}

/** One event as Mixpanel's `before_send_events` hook hands it over. */
export function redactUsageEvent<T extends { event: string; properties: Record<string, unknown> }>(payload: T, origin: string): T {
  return { ...payload, properties: redactUsageProps(payload.properties ?? {}, origin) };
}

/** A profile update as `before_send_people` hands it over: what it sets, redacted the same way. */
export function redactProfileUpdate(payload: Record<string, unknown>, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const op of ["$set", "$set_once"]) {
    const set = payload[op];
    if (set && typeof set === "object" && !Array.isArray(set)) out[op] = redactUsageProps(set as Record<string, unknown>, origin);
  }
  return out;
}
