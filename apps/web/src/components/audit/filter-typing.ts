"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { parseAuditLocation, withFilters, type AuditLocation } from "@/components/audit/audit-location";

/**
 * The audit log's two typed filters, Person and Object id — MAG-5291.
 *
 * A filter lives in the page's URL (`audit-location.ts`), and every new URL is
 * a new read. Written on each keystroke, that is a read per letter, and for
 * Person most of them are refused: the api takes a user id (UUID) or an email
 * address, so "d", "da" … "dana" each answer 400 until the "@", and the page
 * flashed its error state while someone typed an address.
 *
 * So a box holds what is typed as a draft, and the draft reaches the URL:
 *  - after a pause in typing (`FILTER_PAUSE_MS`), when the api would take it.
 *    A Person draft it would refuse ("dana") stays in the box, unsent: it can
 *    still become an address.
 *  - when the reader finishes it — Enter, or leaving the box — whatever it
 *    is. A finished value the api refuses shows the page's error state, as
 *    the same value in a link does.
 *
 * One run of typing in one box is one history entry, as it was when each
 * keystroke went straight to the URL (MAG-5272): its first value pushes an
 * entry and the rest rewrite it, so Back undoes the word, not one letter.
 * Anything else that moves the location ends the run.
 */

export type TextFilter = "actor" | "targetId";

export type HistoryMode = "push" | "replace";

/** Long enough to span the gap between letters typed at an ordinary pace,
 *  short enough that the list answers as soon as the hand stops. */
export const FILTER_PAUSE_MS = 350;

/** The api's own test (`apps/api/src/routes/audit.ts`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the api takes this as `actor`, by its rule exactly: a user id (a
 * UUID) or an email address, which it reads as anything with an "@" in it.
 * Empty is no filter at all. Trimmed first, because the page sends it trimmed.
 */
export function actorAccepted(value: string): boolean {
  const v = value.trim();
  return v === "" || UUID.test(v) || v.includes("@");
}

/** Whether a draft may go to the api before the reader has finished it. The
 *  api takes any object id, so only Person waits. */
export function draftReady(field: TextFilter, value: string): boolean {
  return field === "actor" ? actorAccepted(value) : true;
}

export type FilterDrafts = Readonly<Partial<Record<TextFilter, string>>>;

export interface FilterTypingOptions {
  /** Puts a box's value into the location. False when that changed nothing
   *  (the value it already had): no history entry, so no run starts. */
  commit: (field: TextFilter, value: string, how: HistoryMode) => boolean;
  pauseMs?: number;
}

/**
 * The drafts and the pauses, free of React so the timing can be tested. The
 * boxes read `getDrafts()`; a field with no draft shows the location's value.
 */
export class FilterTyping {
  private drafts: FilterDrafts = {};
  private readonly timers = new Map<TextFilter, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  /** The box whose value went into the location last, if nothing else has
   *  moved the location since: its next value rewrites that entry. */
  private run: TextFilter | null = null;

  constructor(private readonly options: FilterTypingOptions) {}

  /** A keystroke. The box shows `value` now; the location gets it after a
   *  pause, if the api would take it. */
  type = (field: TextFilter, value: string): void => {
    this.stopTimer(field);
    this.setDrafts({ ...this.drafts, [field]: value });
    this.timers.set(
      field,
      setTimeout(() => this.settle(field, false), this.options.pauseMs ?? FILTER_PAUSE_MS),
    );
  };

  /** Enter, or leaving the box: what it holds goes now, valid or not. */
  finish = (field: TextFilter): void => {
    this.stopTimer(field);
    this.settle(field, true);
  };

  /** Something other than typing moved the location — another filter, a page
   *  step: the next typed value is a history entry of its own. */
  endRun = (): void => {
    this.run = null;
  };

  /** The location moved under the boxes — Back / Forward, Clear filters, the
   *  page going away: every draft and pending pause is dropped, and the boxes
   *  show the location's values. */
  reset = (): void => {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.run = null;
    if (Object.keys(this.drafts).length > 0) this.setDrafts({});
  };

  getDrafts = (): FilterDrafts => this.drafts;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private settle(field: TextFilter, finished: boolean): void {
    const value = this.drafts[field];
    if (value === undefined) return;
    if (!finished && !draftReady(field, value)) return;
    const moved = this.options.commit(field, value, this.run === field ? "replace" : "push");
    if (moved) this.run = field;
    const rest: Partial<Record<TextFilter, string>> = { ...this.drafts };
    delete rest[field];
    this.setDrafts(rest);
  }

  private stopTimer(field: TextFilter): void {
    const timer = this.timers.get(field);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(field);
  }

  private setDrafts(next: FilterDrafts): void {
    this.drafts = next;
    for (const notify of this.listeners) notify();
  }
}

/**
 * Where a typed value takes the page at `search`, or null when it is the value
 * the filter already has. Like any filter change it opens the newest page. A
 * run rewrites its entry only while the reader is still on the newest page:
 * anywhere else, the value is an entry of its own.
 */
export function typedMove(
  search: string,
  field: TextFilter,
  value: string,
  how: HistoryMode,
): { next: AuditLocation; how: HistoryMode } | null {
  const now = parseAuditLocation(search);
  if (now.filters[field] === value) return null;
  return {
    next: withFilters(now, { ...now.filters, [field]: value }),
    how: how === "replace" && now.position.kind === "newest" ? "replace" : "push",
  };
}

/**
 * The typed filters of the page `go` moves (`useAuditLocation`'s, which never
 * changes). A value is written into the location as the URL stands when it is
 * sent, so a pause that ends after another filter or a page step builds on
 * that rather than on the render the pause started in.
 */
export function useFilterTyping(go: (next: AuditLocation, how: HistoryMode) => void): {
  typing: FilterTyping;
  drafts: FilterDrafts;
} {
  const [typing] = useState(
    () =>
      new FilterTyping({
        commit: (field, value, how) => {
          const move = typedMove(window.location.search, field, value, how);
          if (!move) return false;
          go(move.next, move.how);
          return true;
        },
      }),
  );
  const drafts = useSyncExternalStore(typing.subscribe, typing.getDrafts, typing.getDrafts);
  useEffect(() => {
    window.addEventListener("popstate", typing.reset);
    return () => {
      window.removeEventListener("popstate", typing.reset);
      typing.reset();
    };
  }, [typing]);
  return { typing, drafts };
}
