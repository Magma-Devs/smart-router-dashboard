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
import { apiGet, apiPost, apiPostKeepalive } from "./api-client";

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

export function pageOf(pathname: string): "metrics" | "upstreams" | "team" | "audit" | "account" | "other" {
  const first = pathname.split("/")[1] ?? "";
  return first === "metrics" || first === "upstreams" || first === "team" || first === "audit" || first === "account" ? first : "other";
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
    const loc = window.location;
    push("visit_start", {
      arrived: arrivedFrom(loc.search),
      page: pageOf(loc.pathname),
      tab: tabOf(loc.pathname, loc.search),
      window: new URLSearchParams(loc.search).get("window") ?? undefined,
      chain_picked: !!new URLSearchParams(loc.search).get("chain"),
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
  if (queue.length >= FLUSH_AT) void flush();
}

async function flush(closing = false): Promise<void> {
  if (!enabled || !visit || queue.length === 0) return;
  const batch = queue.slice(0, USAGE_BATCH_MAX);
  queue = queue.slice(batch.length);
  const body = { visit: visit.id, events: batch };
  if (closing) return apiPostKeepalive("/api/usage", body);
  try {
    await apiPost("/api/usage", body);
  } catch {
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
        return;
      }
      const markActive = () => {
        const now = Date.now();
        if (lastActive && now - lastActive < 60_000 && visit) visit.activeMs = (visit.activeMs ?? 0) + (now - lastActive);
        lastActive = now;
      };
      for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(ev, markActive, { passive: true });
      setInterval(() => void flush(), FLUSH_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") void flush(true);
      });
      window.addEventListener("beforeunload", () => { leaving = true; });
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
const problemsSeen = new Set<string>();
export function trackViewProblem(path: string, problem: "did-not-load" | "slow", seconds: number): void {
  if (leaving) return;
  const key = `${problem}:${path.split("?")[0]}`;
  if (problemsSeen.has(key)) return;
  problemsSeen.add(key);
  track("view_problem", { view: path, problem, seconds });
}
