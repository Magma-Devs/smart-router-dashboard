"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { AUDIT_GROUPS } from "@sr/shared";
import type { AuditFilters } from "@/components/audit/useAuditFeed";

/**
 * Where the reader is in the audit log, kept in the page's URL — MAG-5272.
 *
 *   group · actor · target · from · to   the filters
 *   size                                  rows per page: 25, 50 or 100 (50 stays out)
 *   older=<cursor>                        the page of entries older than a row
 *   newer=<cursor>                        the page of entries newer than a row
 *   page                                  how many pages down from the newest; a label only
 *
 * No cursor is the newest page. A position is a row, never an offset: the
 * entries on a page are the ones next to that row, so entries recorded at the
 * head while someone reads further down never move what they see, and a
 * reload, Back / Forward or a shared link opens the same page. The cursor is
 * the api's own (`cursor` / `start_cursor`), so it carries the filters it was
 * issued for, and the api refuses it under any others: changing a filter or
 * the page size starts again from the newest page.
 *
 * Kept free of the page so it can be tested; `useAuditLocation` reads and
 * writes the URL.
 */

export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
export type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number];
export const DEFAULT_AUDIT_PAGE_SIZE: AuditPageSize = 50;

export type AuditPosition =
  | { kind: "newest" }
  /** `page` is null when the URL doesn't say, and the label then doesn't
   *  either. */
  | { kind: "older" | "newer"; cursor: string; page: number | null };

export interface AuditLocation {
  filters: AuditFilters;
  size: AuditPageSize;
  position: AuditPosition;
}

const NEWEST: AuditPosition = { kind: "newest" };

/** An api cursor is base64url and about 110 characters; the api caps it at
 *  512 too. Anything else in the URL is not one, and opens the newest page. */
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The api's own column widths: `actor_email` 255, `target_id` 128. */
const ACTOR_MAX = 255;
const TARGET_MAX = 128;
const PAGE_MAX = 1_000_000;

/** A real calendar day. `Date` would roll 2026-02-31 over to March 3rd. */
function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** What a URL's query asks for. A value that can't be one reads as unset. */
export function parseAuditLocation(search: string): AuditLocation {
  const q = new URLSearchParams(search);
  const text = (key: string, max: number) => {
    const value = q.get(key) ?? "";
    return value.length <= max ? value : "";
  };
  const group = q.get("group") ?? "";
  const from = q.get("from") ?? "";
  const to = q.get("to") ?? "";
  const filters: AuditFilters = {
    group: (AUDIT_GROUPS as readonly string[]).includes(group) ? group : "",
    actor: text("actor", ACTOR_MAX),
    targetId: text("target", TARGET_MAX),
    from: isDay(from) ? from : "",
    to: isDay(to) ? to : "",
  };

  const asked = Number(q.get("size"));
  const size = AUDIT_PAGE_SIZES.find((s) => s === asked) ?? DEFAULT_AUDIT_PAGE_SIZE;

  const rawPage = q.get("page") ?? "";
  const page =
    /^[1-9]\d{0,6}$/.test(rawPage) && Number(rawPage) <= PAGE_MAX ? Number(rawPage) : null;
  const older = q.get("older");
  const newer = q.get("newer");
  let position: AuditPosition = NEWEST;
  // Both at once names no single page.
  if (older !== null && newer === null && CURSOR.test(older)) {
    position = { kind: "older", cursor: older, page };
  } else if (newer !== null && older === null && CURSOR.test(newer)) {
    position = { kind: "newer", cursor: newer, page };
  }
  return { filters, size, position };
}

/** The query string for a location, `""` for the newest page unfiltered.
 *  Always in the same order, so one view has one URL. */
export function auditLocationSearch(location: AuditLocation): string {
  const q = new URLSearchParams();
  const { filters, size, position } = location;
  if (filters.group) q.set("group", filters.group);
  if (filters.actor) q.set("actor", filters.actor);
  if (filters.targetId) q.set("target", filters.targetId);
  if (filters.from) q.set("from", filters.from);
  if (filters.to) q.set("to", filters.to);
  if (size !== DEFAULT_AUDIT_PAGE_SIZE) q.set("size", String(size));
  if (position.kind !== "newest") {
    q.set(position.kind, position.cursor);
    if (position.page !== null) q.set("page", String(position.page));
  }
  const qs = q.toString();
  return qs ? `?${qs}` : "";
}

/** Pages down from the newest; the newest page is 1. */
function pageNumber(location: AuditLocation): number | null {
  return location.position.kind === "newest" ? 1 : location.position.page;
}

export function newestPage(location: AuditLocation): AuditLocation {
  return { ...location, position: NEWEST };
}

/** The page after the row `cursor` names, one further down. */
export function olderPage(location: AuditLocation, cursor: string): AuditLocation {
  const page = pageNumber(location);
  return {
    ...location,
    position: { kind: "older", cursor, page: page === null ? null : page + 1 },
  };
}

/** The page ahead of the row `cursor` names, one further up. */
export function newerPage(location: AuditLocation, cursor: string): AuditLocation {
  const page = pageNumber(location);
  return {
    ...location,
    position: { kind: "newer", cursor, page: page === null ? null : Math.max(1, page - 1) },
  };
}

/** Other filters ask another question, so the answer starts at its newest. */
export function withFilters(location: AuditLocation, filters: AuditFilters): AuditLocation {
  return { filters, size: location.size, position: NEWEST };
}

/** Page numbers counted in 25s mean nothing in 100s, so a new size starts at
 *  the newest page too. */
export function withPageSize(location: AuditLocation, size: AuditPageSize): AuditLocation {
  return { ...location, size, position: NEWEST };
}

/** What the reader is looking at, in words: "Newest 50", "Older entries · page 3". */
export function auditPositionLabel(
  location: AuditLocation,
  shown: { count: number; atNewest: boolean; hasOlder: boolean },
): string {
  if (shown.atNewest) {
    if (shown.hasOlder) return `Newest ${shown.count}`;
    return shown.count === 1 ? "1 entry" : `All ${shown.count} entries`;
  }
  const page = location.position.kind === "newest" ? null : location.position.page;
  return page === null ? "Older entries" : `Older entries · page ${page}`;
}

/* ── The URL as a store ───────────────────────────────────────────────────── */

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("popstate", onChange);
  };
}

const readSearch = () => window.location.search;
/** The server renders the newest page; the client takes the URL's from there. */
const serverSearch = () => "";

/**
 * The location in the URL, and a way to move it. Back / Forward re-read it.
 * `push` makes a history entry (a page step, a filter picked); `replace`
 * rewrites the one it is on (each keystroke of a filter being typed).
 */
export function useAuditLocation(): {
  location: AuditLocation;
  go: (next: AuditLocation, how: "push" | "replace") => void;
} {
  const search = useSyncExternalStore(subscribe, readSearch, serverSearch);
  const location = useMemo(() => parseAuditLocation(search), [search]);
  const go = useCallback((next: AuditLocation, how: "push" | "replace") => {
    const url = new URL(window.location.href);
    url.search = auditLocationSearch(next);
    if (url.href === window.location.href) return;
    if (how === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    for (const notify of listeners) notify();
  }, []);
  return { location, go };
}
