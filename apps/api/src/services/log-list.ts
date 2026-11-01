/**
 * How the two log lists - the Errors tab's requests and the Transactions tab -
 * read the router's logs, and how a live list reads only what is new.
 *
 * A read runs the list's finders: line filters whose lines find its requests,
 * each read newest first up to its limit. It keeps the `cap` requests with the
 * newest finder lines, and reads the rest of the lines of those it found by a
 * line other than their relay_end (`linesForGuids`). Loki opens every chunk of
 * the selected streams a read spans, whatever its filters match, so a read
 * costs its span.
 *
 * A live list - a page window, no `before` - keeps its last read (a `Head`).
 * The next poll runs the finders only from LATE_MS before where that read
 * ended, adds the head's older lines still in the window, and keeps each
 * finder's newest `limit` lines, as a read of the whole window would. It reads
 * the rest of the lines only of requests that are new, or whose lines can
 * still come: those end `afterMs` after a line that found the request, and
 * may show up LATE_MS after their own time. Rows, `more` and `nextBefore` come
 * out as a read of the whole window gives them. A poll builds only on a whole
 * read at most HEAD_FRESH_MS old made on the same queries and values file;
 * otherwise, or when the merge can't tell, it reads the window whole. A whole
 * read may start later than the window (`wholeFrom`); its polls keep the
 * stretch before as the next, older read's.
 */
import { liveWindow, readEnd, readOnFrom, type ReadRange } from "./read-range.js";
import { isRelayEnd } from "./relay-end.js";
import type { LokiClient, LokiLine } from "./loki-client.js";
import { linesForGuids, parseRouterLine, type RouterLine } from "./router-log.js";
import { ReadMemo, remember } from "./read-memo.js";

/**
 * How long after its own time a line may become readable: the log agent's
 * batching and retries, Loki's ingest path, and the clock between the
 * router's node and this api - seconds, normally. A poll reads this much of
 * what the last read covered again, and a request's lines are taken as whole
 * only this long after the last of them can have been written.
 */
export const LATE_MS = 60_000;

/** A poll builds on a whole read at most this old: past it, the window is read whole again. */
export const HEAD_FRESH_MS = 10 * 60_000;

/** A live list's answer is reused this long: viewers polling it in that time share one read. */
export const LIVE_KEEP_MS = 15_000;

/** A range that ended LATE_MS ago no longer changes: its answer is kept this long. */
export const SETTLED_KEEP_MS = 5 * 60_000;

/** A read Loki didn't answer, in whole or in part, is kept this long: viewers' polls don't each ask again. */
export const FAILED_KEEP_MS = 30_000;

/** Answers kept per list: one per window, filter and range in use. */
const ANSWERS_KEPT = 32;

/** Live lists whose last read is kept per list: past it, the least recently read is read whole next time. */
export const HEADS_KEPT = 8;

/** A line filter that finds a list's requests; a read returns its newest `limit` lines. */
export interface Finder {
  query: string;
  limit: number;
}

/** How the rest of a request's lines are read, around the lines that found it. */
export interface FollowUp {
  messages: string[];
  perGuid: number;
  /** A request's lines start at most this long before a line that found it... */
  beforeMs: number;
  /** ...and end at most this long after one. */
  afterMs: number;
}

export interface ListPlan<Row> {
  finders: Finder[];
  follow: FollowUp;
  /** Requests one read keeps. */
  cap: number;
  /** The rows a set of lines makes, one per request and from its lines alone - so a request's row can be kept. */
  rowsOf: (lines: RouterLine[]) => Row[];
  /** What the rows depend on besides the lines (the values file): a head made on another is not built on. */
  basis: string;
  /**
   * Where a read of the whole range starts, when later than the range's own
   * start - a cap on what one read scans. The stretch before it is the next,
   * older read's: a cut, which every poll built on that read keeps while it
   * is inside the window.
   */
  wholeFrom?: (range: ReadRange) => Promise<number>;
}

/** A finder's line, as much of it as a later poll needs. */
interface Seen {
  tsMs: number;
  /** Null for a line the parser drops: it still counts against the finder's limit. */
  guid: string | null;
  /** The line, when it is a relay_end: its request's row is read from it alone. */
  end?: RouterLine;
}

/** A request whose other lines were read, and the row they made. */
interface Followed<Row> {
  row: Row | null;
  /** Its newest finder line when they were read. */
  newest: number;
  /** Every line of it was readable then: read again only if a finder finds a newer one. */
  done: boolean;
}

/** A live list's last read: what its next poll builds on. */
export interface Head<Row> {
  basis: string;
  /** When the window was last read whole. */
  wholeAt: number;
  /** Where the whole read started: the window before it is unread. */
  floorMs: number;
  /** Where the read ended. */
  endMs: number;
  /** Each finder's lines, newest first. */
  seen: Seen[][];
  followed: Map<string, Followed<Row>>;
}

export interface ListRead<Row> {
  /** The kept requests' rows, newest first. */
  rows: Row[];
  /** Kept requests whose lines Loki didn't return in time: left out of `rows`. */
  unread: number;
  /** False when the finders found no request - in the part read, when `nextBefore` says where the rest is. */
  found: boolean;
  /** Where the next, older read ends; null when this one holds everything. */
  nextBefore: number | null;
}

const byGuid = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Newest first; ties by GUID, so every read orders them alike. */
export const newestRowFirst = (a: { time: number; guid: string }, b: { time: number; guid: string }) =>
  b.time - a.time || byGuid(a.guid, b.guid);

function seenOf(lines: LokiLine[]): Seen[] {
  return lines
    .map((raw): Seen => {
      const l = parseRouterLine(raw);
      return { tsMs: raw.tsMs, guid: l?.guid ?? null, ...(l && isRelayEnd(l) ? { end: l } : {}) };
    })
    .sort((a, b) => b.tsMs - a.tsMs);
}

/** Every request by its newest finder line, newest first; ties by GUID. */
function ranked(seen: Seen[][]): [string, number][] {
  const newest = new Map<string, number>();
  for (const s of seen.flat()) {
    if (s.guid === null) continue;
    const had = newest.get(s.guid);
    if (had === undefined || s.tsMs > had) newest.set(s.guid, s.tsMs);
  }
  return [...newest].sort((a, b) => b[1] - a[1] || byGuid(a[0], b[0]));
}

/**
 * Each finder's lines over the window after a poll that read from `fromMs`:
 * the new ones, then the head's older ones still in the window, the newest
 * `limit` kept. Null when that can't be told without reading the window
 * whole: the head's read stopped at its limit inside the window, and fewer
 * lines than the limit are left above where it stopped.
 */
function merged(head: Head<unknown>, fresh: Seen[][], finders: Finder[], startMs: number, fromMs: number): Seen[][] | null {
  const out: Seen[][] = [];
  for (const [i, { limit }] of finders.entries()) {
    const got = fresh[i]!;
    // The newest `limit` lines of the window are all new ones.
    if (got.length >= limit) {
      out.push(got.slice(0, limit));
      continue;
    }
    const had = head.seen[i]!;
    const all = [...got, ...had.filter((s) => s.tsMs >= startMs && s.tsMs < fromMs)];
    if (all.length >= limit) {
      out.push(all.slice(0, limit));
      continue;
    }
    if (fromMs > startMs && had.length >= limit && had[had.length - 1]!.tsMs >= startMs) return null;
    out.push(all);
  }
  return out;
}

/**
 * The newest `cap` requests in `range`, and the head a live list's next poll
 * builds on. `last`: that list's head from its previous read. Null when Loki
 * didn't answer.
 */
export async function readList<Row extends { guid: string; time: number }>(
  loki: LokiClient,
  selector: string,
  plan: ListPlan<Row>,
  range: ReadRange,
  last: Head<Row> | null = null,
): Promise<{ read: ListRead<Row>; head: Head<Row> } | null> {
  const now = Date.now();
  const basis = JSON.stringify([plan.basis, plan.finders]);
  const on = last && last.basis === basis && now - last.wholeAt <= HEAD_FRESH_MS && last.endMs <= range.endMs ? last : null;
  const fromMs = on ? Math.max(range.startMs, on.endMs - LATE_MS) : Math.max(range.startMs, (await plan.wholeFrom?.(range)) ?? range.startMs);
  const floorMs = on ? on.floorMs : fromMs;
  const answers = await Promise.all(plan.finders.map((f) => loki.queryRange(f.query, fromMs, range.endMs, f.limit, "backward")));
  if (answers.some((a) => a === null)) return null;
  const fresh = answers.map((a) => seenOf(a!));
  const seen = on ? merged(on, fresh, plan.finders, range.startMs, fromMs) : fresh;
  if (!seen) return readList(loki, selector, plan, range);

  const order = ranked(seen);
  const head = (followed: Map<string, Followed<Row>>): Head<Row> =>
    ({ basis, wholeAt: on ? on.wholeAt : now, floorMs, endMs: range.endMs, seen, followed });
  const unreadCut = floorMs > range.startMs ? [floorMs] : [];
  if (!order.length) {
    const nextBefore = unreadCut.length ? readOnFrom([], plan.cap, unreadCut, range.endMs) : null;
    return { read: { rows: [], unread: 0, found: false, nextBefore }, head: head(new Map()) };
  }
  const kept = order.slice(0, plan.cap).map(([g]) => g);
  const cuts = seen.flatMap((pass, i) => (pass.length >= plan.finders[i]!.limit ? [pass[pass.length - 1]!.tsMs] : []));
  const nextBefore = readOnFrom(order, plan.cap, [...cuts, ...unreadCut], range.endMs);

  // A request found by its relay_end is read from it alone; the others need
  // the rest of their lines - unless the head holds them whole already.
  const newest = new Map(order);
  const isKept = new Set(kept);
  const ends = seen.flat().flatMap((s) => (s.end && isKept.has(s.end.guid) ? [s.end] : []));
  const inHand = new Set(ends.map((l) => l.guid));
  const followed = new Map<string, Followed<Row>>();
  const need: string[] = [];
  for (const g of kept) {
    if (inHand.has(g)) continue;
    const had = on?.followed.get(g);
    if (had?.done && newest.get(g)! <= had.newest) followed.set(g, had);
    else need.push(g);
  }
  const rows = [...followed.values()].flatMap((f) => (f.row ? [f.row] : []));

  let unread = 0;
  if (need.length) {
    const needed = new Set(need);
    const times = seen.flat().flatMap((s) => (s.guid !== null && needed.has(s.guid) ? [s.tsMs] : []));
    const got = await linesForGuids(
      loki,
      selector,
      need,
      Math.min(...times) - plan.follow.beforeMs,
      plan.follow.messages,
      plan.follow.perGuid,
      Math.min(Date.now(), Math.max(...times) + plan.follow.afterMs),
    );
    if (got === null) return null;
    unread = got.unread.length;
    const read = plan.rowsOf(got.lines);
    rows.push(...read);
    const rowOf = new Map(read.map((r) => [r.guid, r]));
    const late = new Set(got.unread);
    for (const g of need) {
      if (late.has(g)) continue;
      const n = newest.get(g)!;
      followed.set(g, { row: rowOf.get(g) ?? null, newest: n, done: n + plan.follow.afterMs <= range.endMs - LATE_MS });
    }
  }
  rows.push(...plan.rowsOf(ends));
  return { read: { rows: rows.sort(newestRowFirst), unread, found: true, nextBefore }, head: head(followed) };
}

/** How long an answer is kept: a read that failed in part or whole briefly, a live one briefly, a settled range long. */
export function keepFor(report: { available: boolean; unread?: number }, live: boolean, endMs: number, now = Date.now()): number {
  if (!report.available || report.unread) return FAILED_KEEP_MS;
  return !live && endMs <= now - LATE_MS ? SETTLED_KEEP_MS : LIVE_KEEP_MS;
}

/**
 * One log list's reads on this api process: one read per key at a time, its
 * answer kept (`keepFor`), and a live list's last read kept to build the next
 * poll on. A live list is keyed by its window and filters, anything else by
 * its times too.
 */
export class ListReads<Row extends { guid: string; time: number }, Report extends { available: boolean; unread?: number }> {
  private readonly answers = new ReadMemo<Report>(ANSWERS_KEPT);
  private readonly heads = new Map<string, Head<Row>>();

  /**
   * The answer for a read of `range` ending at `before`. `read` makes it,
   * given the head to build on (a live list's last read, or null), and hands
   * back the head for the next poll with it.
   */
  get(
    range: ReadRange,
    before: number | undefined,
    filters: (string | undefined)[],
    read: (last: Head<Row> | null) => Promise<{ report: Report; head?: Head<Row> }>,
  ): Promise<Report> {
    const window = before == null ? liveWindow(range) : undefined;
    const key = JSON.stringify(window ? ["live", window, ...filters] : ["range", range.startMs, range.endMs, before ?? null, ...filters]);
    const endMs = readEnd(range, before);
    return this.answers.get(key, async () => {
      const { report, head } = await read(window ? (this.heads.get(key) ?? null) : null);
      if (window && head) remember(this.heads, key, head, HEADS_KEPT);
      return { value: report, keepMs: keepFor(report, window !== undefined, endMs) };
    });
  }
}
