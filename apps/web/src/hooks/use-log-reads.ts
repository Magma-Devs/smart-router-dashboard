"use client";

import { useMemo, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useApi } from "@/hooks/use-api";

/** One read of the router's logs, newest first: `more` + `nextBefore` say where the next, older read ends. */
export interface LogRead<R> {
  available: boolean;
  rows: R[];
  /** Rows the read found but couldn't read in full in time - left out of `rows`. */
  unread?: number;
  more: boolean;
  nextBefore: number | null;
  /** The times the read covers; older reads send them back as from/to. */
  range?: { startMs: number; endMs: number };
}

/** How often a live list reads again. */
export const LIVE_READ_MS = 30_000;
/** After a read the logs couldn't answer: the first wait, doubled after each one more, up to the last. */
const RETRY_FIRST_MS = 60_000;
const RETRY_LAST_MS = 300_000;

/**
 * The wait before a list's next read: none when it isn't live; every 30 s;
 * after `misses` reads in a row the logs couldn't answer, 60 s, then twice
 * as long each time up to 5 minutes, until one answers.
 */
export function nextReadMs(live: boolean, misses: number): number {
  if (!live) return 0;
  return misses > 0 ? Math.min(RETRY_LAST_MS, RETRY_FIRST_MS * 2 ** (misses - 1)) : LIVE_READ_MS;
}

/** Reads in a row the logs couldn't answer, after one more read ended. An API error is SWR's to retry. */
export function missesAfter(misses: number, ended: { data?: { available: boolean }; error?: unknown }): number {
  if (ended.error || !ended.data) return misses;
  return ended.data.available ? 0 : misses + 1;
}

/** The query with its window pinned to the times the first read covered. */
function pinned(base: string, range: { startMs: number; endMs: number } | undefined): string {
  if (!range) return base;
  return base.replace(/([?&])window=[^&]*/, `$1from=${Math.floor(range.startMs)}&to=${Math.ceil(range.endMs)}`);
}

/** The older reads of one query, and the first read they continue from. */
interface Older<T> {
  key: string;
  head: T;
  reads: T[];
  loading: boolean;
  failed: boolean;
}

/** Whether a read is running, and how many ended in a row with the logs not answering. */
const IDLE = { running: false, misses: 0 };

/**
 * A log list read one piece at a time - the Errors tab's requests and the
 * Transactions tab. A `live` list reads its first piece again every 30 s,
 * less often while the logs don't answer (`nextReadMs`); "Load older"
 * appends the next. Older reads belong to the query that made them, so a new
 * query starts over, and it shows nothing until its own first read lands.
 * Once an older read is asked for, the list continues from the first read as
 * it was then and stops reading it again: another panel polling the same key
 * must not move the seam between them. A row on the seam comes back in both
 * reads and is kept once, by GUID.
 */
export function useLogReads<R extends { guid: string }, T extends LogRead<R>>(base: string, live: boolean) {
  const [older, setOlder] = useState<Older<T> | null>(null);
  const [polls, setPolls] = useState(IDLE);
  // A new query drops the last one's older reads, so coming back to it starts fresh.
  const [readsFor, setReadsFor] = useState(base);
  const fresh = readsFor !== base;
  if (fresh) {
    setReadsFor(base);
    setOlder(null);
    setPolls(IDLE);
  }
  const mine = older?.key === base ? older : null;
  const first = useApi<T>(base, mine ? 0 : nextReadMs(live, polls.misses), { keepPreviousData: false });
  // Each read that ends is counted once: a failure's answer can equal the last one's.
  if (!fresh && first.isValidating !== polls.running) {
    setPolls({ running: first.isValidating, misses: polls.running ? missesAfter(polls.misses, first) : polls.misses });
  }
  const head = mine ? mine.head : (first.data ?? null);
  const reads = mine?.reads;
  const last = reads?.[reads.length - 1] ?? head;

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: R[] = [];
    for (const read of [head, ...(reads ?? [])]) {
      for (const r of read?.rows ?? []) if (!seen.has(r.guid)) { seen.add(r.guid); out.push(r); }
    }
    return out;
  }, [head, reads]);

  const loadOlder = async () => {
    if (!head || last?.nextBefore == null || mine?.loading) return;
    const key = base;
    setOlder({ key, head, reads: reads ?? [], loading: true, failed: false });
    const done = (patch: (prev: Older<T>) => Older<T>) =>
      setOlder((prev) => (prev && prev.key === key ? patch(prev) : prev));
    try {
      // The first read's own times: a window resent later would have moved with the clock.
      const next = await apiGet<T>(`${pinned(key, head.range)}&before=${last.nextBefore}`);
      // A read that couldn't reach the logs is a failure to retry, not the end of the list.
      done((prev) => (next.available ? { ...prev, reads: [...prev.reads, next], loading: false } : { ...prev, loading: false, failed: true }));
    } catch {
      done((prev) => ({ ...prev, loading: false, failed: true }));
    }
  };

  // Rows the reads on screen found but couldn't read in full; a later read of the same stretch may.
  const unread = [head, ...(reads ?? [])].reduce((n, read) => n + (read?.unread ?? 0), 0);
  // A poll of a list already on screen - the rows stay up while it runs.
  const refreshing = !mine && first.isValidating && !!first.data;

  // Where the reads on screen begin, while older ones are still to load (unix ms).
  const readFrom = last?.more ? last.nextBefore : null;

  return { first, head, rows, unread, refreshing, more: last?.more ?? false, readFrom, loadOlder, loadingOlder: mine?.loading ?? false, olderFailed: mine?.failed ?? false };
}

/** What a list hook gives its table: the reads on screen and how to read on. */
export type LogReads<R extends { guid: string }, T extends LogRead<R>> = ReturnType<typeof useLogReads<R, T>>;
