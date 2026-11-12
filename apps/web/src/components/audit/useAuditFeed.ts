"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuditEventRecord, AuditEventsResponse } from "@sr/shared";
import { ApiError, apiGet, getAuthMode } from "@/lib/api-client";
import { localDayEndIso, localDayStartIso } from "@/lib/datetime";
import {
  auditLocationSearch,
  newestPage,
  type AuditLocation,
} from "@/components/audit/audit-location";

/**
 * The audit feed, a page at a time — MAG-2770, paged by MAG-5272.
 *
 * **Deliberately not `useApi`.** Every other panel in this app is a live gauge
 * on a 15-second SWR poll; this is a record, and the two want opposite things.
 * The poll would re-read the newest page under someone reading it, and
 * silently reordering a list somebody is reading is worse than making them
 * ask: nothing here changes on its own in a way a reader needs within fifteen
 * seconds. Refresh is a button. Plain state plus `apiGet` is the honest fit.
 *
 * Which page is the URL's (`audit-location.ts`): the newest, or the one older
 * or newer than a row. Moving between them is a keyset read from that row, so
 * new entries at the head never shift the page someone is on; stepping back up
 * to the page that was the newest says how many have arrived above it.
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
  /** `yyyy-mm-dd`, inclusive at both ends: days on the reader's clock, the
   *  one the log's times are shown in. */
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

/** `to` is inclusive: a reader who types the 9th means the whole of the 9th,
 *  not midnight at the start of it. */
function filterParams(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.group) params.set("group", filters.group);
  if (filters.actor.trim()) params.set("actor", filters.actor.trim());
  if (filters.targetId.trim()) params.set("target_id", filters.targetId.trim());
  if (filters.from) params.set("from", localDayStartIso(filters.from));
  if (filters.to) params.set("to", localDayEndIso(filters.to));
  return params;
}

/**
 * The api read for a location. Newest first, so in the api's words `after` a
 * row is older and `before` it is newer.
 */
export function auditEventsPath(location: AuditLocation): string {
  const params = filterParams(location.filters);
  params.set("order", "desc");
  params.set("per_page", String(location.size));
  const { position } = location;
  if (position.kind === "older") params.set("after", position.cursor);
  if (position.kind === "newer") params.set("before", position.cursor);
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

/** How far "N new entries" counts before it says "N+". */
const ARRIVED_CAP = 100;

export interface AuditPageRead {
  items: AuditEventRecord[];
  /** The first row's position (Newer reads ahead of it) and the last row's
   *  (Older reads on from it). Null on an empty page. */
  startCursor: string | null;
  endCursor: string | null;
  /** This is the newest page there is. */
  atNewest: boolean;
  hasNewer: boolean;
  hasOlder: boolean;
  /** Entries recorded above page 1 since it was the newest page: counted when
   *  a reader steps back up to it, up to `ARRIVED_CAP`. */
  arrived: { count: number; more: boolean } | null;
}

export type AuditPageAnswer =
  | ({ kind: "page" } & AuditPageRead)
  /** `position` when the api refused the link's cursor (a 400 for a page
   *  other than the newest): edited by hand, or its filters changed. */
  | { kind: "error"; message: string; position?: true }
  /** No audit log on this deployment at all, rather than an empty one —
   *  `AUTH_MODE=disabled` never registers the routes. */
  | { kind: "unavailable" };

function pageOf(
  body: AuditEventsResponse,
  atNewest: boolean,
  arrived: AuditPageRead["arrived"],
): AuditPageAnswer {
  return {
    kind: "page",
    items: body.items,
    startCursor: body.start_cursor,
    endCursor: body.cursor,
    atNewest,
    hasNewer: !atNewest && body.has_previous,
    hasOlder: body.has_more,
    arrived,
  };
}

/** One location's page: a single read, plus a second only on page 1 when
 *  stepping back up meets the newest entries (see below). */
export async function readAuditPage(location: AuditLocation): Promise<AuditPageAnswer> {
  try {
    if ((await getAuthMode()) === "disabled") return { kind: "unavailable" };
    const body = await apiGet<AuditEventsResponse>(auditEventsPath(location));
    const { position } = location;

    if (position.kind === "newer" && !body.has_previous) {
      // Stepped back up onto the newest page. A step that came up short — a
      // late write moved the page boundaries, or the link was made by hand —
      // shows the newest page whole instead, so the head is always full.
      if (body.items.length >= location.size) return pageOf(body, true, null);
      const head = await apiGet<AuditEventsResponse>(auditEventsPath(newestPage(location)));
      return pageOf(head, true, null);
    }

    // Back on the page that was the newest, with newer entries above it now:
    // say how many, rather than slide them in over what the reader saw.
    let arrived: AuditPageRead["arrived"] = null;
    if (position.kind === "newer" && position.page === 1 && body.start_cursor) {
      const above = await apiGet<AuditEventsResponse>(
        auditEventsPath({
          ...location,
          size: ARRIVED_CAP,
          position: { kind: "newer", cursor: body.start_cursor, page: null },
        }),
      );
      arrived = { count: above.items.length, more: above.has_previous };
    }
    return pageOf(body, position.kind === "newest", arrived);
  } catch (err) {
    if (err instanceof ApiError && err.statusCode === 404) {
      // The routes are registered only in AUTH_MODE=enabled. getAuthMode
      // should already have caught that; a 404 here means the deployment
      // disagrees with its own config, which is not something to explain
      // away with an env-var suggestion.
      return { kind: "unavailable" };
    }
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not load the audit log",
      ...(err instanceof ApiError && err.statusCode === 400 && location.position.kind !== "newest"
        ? { position: true as const }
        : {}),
    };
  }
}

export interface AuditFeed {
  /** The page to show: this location's once it answers, the previous one's
   *  until then, so a page step doesn't blank the table. */
  page: AuditPageRead | null;
  /** Its rows; empty while there is no page. */
  items: AuditEventRecord[];
  /** From the render the location changes in until its page answers. Every
   *  control that moves from a row's position is disabled meanwhile: the
   *  cursors on screen belong to the previous page, and under new filters the
   *  api refuses them. */
  loading: boolean;
  error: string | null;
  /** The error is the api refusing the link's position, not a failed read. */
  badPosition: boolean;
  unavailable: boolean;
  refresh: () => void;
}

export function useAuditFeed(location: AuditLocation): AuditFeed {
  const key = auditLocationSearch(location);
  const [round, setRound] = useState(0);
  const [settled, setSettled] = useState<{
    key: string;
    round: number;
    answer: AuditPageAnswer;
  } | null>(null);

  // `loading` is derived rather than set, so it is already true in the render
  // a location changes in — before this effect, and with no setState inside
  // it. A read that answers after the location moved on is dropped.
  useEffect(() => {
    let current = true;
    void readAuditPage(location).then((answer) => {
      if (current) setSettled({ key, round, answer });
    });
    return () => {
      current = false;
    };
  }, [key, location, round]);

  const refresh = useCallback(() => setRound((r) => r + 1), []);

  const loading = settled === null || settled.key !== key || settled.round !== round;
  const answer = settled?.answer ?? null;
  const now = loading ? null : answer;
  const page = answer?.kind === "page" ? answer : null;
  return {
    page,
    items: page?.items ?? [],
    loading,
    error: now?.kind === "error" ? now.message : null,
    badPosition: now?.kind === "error" && now.position === true,
    unavailable: now?.kind === "unavailable",
    refresh,
  };
}
