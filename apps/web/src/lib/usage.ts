"use client";
/**
 * The dashboard's usage events (MAG-5373), sent in batches to the api
 * (`POST /api/usage`), which keeps what the catalog allows and forwards it to
 * the analytics store with the tenant. Nothing is sent unless the api says
 * usage data is on (`GET /api/usage/config`): off by default on a self-hosted
 * install.
 *
 * A visit is one browser tab, new after 30 minutes with no event. Events wait
 * here and go every 10 s, at 20, and when the tab is hidden or closed (the
 * last with `keepalive`, with `visit_end`). Every call is safe to make before
 * the switch is known, on the server, or while it is off: it does nothing.
 *
 * The pure parts (`visitFrom`, `arrivedFrom`, `pageOf`, `searchKind`) are
 * tested; the rest is wiring.
 */
import { cleanUsageProps, guidMintedSecond, USAGE_BATCH_MAX, type UsageEventName, type UsageProps } from "@sr/shared";
import { ApiError, apiGet, apiPost, apiPostKeepalive } from "./api-client";
import { getIdlePhase, subscribeIdle } from "./idle-store";

const VISIT_KEY = "sr:visit";
const SEARCH_FROM_KEY = "sr:search-from";
/** A visit ends after this long with no event. */
export const VISIT_AWAY_MS = 30 * 60_000;
const FLUSH_MS = 10_000;
const FLUSH_AT = 20;
/** Events kept while the switch is unknown or a send failed. */
const QUEUE_MAX = 200;

export interface StoredVisit {
  id: string;
  start: number;
  last: number;
  seq: number;
  /** The visit's totals so far, kept with it so a reload doesn't restart them. */
  pages?: string[];
  tabs?: string[];
  events?: number;
  activeMs?: number;
}

/** The visit to carry on, or a new one when there is none or the last event is 30 minutes old. */
export function visitFrom(stored: StoredVisit | null, now: number, newId: () => string): { visit: StoredVisit; isNew: boolean } {
  if (stored && now - stored.last < VISIT_AWAY_MS && now >= stored.start) return { visit: stored, isNew: false };
  return { visit: { id: newId(), start: now, last: now, seq: 0 }, isNew: true };
}

/** How a visit arrived, from its first URL: a link to one request, another link with a view in it, or typed. */
export function arrivedFrom(search: string): "link-request" | "link" | "typed" {
  const q = new URLSearchParams(search);
  if (q.get("request")) return "link-request";
  for (const k of ["chain", "router", "tab", "upstream", "expand", "tile", "from", "to"]) if (q.get(k)) return "link";
  return "typed";
}

export function pageOf(pathname: string): "metrics" | "upstreams" | "team" | "audit" | "account" | "standalone" | "other" {
  const first = pathname.split("/")[1] ?? "";
  return first === "metrics" || first === "upstreams" || first === "team" || first === "audit" || first === "account" || first === "standalone" ? first : "other";
}

/** The width class of the reader's screen, for layout decisions. */
export function screenOf(width: number): "phone" | "tablet" | "laptop" | "wide" {
  return width < 768 ? "phone" : width < 1100 ? "tablet" : width < 1600 ? "laptop" : "wide";
}

export function tabOf(pathname: string, search: string): string {
  if (pageOf(pathname) !== "metrics") return "none";
  return new URLSearchParams(search).get("tab") ?? "metrics";
}

/** What kind of value a look-up was for - never the value itself. */
export function searchKind(value: string, nowSec = Date.now() / 1000): "request-id" | "old-request-id" | "hash" | "other" {
  const v = value.trim();
  if (guidMintedSecond(v, nowSec) !== null) return "request-id";
  if (/^\d{6,25}$/.test(v)) return "old-request-id";
  if (/^(0x)?[0-9a-fA-F]{40,}$/.test(v) || /^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(v)) return "hash";
  return "other";
}

interface Queued { name: UsageEventName; at: number; seq: number; props: Record<string, string | number | boolean> }

let enabled: boolean | null = null;
let started = false;
let queue: Queued[] = [];
let visit: StoredVisit | null = null;
let lastActive = 0;
/** Set as the page unloads: reads cut short by leaving are not problems. */
let leaving = false;
let lastPageView = { key: "", at: 0 };
/** Views already reported as failed or slow this visit. */
const problemsSeen = new Set<string>();
/** After a failed send, none before this (exponential backoff, up to 5 minutes). */
let nextSendAt = 0;
let failures = 0;

function readStored(): StoredVisit | null {
  try {
    const raw = sessionStorage.getItem(VISIT_KEY);
    const v = raw ? (JSON.parse(raw) as StoredVisit) : null;
    return v && typeof v.id === "string" && typeof v.start === "number" ? v : null;
  } catch {
    return null;
  }
}

function saveVisit() {
  // Nothing is kept in the browser until the api says usage data is on: on a
  // deployment where it is off, no tracking state is ever written.
  if (enabled !== true) return;
  try {
    if (visit) sessionStorage.setItem(VISIT_KEY, JSON.stringify(visit));
  } catch {
    /* private window: the visit lives in memory only */
  }
}

const randomId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** The visit an event belongs to, starting a new one (with `visit_start`) when the last is over. */
function currentVisit(now: number): StoredVisit {
  const { visit: v, isNew } = visitFrom(visit ?? readStored(), now, randomId);
  visit = v;
  if (isNew) {
    problemsSeen.clear();
    const loc = window.location;
    push("visit_start", {
      arrived: arrivedFrom(loc.search),
      page: pageOf(loc.pathname),
      tab: tabOf(loc.pathname, loc.search),
      window: new URLSearchParams(loc.search).get("window") ?? undefined,
      chain_picked: !!new URLSearchParams(loc.search).get("chain"),
      screen: screenOf(window.innerWidth),
      theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    });
  }
  return v;
}

function push(name: UsageEventName, props: UsageProps) {
  const now = Date.now();
  const v = visit!;
  const clean = cleanUsageProps(name, props);
  if (!clean) return;
  queue.push({ name, at: now, seq: v.seq++, props: clean });
  if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
  v.last = now;
  v.events = (v.events ?? 0) + 1;
  saveVisit();
}

/** Record one event. Does nothing on the server, or once usage data is known to be off. */
export function track(name: UsageEventName, props: UsageProps = {}): void {
  if (typeof window === "undefined" || enabled === false) return;
  const now = Date.now();
  const v = currentVisit(now);
  const add = (list: "pages" | "tabs", x: unknown) => {
    if (typeof x === "string" && !(v[list] ?? []).includes(x)) v[list] = [...(v[list] ?? []), x];
  };
  if (name === "page_view") {
    // The same page view twice in a row is one: a re-render, not a visit.
    const key = `${props.page}|${props.tab}`;
    if (key === lastPageView.key && now - lastPageView.at < 2_000) return;
    lastPageView = { key, at: now };
    add("pages", props.page);
    add("tabs", props.tab);
  }
  if (name === "tab_change") add("tabs", props.to);
  push(name, props);
  if (name === "page_view" || name === "tab_change") {
    const loc = window.location;
    startView(pageOf(loc.pathname), name === "tab_change" ? String(props.to) : String(props.tab ?? tabOf(loc.pathname, loc.search)));
  }
  if (queue.length >= FLUSH_AT) void flush();
}

/** Events sent as the tab closes: the newest, `visit_end` among them, in chunks a `keepalive` budget (64 KB) holds. */
const CLOSING_MAX = 3 * USAGE_BATCH_MAX;

async function flush(closing = false): Promise<void> {
  if (!enabled || !visit || queue.length === 0) return;
  if (closing) {
    const last = queue.slice(-CLOSING_MAX);
    queue = [];
    for (let i = 0; i < last.length; i += USAGE_BATCH_MAX) {
      void apiPostKeepalive("/api/usage", { visit: visit.id, events: last.slice(i, i + USAGE_BATCH_MAX) });
    }
    return;
  }
  if (Date.now() < nextSendAt) return;
  const batch = queue.slice(0, USAGE_BATCH_MAX);
  queue = queue.slice(batch.length);
  try {
    await apiPost("/api/usage", { visit: visit.id, events: batch });
    failures = 0;
  } catch (err) {
    const status = err instanceof ApiError ? err.statusCode : null;
    if (status !== null && status >= 400 && status < 500 && status !== 429) {
      // Refused for good (signed out, the enrolment gate, the route off): stop.
      enabled = false;
      queue = [];
      return;
    }
    failures++;
    nextSendAt = Date.now() + Math.min(5 * 60_000, FLUSH_MS * 2 ** failures);
    queue = [...batch, ...queue].slice(-QUEUE_MAX);
  }
}

/** Whether the page is unloading: a read it cut short says nothing about the read. */
export const isLeaving = () => leaving;

/** Where the next look-up was typed: the top bar or the Find a request box. A look-up with none came from a link. */
export function noteSearchFrom(from: "top-bar" | "request-tab"): void {
  try {
    sessionStorage.setItem(SEARCH_FROM_KEY, from);
  } catch {
    /* ignore */
  }
}

export function takeSearchFrom(): "top-bar" | "request-tab" | "link" {
  try {
    const v = sessionStorage.getItem(SEARCH_FROM_KEY);
    sessionStorage.removeItem(SEARCH_FROM_KEY);
    return v === "top-bar" || v === "request-tab" ? v : "link";
  } catch {
    return "link";
  }
}

/**
 * Asks the api once whether usage data is on and, if it is, starts sending.
 * Called by the shell on its first render; later calls do nothing.
 */
export function startUsage(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  apiGet<{ enabled: boolean }>("/api/usage/config")
    .then((c) => {
      enabled = c.enabled === true;
      if (!enabled) {
        queue = [];
        visit = null;
        return;
      }
      saveVisit();
      const markActive = () => {
        const now = Date.now();
        if (lastActive && now - lastActive < 60_000 && visit) visit.activeMs = (visit.activeMs ?? 0) + (now - lastActive);
        lastActive = now;
      };
      for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, markActive, { passive: true });
      setInterval(() => void flush(), FLUSH_MS);
      watchFrustrationAndIdle();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flush(true);
      });
      // The browser cuts a leaving page's reads off just before pagehide, so
      // leaving starts at beforeunload - and ends again if the page stayed (a
      // cancelled navigation, a download) or came back from the
      // back-forward cache.
      window.addEventListener("beforeunload", () => {
        leaving = true;
        setTimeout(() => { leaving = false; }, 3_000);
      });
      window.addEventListener("pageshow", () => { leaving = false; });
      window.addEventListener("pagehide", () => {
        leaving = true;
        if (!visit) return;
        // Sent each time the tab is left; the visit's last one holds its totals.
        push("visit_end", {
          seconds: (Date.now() - visit.start) / 1000,
          active_seconds: (visit.activeMs ?? 0) / 1000,
          pages: (visit.pages ?? []).length,
          tabs: (visit.tabs ?? []).length,
          events: visit.events ?? 0,
        });
        void flush(true);
      });
      void flush();
    })
    .catch(() => {
      enabled = false;
      queue = [];
    });
}

/** Reads that failed or answered slowly, once per view a visit. */
export function trackViewProblem(path: string, problem: "did-not-load" | "slow", seconds: number): void {
  if (leaving) return;
  const key = `${problem}:${path.split("?")[0]}`;
  if (problemsSeen.has(key)) return;
  problemsSeen.add(key);
  track("view_problem", { view: path, problem, seconds });
}

/* Time to information (`view_ready`): from a page or tab opening until the
   reads it opened with have answered. A view's reads are the ones started
   from just before it opened (its components fetch as they mount, a moment
   before the page view is recorded) to 2 s after; polls after that, and a
   previous view's slow reads, are not its own. The first view of a page load
   takes every read in flight and is timed from when the browser started
   loading. A view that started no read came from the cache: ready at 1.5 s. */
const VIEW_LEAD_MS = 500;
const VIEW_OPEN_MS = 2_000;
let readSeq = 0;
const inflightAt = new Map<number, number>();
let view: { page: string; tab: string; start: number; opened: number; pending: Set<number>; reads: number; failed: number; done: boolean } | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | null = null;
let firstView = true;

function startView(page: string, tab: string) {
  const now = Date.now();
  const first = firstView;
  firstView = false;
  const pending = new Set<number>();
  for (const [id, t] of inflightAt) if (first || t >= now - VIEW_LEAD_MS) pending.add(id);
  const start = first && typeof performance !== "undefined" ? Math.round(performance.timeOrigin) : now;
  view = { page, tab, start, opened: now, pending, reads: pending.size, failed: 0, done: false };
  if (cacheTimer) clearTimeout(cacheTimer);
  const mine = view;
  cacheTimer = setTimeout(() => {
    if (view === mine && !mine.done && mine.reads === 0) finishView(mine);
  }, 1_500);
}

function finishView(v: NonNullable<typeof view>) {
  v.done = true;
  track("view_ready", { page: v.page, tab: v.tab, seconds: (Date.now() - v.start) / 1000, reads: v.reads, failed: v.failed });
}

/** A read began; returns its handle for `readEnded`. */
export function readStarted(): number {
  const id = ++readSeq;
  const now = Date.now();
  inflightAt.set(id, now);
  if (view && !view.done && now - view.opened <= VIEW_OPEN_MS) {
    view.pending.add(id);
    view.reads++;
  }
  return id;
}

export function readEnded(id: number, ok: boolean): void {
  inflightAt.delete(id);
  if (!view || view.done || leaving || !view.pending.has(id)) return;
  view.pending.delete(id);
  if (!ok) view.failed++;
  if (view.pending.size === 0) finishView(view);
}

/* Frustration (`rage_click`): three clicks within 800 ms within 30 px of each
   other, once per 2 s. And a dashboard left open (`idle_paused`). Both set up
   with the rest once usage data is known to be on. */
function watchFrustrationAndIdle() {
  let clicks: { t: number; x: number; y: number }[] = [];
  let cooldown = 0;
  window.addEventListener("pointerdown", (e) => {
    const t = Date.now();
    clicks = [...clicks.filter((c) => t - c.t < 800 && Math.abs(c.x - e.clientX) < 30 && Math.abs(c.y - e.clientY) < 30), { t, x: e.clientX, y: e.clientY }];
    if (clicks.length >= 3 && t > cooldown) {
      cooldown = t + 2_000;
      clicks = [];
      const loc = window.location;
      // A triple-click that selected text is someone copying an ID, not frustration.
      setTimeout(() => {
        if ((window.getSelection()?.toString() ?? "").trim()) return;
        track("rage_click", { page: pageOf(loc.pathname), tab: tabOf(loc.pathname, loc.search) });
      }, 50);
    }
  }, { passive: true });
  let wasPaused = false;
  subscribeIdle(() => {
    const paused = getIdlePhase() === "paused";
    if (paused && !wasPaused) {
      const loc = window.location;
      track("idle_paused", { page: pageOf(loc.pathname), tab: tabOf(loc.pathname, loc.search) });
    }
    wasPaused = paused;
  });
}
