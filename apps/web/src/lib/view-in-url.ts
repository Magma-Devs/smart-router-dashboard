import { DEFAULT_WINDOW, isMetricWindow, toMetricWindow, WINDOWS, type MetricWindow } from "@sr/shared";
import { ROUTER_TOKEN, SPEC_TOKEN } from "./chain-drawer";

/* The rest of the Metrics page's view in its URL, beside the chain, router
 * and tab (`useScopeInUrl`) and the request (`request-in-url.ts`): the time
 * window, and what is in focus inside the tab. A copied URL opens the same
 * view. Each tab owns its keys, and picking another tab drops them:
 *
 *   window          every tab      the page's time window (`24h` reads as `1d`)
 *   expand · tile   Overview       the router row open in the Routers table, the chart tile picked in it
 *   upstream        Upstreams      the upstream in the deep-dive (its name, as the roster shows it)
 *   upstreamChain   Upstreams      that upstream's chain, only when the page has no chain picked
 *   upstream        Errors         the request list's upstream filter
 *   from · to       Errors         the list's exact times, unix ms
 *
 * Kept pure so it can be tested; the page reads and writes the URL. */

/** Every key this file reads and writes. */
export const VIEW_KEYS = ["window", "upstream", "upstreamChain", "from", "to", "expand", "tile"] as const;
export type ViewKey = (typeof VIEW_KEYS)[number];

/** The keys each tab owns. A tab not listed owns none. */
const TAB_KEYS: Record<string, readonly ViewKey[]> = {
  metrics: ["expand", "tile"],
  upstreams: ["upstream", "upstreamChain"],
  errors: ["upstream", "from", "to"],
};

/** The longest exact range the log routes read, and how far back they reach. */
export const LOG_SPAN_MS = WINDOWS["30d"].rangeSeconds * 1000;

/** An upstream by the name the roster shows; `spec` is its chain, null when the URL doesn't say. */
export interface UpstreamPick {
  name: string;
  spec: string | null;
}

/** What is in focus inside a tab. */
export interface ViewFocus {
  /** Upstreams: the upstream in the deep-dive. Errors: the list's upstream filter. */
  upstream: UpstreamPick | null;
  /** Errors: exact times (unix ms) instead of the page window. */
  range: { from: number; to: number } | null;
  /** Overview: the router row open in the Routers table (its config id). */
  expand: string | null;
  /** Overview: the chart tile picked in that row (the tile's own key). */
  tile: string | null;
}

export const NO_FOCUS: ViewFocus = { upstream: null, range: null, expand: null, tile: null };

/** Why a link's times were not read as they are. */
export type SpanNote = "unreadable" | "expired" | "clipped";

/** A node name, as the values file gives it. Never a URL: those can carry an API key. */
const NAME_OK = (s: string) => s.length > 0 && s.length <= 200 && !s.includes("://")
  && [...s].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);
const TILE_TOKEN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The window a URL names: `window` set to a valid window (the `24h` alias
 * reads as `1d`), or `unknown` set to what it said when that isn't one.
 * Both null when it names none.
 */
export function windowFromSearch(search: string): { window: MetricWindow | null; unknown: string | null } {
  const v = new URLSearchParams(search).get("window");
  if (v === null || v === "") return { window: null, unknown: null };
  const w = toMetricWindow(v);
  if (isMetricWindow(v) || w !== DEFAULT_WINDOW) return { window: w, unknown: null };
  return { window: null, unknown: v.slice(0, 32) };
}

/**
 * Exact times from a URL (`from` and `to`, unix ms), as the log routes would
 * read them at `now`. Times that can't be read (one alone, not numbers, in
 * the wrong order, starting in the future, over 30 days long) and times that
 * ended over 30 days ago read as none, with a note saying which; times that
 * start before then start 30 days ago (`clipped`).
 */
export function spanFromSearch(search: string, now: number): { range: { from: number; to: number } | null; note: SpanNote | null } {
  const q = new URLSearchParams(search);
  const rawFrom = q.get("from");
  const rawTo = q.get("to");
  if (rawFrom === null && rawTo === null) return { range: null, note: null };
  const from = rawFrom !== null && /^\d{1,15}$/.test(rawFrom) ? Number(rawFrom) : NaN;
  const to = rawTo !== null && /^\d{1,15}$/.test(rawTo) ? Number(rawTo) : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from >= now || to - from > LOG_SPAN_MS) {
    return { range: null, note: "unreadable" };
  }
  const oldest = now - LOG_SPAN_MS;
  if (to <= oldest) return { range: null, note: "expired" };
  if (from < oldest) return { range: { from: oldest, to }, note: "clipped" };
  return { range: { from, to }, note: null };
}

/**
 * What a URL puts in focus on `tab`: only the keys that tab owns are read, and
 * a malformed value reads as none. `chain` is the page's chain from the same
 * URL - an upstream's chain when `upstreamChain` doesn't name one.
 */
export function focusFromSearch(search: string, tab: string, now: number): { focus: ViewFocus; span: SpanNote | null } {
  const q = new URLSearchParams(search);
  const owns = TAB_KEYS[tab] ?? [];
  const focus: ViewFocus = { ...NO_FOCUS };
  let span: SpanNote | null = null;
  if (owns.includes("upstream")) {
    const name = q.get("upstream");
    if (name !== null && NAME_OK(name)) {
      const own = q.get("upstreamChain");
      const chain = q.get("chain");
      const spec = owns.includes("upstreamChain") && own !== null && SPEC_TOKEN.test(own) ? own
        : chain !== null && SPEC_TOKEN.test(chain) ? chain : null;
      focus.upstream = { name, spec };
    }
  }
  if (owns.includes("from")) {
    const s = spanFromSearch(search, now);
    focus.range = s.range;
    span = s.note;
  }
  if (owns.includes("expand")) {
    const row = q.get("expand");
    if (row !== null && ROUTER_TOKEN.test(row)) {
      focus.expand = row;
      const tile = q.get("tile");
      focus.tile = tile !== null && TILE_TOKEN.test(tile) ? tile : null;
    }
  }
  return { focus, span };
}

/**
 * The view as URL params: every key in `VIEW_KEYS`, null for the ones to
 * leave out. The window is always there - the viewer's own saved window is
 * not the sender's - once known (`win` undefined: not yet, leave it as it is),
 * and a tab's focus only on that tab. `chain` is the page's chain: an upstream
 * on it needs no `upstreamChain`.
 */
export function viewParams(tab: string, focus: ViewFocus, chain: string | null, win: MetricWindow | undefined): Record<ViewKey, string | null | undefined> {
  const owns = TAB_KEYS[tab] ?? [];
  const has = (k: ViewKey) => owns.includes(k);
  const up = focus.upstream;
  return {
    window: win,
    upstream: has("upstream") && up ? up.name : null,
    upstreamChain: has("upstreamChain") && up?.spec && up.spec !== chain ? up.spec : null,
    from: has("from") && focus.range ? String(Math.round(focus.range.from)) : null,
    to: has("to") && focus.range ? String(Math.round(focus.range.to)) : null,
    expand: has("expand") ? focus.expand : null,
    tile: has("tile") && focus.expand ? focus.tile : null,
  };
}

/** Do two focuses show the same thing? */
export function sameFocus(a: ViewFocus, b: ViewFocus): boolean {
  return a.upstream?.name === b.upstream?.name && a.upstream?.spec === b.upstream?.spec
    && a.range?.from === b.range?.from && a.range?.to === b.range?.to
    && a.expand === b.expand && a.tile === b.tile;
}

/** Is anything in focus? */
export const hasFocus = (f: ViewFocus) => f.upstream !== null || f.range !== null || f.expand !== null;

/** What the page says about a link's times it couldn't open as they were. */
export function spanNotice(note: SpanNote, windowLabel: string): string {
  switch (note) {
    case "unreadable": return `The times in this link can't be read. The list shows the last ${windowLabel}.`;
    case "expired": return `The times in this link are more than 30 days ago, and the logs are kept for 30 days. The list shows the last ${windowLabel}.`;
    case "clipped": return "The times in this link start more than 30 days ago, and the logs are kept for 30 days. The list starts 30 days ago.";
  }
}

/** What the page says about a window in a link that isn't one it offers. */
export function windowNotice(unknown: string, windowLabel: string): string {
  return `The time window in this link, "${unknown}", isn't one this page offers. Showing the last ${windowLabel}.`;
}
