import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEventRecord, AuditEventsResponse } from "@sr/shared";
import { ApiError } from "@/lib/api-client";
import {
  auditLocationSearch,
  auditPositionLabel,
  DEFAULT_AUDIT_PAGE_SIZE,
  newerPage,
  newestPage,
  olderPage,
  parseAuditLocation,
  withFilters,
  withPageSize,
  type AuditLocation,
} from "@/components/audit/audit-location";
import { auditEventsPath, EMPTY_FILTERS, readAuditPage } from "@/components/audit/useAuditFeed";

/**
 * The audit log's paging — MAG-5272. The URL is the reader's position, and a
 * page is the rows next to a row, so these are the parts where a mistake shows
 * up as the wrong rows rather than a broken screen: what a link means, which
 * api read it becomes, and what a page says about the ones either side.
 */

const api = vi.hoisted(() => ({
  get: vi.fn<(path: string) => Promise<unknown>>(),
  mode: vi.fn<() => Promise<"enabled" | "disabled">>(),
}));

vi.mock("@/lib/api-client", () => {
  class ApiError extends Error {
    constructor(
      public statusCode: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { ApiError, apiGet: api.get, getAuthMode: api.mode };
});

const NEWEST = parseAuditLocation("");

describe("parseAuditLocation", () => {
  it("opens the newest page, unfiltered, with no query", () => {
    expect(NEWEST).toEqual({
      filters: EMPTY_FILTERS,
      size: DEFAULT_AUDIT_PAGE_SIZE,
      position: { kind: "newest" },
    });
  });

  it("reads back every part of a link it wrote", () => {
    const location: AuditLocation = {
      filters: {
        group: "people",
        actor: "dana@example.com",
        targetId: "ep_8143",
        from: "2026-08-01",
        to: "2026-08-09",
      },
      size: 25,
      position: { kind: "older", cursor: "eyJzZXEiOjQyfQ", page: 3 },
    };
    const search = auditLocationSearch(location);
    expect(search).toBe(
      "?group=people&actor=dana%40example.com&target=ep_8143&from=2026-08-01&to=2026-08-09" +
        "&size=25&older=eyJzZXEiOjQyfQ&page=3",
    );
    expect(parseAuditLocation(search)).toEqual(location);
    const newer = { ...location, position: { kind: "newer", cursor: "abc", page: 2 } } as const;
    expect(parseAuditLocation(auditLocationSearch(newer))).toEqual(newer);
  });

  /** A link is typed, pasted and edited by hand. A value that can't be one
   *  reads as unset rather than reaching the api as nonsense. */
  it("reads a value that can't be one as unset", () => {
    const bad = parseAuditLocation(
      "?group=nonsense&from=2026-02-31&to=yesterday&size=37&page=0&target=" + "x".repeat(129),
    );
    expect(bad.filters).toEqual(EMPTY_FILTERS);
    expect(bad.size).toBe(50);
    expect(parseAuditLocation("?older=abc&page=-1").position).toEqual({
      kind: "older",
      cursor: "abc",
      page: null,
    });
  });

  it("opens the newest page for a position that names no single page", () => {
    expect(parseAuditLocation("?older=abc&newer=def").position).toEqual({ kind: "newest" });
    expect(parseAuditLocation("?older=not%20a%20cursor").position).toEqual({ kind: "newest" });
    expect(parseAuditLocation(`?older=${"a".repeat(513)}`).position).toEqual({ kind: "newest" });
    expect(parseAuditLocation("?older=").position).toEqual({ kind: "newest" });
  });
});

describe("auditLocationSearch", () => {
  it("is empty for the newest page unfiltered, so that page has one URL", () => {
    expect(auditLocationSearch(NEWEST)).toBe("");
    expect(auditLocationSearch(withPageSize(NEWEST, 50))).toBe("");
  });
});

describe("moving between pages", () => {
  it("counts pages down from the newest", () => {
    const second = olderPage(NEWEST, "c1");
    expect(second.position).toEqual({ kind: "older", cursor: "c1", page: 2 });
    const third = olderPage(second, "c2");
    expect(third.position).toEqual({ kind: "older", cursor: "c2", page: 3 });
    expect(newerPage(third, "c3").position).toEqual({ kind: "newer", cursor: "c3", page: 2 });
  });

  it("never counts above page 1, and doesn't invent a number a link lacked", () => {
    const first = newerPage(olderPage(NEWEST, "c1"), "c2");
    expect(first.position).toMatchObject({ page: 1 });
    expect(newerPage(first, "c3").position).toMatchObject({ page: 1 });
    const unnumbered = parseAuditLocation("?older=c9");
    expect(olderPage(unnumbered, "c10").position).toMatchObject({ page: null });
  });

  /** The cursor on screen was issued for the old filters and the api refuses
   *  it under new ones, so a change of question starts at the top. */
  it("starts at the newest page when the filters or the page size change", () => {
    const deep = olderPage(olderPage(withPageSize(NEWEST, 100), "c1"), "c2");
    const refiltered = withFilters(deep, { ...EMPTY_FILTERS, group: "config" });
    expect(refiltered.position).toEqual({ kind: "newest" });
    expect(refiltered.size).toBe(100);
    const resized = withPageSize({ ...deep, filters: { ...EMPTY_FILTERS, group: "config" } }, 25);
    expect(resized.position).toEqual({ kind: "newest" });
    expect(resized.filters.group).toBe("config");
    expect(newestPage(deep).position).toEqual({ kind: "newest" });
  });
});

describe("auditPositionLabel", () => {
  const shown = (count: number, atNewest: boolean, hasOlder: boolean) => ({
    count,
    atNewest,
    hasOlder,
  });

  it("names the newest page by what it holds", () => {
    expect(auditPositionLabel(NEWEST, shown(50, true, true))).toBe("Newest 50");
    expect(auditPositionLabel(NEWEST, shown(12, true, false))).toBe("All 12 entries");
    expect(auditPositionLabel(NEWEST, shown(1, true, false))).toBe("1 entry");
  });

  it("numbers the pages below it when the link says", () => {
    const third = olderPage(olderPage(NEWEST, "a"), "b");
    expect(auditPositionLabel(third, shown(50, false, true))).toBe("Older entries · page 3");
    expect(auditPositionLabel(parseAuditLocation("?older=a"), shown(50, false, true))).toBe(
      "Older entries",
    );
  });
});

describe("auditEventsPath", () => {
  const query = (location: AuditLocation) =>
    new URLSearchParams(auditEventsPath(location).split("?")[1]);

  it("reads the newest page newest first, at the page size", () => {
    const q = query(withPageSize(NEWEST, 25));
    expect(q.get("order")).toBe("desc");
    expect(q.get("per_page")).toBe("25");
    expect(q.has("after")).toBe(false);
    expect(q.has("before")).toBe(false);
  });

  /** Newest first, so older rows come `after` a row and newer ones `before`. */
  it("reads older pages after a row and newer pages before one", () => {
    expect(query(olderPage(NEWEST, "c1")).get("after")).toBe("c1");
    const back = query(newerPage(olderPage(NEWEST, "c1"), "c2"));
    expect(back.get("before")).toBe("c2");
    expect(back.has("after")).toBe(false);
  });

  it("carries the filters onto every page", () => {
    const filtered = withFilters(NEWEST, { ...EMPTY_FILTERS, group: "config", targetId: "ep_1" });
    const q = query(olderPage(filtered, "c1"));
    expect(q.get("group")).toBe("config");
    expect(q.get("target_id")).toBe("ep_1");
  });
});

describe("readAuditPage", () => {
  const row = (n: number): AuditEventRecord => ({
    id: `id-${n}`,
    time: "2026-08-09T14:22:07.000Z",
    action: "signout",
    group: "access",
    source: "dashboard",
    actor: { type: "system", id: null, name: "System", email: null },
    target: null,
    request: null,
    note: null,
    changes: [],
  });
  const body = (
    ids: number[],
    flags: { has_more: boolean; has_previous: boolean },
  ): AuditEventsResponse => ({
    items: ids.map(row),
    cursor: ids.length ? `c${ids.at(-1)}` : null,
    start_cursor: ids.length ? `c${ids[0]}` : null,
    ...flags,
  });
  const range = (from: number, to: number) =>
    Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => (from > to ? from - i : from + i));

  beforeEach(() => {
    api.get.mockReset();
    api.mode.mockReset();
    api.mode.mockResolvedValue("enabled");
  });

  it("reads the newest page once", async () => {
    api.get.mockResolvedValueOnce(body(range(50, 1), { has_more: true, has_previous: false }));
    const answer = await readAuditPage(NEWEST);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({
      kind: "page",
      atNewest: true,
      hasNewer: false,
      hasOlder: true,
      startCursor: "c50",
      endCursor: "c1",
      arrived: null,
    });
  });

  it("knows an older page has newer entries above it", async () => {
    api.get.mockResolvedValueOnce(body(range(50, 1), { has_more: false, has_previous: true }));
    const answer = await readAuditPage(olderPage(NEWEST, "c51"));
    expect(answer).toMatchObject({ atNewest: false, hasNewer: true, hasOlder: false });
  });

  it("takes a full step back up onto the newest page as the newest page", async () => {
    api.get.mockResolvedValueOnce(body(range(100, 51), { has_more: true, has_previous: false }));
    const answer = await readAuditPage(newerPage(olderPage(NEWEST, "c51"), "c50"));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ atNewest: true, hasNewer: false, startCursor: "c100" });
  });

  /** A late write moved the boundaries, so the step back reaches the head with
   *  a few rows. The head shows whole instead of as a stub. */
  it("shows the newest page whole when the step back up comes up short", async () => {
    api.get
      .mockResolvedValueOnce(body([101], { has_more: true, has_previous: false }))
      .mockResolvedValueOnce(body(range(101, 52), { has_more: true, has_previous: false }));
    const answer = await readAuditPage(newerPage(olderPage(NEWEST, "c51"), "c100"));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get.mock.calls[1]?.[0]).not.toContain("before=");
    expect(api.get.mock.calls[1]?.[0]).not.toContain("after=");
    expect(answer).toMatchObject({ atNewest: true, startCursor: "c101", endCursor: "c52" });
  });

  /** Back on the page that was the newest, with entries recorded above it
   *  since: it stays as the reader saw it, and says how many arrived. */
  it("counts what arrived above page 1 instead of sliding it in", async () => {
    api.get
      .mockResolvedValueOnce(body(range(100, 51), { has_more: true, has_previous: true }))
      .mockResolvedValueOnce(body(range(107, 101), { has_more: true, has_previous: false }));
    const pageOne = newerPage(olderPage(NEWEST, "c51"), "c50");
    expect(pageOne.position).toMatchObject({ page: 1 });

    const answer = await readAuditPage(pageOne);
    const count = new URLSearchParams(String(api.get.mock.calls[1]?.[0]).split("?")[1]);
    expect(count.get("before")).toBe("c100");
    expect(count.get("per_page")).toBe("100");
    expect(answer).toMatchObject({
      atNewest: false,
      hasNewer: true,
      startCursor: "c100",
      arrived: { count: 7, more: false },
    });
  });

  it("does not count arrivals further down, where nothing slides", async () => {
    api.get.mockResolvedValueOnce(body(range(100, 51), { has_more: true, has_previous: true }));
    const second = newerPage(olderPage(olderPage(NEWEST, "a"), "b"), "c");
    await readAuditPage(second);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it("tells a deployment without the log apart from a failed read", async () => {
    api.mode.mockResolvedValueOnce("disabled");
    expect(await readAuditPage(NEWEST)).toEqual({ kind: "unavailable" });

    api.get.mockRejectedValueOnce(new ApiError(404, "Not Found"));
    expect(await readAuditPage(NEWEST)).toEqual({ kind: "unavailable" });

    api.get.mockRejectedValueOnce(new Error("Network Error"));
    expect(await readAuditPage(olderPage(NEWEST, "c1"))).toEqual({
      kind: "error",
      message: "Network Error",
    });
  });

  /** A link's cursor the api refuses is the link's fault, said as such — not
   *  the api's words about a parameter the reader never saw. */
  it("marks a refused position apart from a failed read", async () => {
    api.get.mockRejectedValueOnce(new ApiError(400, "`before` is not a cursor from this endpoint"));
    expect(await readAuditPage(parseAuditLocation("?newer=zzz"))).toMatchObject({
      kind: "error",
      position: true,
    });
    // On the newest page there is no position to blame: a 400 there is a
    // filter the api refused, and its words are the useful ones.
    api.get.mockRejectedValueOnce(new ApiError(400, "`actor` must be a user id or an email"));
    expect(await readAuditPage(NEWEST)).toEqual({
      kind: "error",
      message: "`actor` must be a user id or an email",
    });
  });
});
