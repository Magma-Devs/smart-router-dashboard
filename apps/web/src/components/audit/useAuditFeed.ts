"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuditEventRecord, AuditEventsResponse } from "@sr/shared";
import { ApiError, apiGet, getAuthMode } from "@/lib/api-client";

/**
 * The audit feed — MAG-2770.
 *
 * **Deliberately not `useApi`.** Every other panel in this app is a live gauge
 * on a 15-second SWR poll; this is a record, and the two want opposite things.
 * SWR keys a cache by URL, but a cursor feed's position lives in the *sequence*
 * of requests, so the key would have to encode an accumulated state — and the
 * refresh interval would re-fetch page one underneath pages two onward. Plain
 * state plus `apiGet` is the honest fit.
 *
 * No auto-poll for the same reason: nothing here changes on its own in a way a
 * reader needs within fifteen seconds, and silently reordering a list somebody
 * is reading is worse than making them ask. Refresh is a button.
 */

export interface AuditFilters {
  /** One of `AUDIT_GROUPS`, or empty for all. */
  group: string;
  /** Email address. The API also takes a user id, but a free-text box that
   *  rejects "dana" is a poor control, so this one is labelled and validated
   *  as an address. */
  actor: string;
  /** Object id, e.g. `ep_8143`. */
  targetId: string;
  /** `yyyy-mm-dd`, inclusive at both ends. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditFilters = {
  group: "",
  actor: "",
  targetId: "",
  from: "",
  to: "",
};

export function hasAnyFilter(f: AuditFilters): boolean {
  return Object.values(f).some((v) => v.trim() !== "");
}

const PAGE_SIZE = 50;

/** `to` is inclusive: a reader who types the 9th means the whole of the 9th,
 *  not midnight at the start of it. */
function filterParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.group) params.set("group", filters.group);
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.targetId.trim()) params.set("target_id", filters.targetId.trim());
  if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00.000Z`).toISOString());
  if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999Z`).toISOString());
  return params;
}

function toQuery(filters: AuditFilters, after: string | null): string {
  const params = filterParams(filters);
  params.set("order", "desc");
  params.set("per_page", String(PAGE_SIZE));
  if (after) params.set("after", after);
  return `/api/audit/events?${params.toString()}`;
}

/**
 * The export path for what is currently on screen.
 *
 * Built from the same `filterParams` as the feed, so the file someone downloads
 * always answers the same question the screen is showing. Chronological rather
 * than newest-first: the download is an archive to sort and filter, and reverse
 * order is a reading convenience that a spreadsheet undoes in one click.
 */
export function auditExportPath(filters: AuditFilters): string {
  const params = filterParams(filters);
  const qs = params.toString();
  return `/api/audit/export.csv${qs ? `?${qs}` : ""}`;
}

export interface AuditFeed {
  items: AuditEventRecord[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  /** True when this deployment has no audit log at all, rather than an empty
   *  one — `AUTH_MODE=disabled` never registers the routes. */
  unavailable: boolean;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}

export function useAuditFeed(filters: AuditFilters): AuditFeed {
  const [items, setItems] = useState<AuditEventRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Every fetch carries the generation it was started in. A filter change or a
  // refresh bumps it, so a slow response from the previous query can't append
  // its rows to a list that has moved on.
  const generation = useRef(0);

  const load = useCallback(
    async (after: string | null, gen: number) => {
      if (after) setLoadingMore(true);
      else setLoading(true);
      try {
        if ((await getAuthMode()) === "disabled") {
          if (generation.current !== gen) return;
          setUnavailable(true);
          setItems([]);
          setHasMore(false);
          return;
        }
        const page = await apiGet<AuditEventsResponse>(toQuery(filters, after));
        if (generation.current !== gen) return;
        setUnavailable(false);
        setError(null);
        // Append only when continuing; a fresh query replaces, so Refresh
        // cannot leave stale rows below newly-fetched ones.
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setCursor(page.cursor);
        setHasMore(page.has_more);
      } catch (err) {
        if (generation.current !== gen) return;
        if (err instanceof ApiError && err.statusCode === 404) {
          // The routes are registered only in AUTH_MODE=enabled. getAuthMode
          // should already have caught that; a 404 here means the deployment
          // disagrees with its own config, which is not something to explain
          // away with an env-var suggestion.
          setUnavailable(true);
          setItems([]);
        } else {
          setError(err instanceof Error ? err.message : "Could not load the audit log");
        }
        setHasMore(false);
      } finally {
        if (generation.current === gen) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filters],
  );

  // Any filter change starts a new feed: the cursor belongs to the filter set it
  // was issued for, and the API refuses one that has moved.
  //
  // The stale cursor is not cleared here. It doesn't need to be — `load` flips
  // `loading` before its first await and `loadMore` refuses to fire while that
  // is set, so the old value is unreachable until the response replaces it.
  // Clearing it would be a setState inside an effect for no gain.
  useEffect(() => {
    void load(null, ++generation.current);
  }, [load]);

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore || loading) return;
    void load(cursor, generation.current);
  }, [cursor, load, loading, loadingMore]);

  const refresh = useCallback(() => {
    void load(null, ++generation.current);
  }, [load]);

  return { items, loading, loadingMore, error, unavailable, hasMore, loadMore, refresh };
}
