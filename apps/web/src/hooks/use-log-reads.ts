"use client";

import { useMemo, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useApi } from "@/hooks/use-api";

/** One read of the router's logs, newest first: `more` + `nextBefore` say where the next, older read ends. */
export interface LogRead<R> {
  rows: R[];
  more: boolean;
  nextBefore: number | null;
}

/**
 * A log list read one piece at a time - the Errors tab's requests and the
 * Transactions tab. The first read polls like any panel; "Load older" appends
 * the next. Older reads belong to the query that made them, so a new query
 * starts over, and once any is loaded the first read holds still: a refresh
 * would move the seam between them. A row on the seam comes back in both
 * reads and is kept once, by GUID.
 */
export function useLogReads<R extends { guid: string }, T extends LogRead<R>>(base: string) {
  const [older, setOlder] = useState<{ key: string; reads: T[] }>({ key: "", reads: [] });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const olderReads = useMemo(() => (older.key === base ? older.reads : []), [older, base]);
  const first = useApi<T>(base, olderReads.length ? 0 : 15000);
  const last = olderReads[olderReads.length - 1] ?? first.data;

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: R[] = [];
    for (const read of [first.data, ...olderReads]) {
      for (const r of read?.rows ?? []) if (!seen.has(r.guid)) { seen.add(r.guid); out.push(r); }
    }
    return out;
  }, [first.data, olderReads]);

  const loadOlder = async () => {
    if (last?.nextBefore == null) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const next = await apiGet<T>(`${base}&before=${last.nextBefore}`);
      setOlder({ key: base, reads: [...olderReads, next] });
    } catch {
      setOlderFailed(true); // the button stays: another try may work
    } finally {
      setLoadingOlder(false);
    }
  };

  return { first, rows, more: last?.more ?? false, loadOlder, loadingOlder, olderFailed };
}
