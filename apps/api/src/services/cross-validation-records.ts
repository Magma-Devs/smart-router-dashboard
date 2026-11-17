/**
 * The router's cross-validation records, read back from its logs - MAG-2788.
 *
 * A router with smart-router #712 (MAG-2787) writes one JSON line for every
 * cross-validated request, agreed or failed:
 *
 *   {"level":"info","crossValidationRecord":{…},"time":…,"message":"cross-validation record"}
 *
 * The record is compliance evidence, so it is served exactly as the router
 * wrote it - never reshaped, never summarised. It is read through the same Loki
 * credential the other log lists use, and that credential is the tenancy
 * boundary: the fleet's Loki takes the org from it and ignores any org a caller
 * sends, so this answers only this deployment's records whoever asks.
 *
 * **Paging is by position in the log, not by the record's own `time`.** A
 * record whose stragglers were still out is written when they resolve, after
 * records of later requests, so `time` is not the order lines arrive in. A
 * position is a line's exact nanosecond timestamp plus the lines at that
 * timestamp already served, so a resume neither skips nor repeats a line.
 * Oldest-first reads stop a minute short of now: a line can reach Loki that
 * long after its own time, and a position past it would skip it for good.
 *
 * **A page can be short, or empty, with more to come.** Each Loki read is
 * sized to the log budget every log list keeps to (`readStop`, `readStart`),
 * and a page takes at most READS_PER_PAGE of them. The records share their
 * streams with every other router line, so a stretch can be all reading and
 * no records; `has_more` says to go on.
 *
 * Filters are applied here, on the parsed record, exactly. The line filters
 * sent to Loki only narrow what comes back; they are never what decides.
 */
import { createHash } from "node:crypto";
import type { LokiClient, LokiLine } from "./loki-client.js";
import { LATE_MS } from "./log-list.js";
import { readStart, readStop } from "./read-range.js";
import { inRawString } from "./router-log.js";

/** The key the record sits under in the router's line. */
export const CV_RECORD_KEY = "crossValidationRecord";

/** How a provider took part in a record: the router's closed enum (`common.CrossValidationStragglerOutcome*`). */
export const PROVIDER_OUTCOMES = ["agreed", "disagreed", "node-error", "protocol-error", "not-received"] as const;
export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

export const RECORD_STATUSES = ["success", "failed"] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export interface CvRecordFilter {
  /** Records that asked this provider (an `endpoints[].providerAddress`). */
  provider?: string;
  /** With `provider`, how that provider took part; alone, any provider's. `disagreed` = the checks it dissented on. */
  providerOutcome?: ProviderOutcome;
  /** The record's `chainId`, e.g. ETH1. */
  chain?: string;
  method?: string;
  status?: RecordStatus;
  /** The record's `failureReason`, e.g. no-agreement. */
  reason?: string;
  /** The record's `requestId`: the Lava-Guid the caller got back. */
  requestId?: string;
}

/** One record as served: the router's record untouched, and when and where the log has it. */
export interface CvRecordItem {
  /** When the line reached the log, RFC 3339 to the nanosecond - the order pages go in. */
  logged_at: string;
  /** The router that wrote it. `seq` counts per process, so a gap means a drop only within one `pod`. */
  source: { service: string | null; pod: string | null };
  record: Record<string, unknown>;
}

export type Order = "asc" | "desc";

/** Where a read stopped: a line's nanosecond timestamp, and which lines at it were served. */
interface Position {
  ns: bigint;
  seen: string[];
}

export interface CvRecordsQuery {
  filter: CvRecordFilter;
  order: Order;
  /** Unix ms. */
  fromMs: number;
  /** Unix ms. */
  toMs: number;
  perPage: number;
  /** From a previous page's `cursor`, already checked against `filter` and `order`. */
  after?: Position;
}

export interface CvRecordsPage {
  items: CvRecordItem[];
  cursor: string;
  has_more: boolean;
}

/** The longest stretch one read spans: Loki refuses a longer one (`max_query_length`, 30 days and an hour by default). */
export const MAX_READ_SPAN_MS = 30 * 24 * 3600_000;

/** A line's identity among the lines at one timestamp: a record carries its own `seq` and `requestId`, so no two lines share it. */
const lineId = (line: string) => createHash("sha256").update(line, "utf8").digest("hex").slice(0, 16);

/** The filters a cursor was issued for, so a resume under others is refused rather than answered with a gap. */
export function filterFingerprint(filter: CvRecordFilter, order: Order): string {
  const f = filter;
  const key = [order, f.provider, f.providerOutcome, f.chain, f.method, f.status, f.reason, f.requestId].map((v) => v ?? null);
  return createHash("sha256").update(JSON.stringify(key), "utf8").digest("hex").slice(0, 16);
}

interface CursorBody {
  v: 1;
  o: Order;
  p: string;
  s: string[];
  f: string;
}

export function encodeCursor(position: Position, order: Order, fingerprint: string): string {
  const body: CursorBody = { v: 1, o: order, p: position.ns.toString(), s: position.seen, f: fingerprint };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

/** A cursor this endpoint issued, or null. Checked here for shape only; `checkCursor` matches it to a query. */
export function decodeCursor(raw: string): { order: Order; fingerprint: string; position: Position } | null {
  try {
    const body = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorBody>;
    if (body.v !== 1 || (body.o !== "asc" && body.o !== "desc")) return null;
    if (typeof body.p !== "string" || !/^\d{1,20}$/.test(body.p)) return null;
    if (typeof body.f !== "string" || !/^[0-9a-f]{16}$/.test(body.f)) return null;
    if (!Array.isArray(body.s) || body.s.length > 1000 || !body.s.every((s) => typeof s === "string" && /^[0-9a-f]{16}$/.test(s))) return null;
    return { order: body.o, fingerprint: body.f, position: { ns: BigInt(body.p), seen: body.s } };
  } catch {
    return null;
  }
}

/**
 * A value spliced into a line filter as the JSON the router writes it as:
 * Go escapes `"`, `\`, `<`, `>`, `&`, control characters and U+2028/9, so a
 * value with any of them is not in the line as written and is not narrowed by
 * (the exact filter here still applies). A backtick would end the raw string.
 */
const ESCAPED_BY_GO = /["\\<>&\u2028\u2029]/;
const narrowable = (value: string) =>
  value.length > 0 && !ESCAPED_BY_GO.test(value) && inRawString(value) && ![...value].some((c) => c.charCodeAt(0) < 0x20);

const fragment = (key: string, value: string) => (narrowable(value) ? `"${key}":"${value}"` : null);

/** The LogQL for the records `filter` can match: the router's selector, the record's key, and a fragment per narrowable filter. */
export function recordsQuery(selector: string, filter: CvRecordFilter): string {
  const parts = [
    `"${CV_RECORD_KEY}":{`,
    filter.requestId !== undefined ? fragment("requestId", filter.requestId) : null,
    filter.chain !== undefined ? fragment("chainId", filter.chain) : null,
    filter.method !== undefined ? fragment("method", filter.method) : null,
    filter.status !== undefined ? fragment("status", filter.status) : null,
    filter.reason !== undefined ? fragment("failureReason", filter.reason) : null,
    filter.provider !== undefined ? fragment("providerAddress", filter.provider) : null,
    filter.providerOutcome !== undefined ? fragment("outcome", filter.providerOutcome) : null,
  ];
  return selector + parts.filter((p): p is string => p !== null).map((p) => ` |= \`${p}\``).join("");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The record a line carries, or null for any other line. */
export function recordOf(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = isObject(parsed) ? parsed[CV_RECORD_KEY] : undefined;
  return isObject(record) ? record : null;
}

/** Whether a record is one `filter` asks for, decided on the record itself. */
export function matches(record: Record<string, unknown>, filter: CvRecordFilter): boolean {
  if (filter.chain !== undefined && record.chainId !== filter.chain) return false;
  if (filter.method !== undefined && record.method !== filter.method) return false;
  if (filter.status !== undefined && record.status !== filter.status) return false;
  if (filter.reason !== undefined && record.failureReason !== filter.reason) return false;
  if (filter.requestId !== undefined && record.requestId !== filter.requestId) return false;
  if (filter.provider !== undefined || filter.providerOutcome !== undefined) {
    // `endpoints` holds each provider's final outcome, a late one included.
    const endpoints = (Array.isArray(record.endpoints) ? record.endpoints : []).filter(isObject);
    const own = filter.provider !== undefined ? endpoints.filter((e) => e.providerAddress === filter.provider) : endpoints;
    if (!own.length) return false;
    if (filter.providerOutcome !== undefined && !own.some((e) => e.outcome === filter.providerOutcome)) return false;
  }
  return true;
}

/** A nanosecond timestamp as RFC 3339 with all nine digits. */
export function nsToRfc3339(ns: bigint): string {
  const whole = new Date(Number(ns / 1_000_000_000n) * 1000).toISOString().slice(0, 19);
  return `${whole}.${(ns % 1_000_000_000n).toString().padStart(9, "0")}Z`;
}

const msToNsBig = (ms: number) => BigInt(Math.floor(ms)) * 1_000_000n;
const nsToMs = (ns: bigint) => Number(ns / 1_000_000n);

interface Read {
  ns: bigint;
  id: string;
  raw: LokiLine;
}

/** What one read served, where it stopped, and whether the stretch holds more. */
interface ReadResult {
  items: CvRecordItem[];
  position: Position;
  more: boolean;
}

/**
 * Reads one page may take. Each is up to four calls (three to size it, one to
 * read it) on a Loki the tenant shares with its own dashboard and alert rules.
 */
export const READS_PER_PAGE = 3;

export class CrossValidationRecordsService {
  constructor(
    private readonly loki: LokiClient | null,
    private readonly selector: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether this dashboard reads the router's logs at all (LOKI_URL). */
  get configured(): boolean {
    return this.loki !== null;
  }

  /**
   * One page of records; null when Loki didn't answer the first read. A short
   * page reads on, up to READS_PER_PAGE reads: a default pull starts 90 days
   * back and Loki takes 30 at a time, so one read would answer most first pages
   * with nothing. A later read Loki doesn't answer ends the page where the last
   * one stopped.
   */
  async page(q: CvRecordsQuery): Promise<CvRecordsPage | null> {
    const fingerprint = filterFingerprint(q.filter, q.order);
    const items: CvRecordItem[] = [];
    let after = q.after;
    let last: ReadResult | null = null;
    for (let n = 0; n < READS_PER_PAGE; n++) {
      const read = await this.readOnce({ ...q, perPage: q.perPage - items.length, ...(after ? { after } : {}) });
      if (!read) {
        if (!last) return null;
        break;
      }
      last = read;
      items.push(...read.items);
      after = read.position;
      if (!read.more || items.length >= q.perPage) break;
    }
    return { items, cursor: encodeCursor(last!.position, q.order, fingerprint), has_more: last!.more };
  }

  /** One read of the stretch `q` leaves; null when Loki didn't answer. */
  private async readOnce(q: CvRecordsQuery): Promise<ReadResult | null> {
    const loki = this.loki;
    if (!loki) return null;
    const fromNs = msToNsBig(q.fromMs);
    const asc = q.order === "asc";

    // The stretch left to read: [lo, hi), `to` taken whole to its millisecond.
    // A position is where the served lines end: oldest-first, every line before
    // `ns`; newest-first, every line after it; and at `ns`, the `seen` ones.
    const toNs = msToNsBig(q.toMs) + 1_000_000n;
    let lo: bigint;
    let hi: bigint;
    if (asc) {
      lo = q.after ? q.after.ns : fromNs;
      // Oldest-first stops where lines may still arrive.
      const settledNs = msToNsBig(this.now() - LATE_MS);
      hi = toNs < settledNs ? toNs : settledNs;
    } else {
      lo = fromNs;
      // Loki's end is exclusive; the position's own timestamp may hold lines not yet served.
      hi = q.after && q.after.ns + 1n < toNs ? q.after.ns + 1n : toNs;
    }
    const start: Position = q.after ?? { ns: asc ? lo : hi - 1n, seen: [] };
    if (lo >= hi) return { items: [], position: start, more: false };

    // This read's part of it: no longer than Loki takes, no heavier than the log budget.
    let readLo = lo;
    let readHi = hi;
    if (asc) {
      const capMs = Math.min(nsToMs(hi), nsToMs(lo) + MAX_READ_SPAN_MS);
      const stopMs = await readStop(loki, this.selector, nsToMs(lo), capMs);
      if (stopMs < nsToMs(hi)) readHi = msToNsBig(stopMs);
    } else {
      const floorMs = Math.max(nsToMs(lo), nsToMs(hi) - MAX_READ_SPAN_MS);
      const startMs = await readStart(loki, this.selector, { startMs: floorMs, endMs: nsToMs(hi) }, nsToMs(hi));
      if (startMs > nsToMs(lo)) readLo = msToNsBig(startMs);
    }
    if (readHi <= readLo) readHi = readLo + 1n;

    // Room for the lines at the position already served, so a read always
    // reaches past them - however many lines one timestamp holds.
    const limit = q.perPage + start.seen.length;
    const lines = await loki.queryRangeNs(
      recordsQuery(this.selector, q.filter),
      readLo.toString(),
      readHi.toString(),
      limit,
      asc ? "forward" : "backward",
    );
    if (lines === null) return null;

    const reads: Read[] = lines
      .flatMap((raw): Read[] => (raw.ns && /^\d+$/.test(raw.ns) ? [{ ns: BigInt(raw.ns), id: lineId(raw.line), raw }] : []))
      .filter((r) => r.ns >= readLo && r.ns < readHi)
      // Loki answers per stream; one order across them, ties by identity so every read agrees.
      .sort((a, b) => (a.ns === b.ns ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.ns < b.ns) === asc ? -1 : 1));

    const items: CvRecordItem[] = [];
    let at: Position = { ns: start.ns, seen: [...start.seen] };
    let consumed = 0;
    for (const r of reads) {
      if (r.ns === at.ns && at.seen.includes(r.id)) {
        consumed++;
        continue;
      }
      if (items.length >= q.perPage) break;
      if (r.ns !== at.ns) at = { ns: r.ns, seen: [] };
      at.seen.push(r.id);
      consumed++;
      const record = recordOf(r.raw.line);
      if (record && matches(record, q.filter)) {
        items.push({
          logged_at: nsToRfc3339(r.ns),
          source: { service: r.raw.labels?.service_name ?? null, pod: r.raw.labels?.pod ?? null },
          record,
        });
      }
    }

    // Every line of the read served, and Loki held back none: the whole part is read.
    const whole = consumed === reads.length && lines.length < limit;
    if (whole) {
      // Oldest-first, nothing at `readHi` was read (the filter above makes it
      // exclusive whatever Loki does); newest-first, `readLo` was, and its
      // lines are the last ones served.
      const position: Position = asc ? { ns: readHi, seen: [] } : { ns: readLo, seen: at.ns === readLo ? at.seen : [] };
      return { items, position, more: asc ? readHi < hi : readLo > lo };
    }
    return { items, position: at, more: true };
  }
}
