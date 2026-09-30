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

/**
 * A log list read one piece at a time - the Errors tab's requests and the
 * Transactions tab. The first read polls every `refreshMs` (0 = never);
 * "Load older" appends the next. Older reads belong to the query that made
 * them, so a new query starts over, and it shows nothing until its own first
 * read lands. Once an older read is asked for, the list continues from the
 * first read as it was then: another panel polling the same key must not
 * move the seam between them. A row on the seam comes back in both reads and
 * is kept once, by GUID.
 */
export function useLogReads<R extends { guid: string }, T extends LogRead<R>>(base: string, refreshMs = 15000) {
  const [older, setOlder] = useState<Older<T> | null>(null);
  // A new query drops the last one's older reads, so coming back to it starts fresh.
  const [readsFor, setReadsFor] = useState(base);
  if (readsFor !== base) {
    setReadsFor(base);
    setOlder(null);
  }
  const mine = older?.key === base ? older : null;
  const first = useApi<T>(base, mine ? 0 : refreshMs, { keepPreviousData: false });
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

  return { first, head, rows, unread, refreshing, more: last?.more ?? false, loadOlder, loadingOlder: mine?.loading ?? false, olderFailed: mine?.failed ?? false };
}
