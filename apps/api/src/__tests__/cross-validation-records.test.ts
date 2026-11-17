import { describe, expect, it } from "vitest";
import type { LokiClient, LokiLine } from "../services/loki-client.js";
import {
  CrossValidationRecordsService,
  decodeCursor,
  matches,
  MAX_READ_SPAN_MS,
  nsToRfc3339,
  READS_PER_PAGE,
  recordOf,
  recordsQuery,
  type CvRecordFilter,
  type CvRecordItem,
  type CvRecordsQuery,
} from "../services/cross-validation-records.js";
import { LATE_MS } from "../services/log-list.js";

/**
 * MAG-2788: the router's cross-validation records, read back from its logs.
 *
 * The ticket's bar: "A customer can pull their own records and filter by time
 * range, provider, upstream - including every check this provider dissented on,
 * chain and method, outcome, a single request ID. If any of the filters above
 * is not answerable, it is not done." Each of those has a test below, and so
 * does the paging a puller depends on to see every record exactly once.
 */

const SELECTOR = '{component="router"}';
const NOW = 1_794_900_000_000; // 2026-11-17, unix ms
const MS = 1_000_000n;
const nsAt = (ms: number) => BigInt(ms) * MS;

interface Endpoint {
  providerAddress: string;
  providerGroup?: string;
  outcome: string;
  digest?: string;
  delayMs?: number;
}

let seq = 0;
/** A record as the router builds it (cross_validation_record.go). */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  seq++;
  return {
    time: "2026-11-17T10:00:00Z",
    seq,
    requestId: `req-${seq}`,
    tenant: "kraken-desk",
    chainId: "ETH1",
    apiInterface: "jsonrpc",
    method: "eth_getBlockByNumber",
    blockHeight: 21000000,
    finality: "finalized",
    agreementThreshold: 2,
    maxParticipants: 3,
    minGroups: 1,
    status: "success",
    servedDigest: "ab12",
    digestAlgorithmVersion: 1,
    endpoints: [
      { providerAddress: "alchemy", providerGroup: "default", outcome: "agreed", digest: "ab12" },
      { providerAddress: "infura", providerGroup: "default", outcome: "agreed", digest: "ab12" },
      { providerAddress: "quicknode", providerGroup: "default", outcome: "disagreed", digest: "cd34" },
    ] satisfies Endpoint[],
    ...over,
  };
}

/** The line zerolog writes for it: the record under its key, beside the logger's own fields. */
const lineOf = (rec: Record<string, unknown>) =>
  JSON.stringify({ level: "info", crossValidationRecord: rec, time: "2026-11-17T10:00:00Z", message: "cross-validation record" });

interface Stored {
  ns: bigint;
  line: string;
  pod: string;
}

/**
 * A Loki that holds lines and answers `query_range` as Loki does: [start, end),
 * the line filters applied, oldest or newest first, at most `limit` - and per
 * stream, so the service has to put them back in one order itself.
 */
function fakeLoki(stored: Stored[], opts: { bytes?: (startMs: number, endMs: number) => number | null; down?: boolean } = {}) {
  const calls: { query: string; start: bigint; end: bigint; limit: number; direction: string }[] = [];
  const loki = {
    async queryRangeNs(query: string, startNs: string, endNs: string, limit: number, direction: "forward" | "backward") {
      calls.push({ query, start: BigInt(startNs), end: BigInt(endNs), limit, direction });
      if (opts.down) return null;
      const filters = [...query.matchAll(/\|= `([^`]*)`/g)].map((m) => m[1]!);
      const hits = stored
        .filter((s) => s.ns >= BigInt(startNs) && s.ns < BigInt(endNs))
        .filter((s) => filters.every((f) => s.line.includes(f)))
        .sort((a, b) => (a.ns === b.ns ? 0 : (a.ns < b.ns) === (direction === "forward") ? -1 : 1))
        .slice(0, limit);
      // One array per stream (pod), streams in reverse: the order across them is the service's job.
      const pods = [...new Set(hits.map((h) => h.pod))].reverse();
      return pods.flatMap((pod) =>
        hits
          .filter((h) => h.pod === pod)
          .map((h): LokiLine => ({ tsMs: Number(h.ns) / 1e6, ns: h.ns.toString(), line: h.line, labels: { service_name: "kraken-eth", pod } })),
      );
    },
    async volume(_selector: string, startMs: number, endMs: number) {
      return opts.bytes ? opts.bytes(startMs, endMs) : 0;
    },
  };
  return { loki: loki as unknown as LokiClient, calls };
}

const service = (loki: LokiClient) => new CrossValidationRecordsService(loki, SELECTOR, () => NOW);

function query(over: Partial<CvRecordsQuery> = {}): CvRecordsQuery {
  return { filter: {}, order: "asc", fromMs: NOW - 3600_000, toMs: NOW, perPage: 100, ...over };
}

/** Every record a puller collects, following cursors to the end. */
async function pullAll(svc: CrossValidationRecordsService, q: CvRecordsQuery, maxPages = 200): Promise<CvRecordItem[]> {
  const items: CvRecordItem[] = [];
  let after: CvRecordsQuery["after"];
  for (let i = 0; i < maxPages; i++) {
    const page = await svc.page({ ...q, ...(after ? { after } : {}) });
    expect(page).not.toBeNull();
    items.push(...page!.items);
    if (!page!.has_more) return items;
    after = decodeCursor(page!.cursor)!.position;
  }
  throw new Error("the pull never ended");
}

const ids = (items: CvRecordItem[]) => items.map((i) => i.record.requestId);

describe("the filters the ticket requires", () => {
  const base = NOW - 1800_000;
  const recs = [
    record({ requestId: "r-agreed" }),
    record({
      requestId: "r-failed",
      status: "failed",
      failureReason: "no-agreement",
      servedDigest: undefined,
      endpoints: [
        { providerAddress: "alchemy", outcome: "disagreed", digest: "aa" },
        { providerAddress: "infura", outcome: "disagreed", digest: "bb" },
      ],
    }),
    record({ requestId: "r-sol", chainId: "SOLANA", method: "getSlot" }),
    record({
      requestId: "r-late-dissent",
      endpoints: [
        { providerAddress: "alchemy", outcome: "agreed" },
        { providerAddress: "infura", outcome: "agreed" },
        { providerAddress: "blast", outcome: "disagreed", digest: "ee" },
      ],
      lateResolutions: [{ providerAddress: "blast", outcome: "disagreed", digest: "ee", delayMs: 900 }],
    }),
    record({ requestId: "r-capacity", status: "failed", failureReason: "insufficient-capacity", endpoints: [] }),
  ];
  const stored = recs.map((r, i) => ({ ns: nsAt(base + i * 1000), line: lineOf(r), pod: "router-0" }));

  async function only(filter: CvRecordFilter, over: Partial<CvRecordsQuery> = {}) {
    const { loki } = fakeLoki(stored);
    return ids(await pullAll(service(loki), query({ filter, ...over })));
  }

  it("serves every record in the range, oldest first, exactly as the router wrote it", async () => {
    const { loki } = fakeLoki(stored);
    const items = await pullAll(service(loki), query());
    expect(ids(items)).toEqual(["r-agreed", "r-failed", "r-sol", "r-late-dissent", "r-capacity"]);
    // Evidence is not reshaped: the record is the router's object, field for field.
    expect(items[0]!.record).toEqual(JSON.parse(stored[0]!.line).crossValidationRecord);
    expect(items[0]!.logged_at).toBe(nsToRfc3339(stored[0]!.ns));
    expect(items[0]!.source).toEqual({ service: "kraken-eth", pod: "router-0" });
  });

  it("time range", async () => {
    expect(await only({}, { fromMs: base + 1000, toMs: base + 2000 })).toEqual(["r-failed", "r-sol"]);
  });

  it("provider: every check that asked it", async () => {
    expect(await only({ provider: "quicknode" })).toEqual(["r-agreed", "r-sol"]);
    expect(await only({ provider: "blast" })).toEqual(["r-late-dissent"]);
  });

  it("every check this provider dissented on - a late dissent included", async () => {
    expect(await only({ provider: "alchemy", providerOutcome: "disagreed" })).toEqual(["r-failed"]);
    expect(await only({ provider: "blast", providerOutcome: "disagreed" })).toEqual(["r-late-dissent"]);
    // Asked, but agreed: not a dissent.
    expect(await only({ provider: "infura", providerOutcome: "disagreed" })).toEqual(["r-failed"]);
  });

  it("any provider's dissent, without naming one", async () => {
    expect(await only({ providerOutcome: "disagreed" })).toEqual(["r-agreed", "r-failed", "r-sol", "r-late-dissent"]);
  });

  it("chain and method", async () => {
    expect(await only({ chain: "SOLANA" })).toEqual(["r-sol"]);
    expect(await only({ chain: "ETH1", method: "getSlot" })).toEqual([]);
    expect(await only({ chain: "SOLANA", method: "getSlot" })).toEqual(["r-sol"]);
  });

  it("outcome: agreed, or failed with which reason", async () => {
    expect(await only({ status: "success" })).toEqual(["r-agreed", "r-sol", "r-late-dissent"]);
    expect(await only({ status: "failed" })).toEqual(["r-failed", "r-capacity"]);
    expect(await only({ reason: "insufficient-capacity" })).toEqual(["r-capacity"]);
    expect(await only({ status: "failed", reason: "no-agreement" })).toEqual(["r-failed"]);
  });

  it("a single request ID", async () => {
    expect(await only({ requestId: "r-sol" })).toEqual(["r-sol"]);
    expect(await only({ requestId: "r-none" })).toEqual([]);
  });
});

describe("what Loki is asked", () => {
  it("narrows by each filter as the JSON the router writes", () => {
    const q = recordsQuery(SELECTOR, { chain: "ETH1", requestId: "abc-1", provider: "alchemy", providerOutcome: "disagreed", status: "failed" });
    expect(q).toBe(
      '{component="router"} |= `"crossValidationRecord":{` |= `"requestId":"abc-1"` |= `"chainId":"ETH1"` |= `"status":"failed"` |= `"providerAddress":"alchemy"` |= `"outcome":"disagreed"`',
    );
  });

  /** Go escapes these when it writes the line, so the value as given is not in it. */
  it("does not narrow by a value the line holds escaped - and still filters it exactly", async () => {
    expect(recordsQuery(SELECTOR, { provider: 'odd"name' })).toBe('{component="router"} |= `"crossValidationRecord":{`');
    expect(recordsQuery(SELECTOR, { provider: "a&b" })).toBe('{component="router"} |= `"crossValidationRecord":{`');
    expect(recordsQuery(SELECTOR, { provider: "tab\there" })).toBe('{component="router"} |= `"crossValidationRecord":{`');
    const rec = record({ endpoints: [{ providerAddress: 'odd"name', outcome: "agreed" }] });
    expect(matches(rec, { provider: 'odd"name' })).toBe(true);
    expect(matches(rec, { provider: "odd" })).toBe(false);
  });

  it("decides on the record, not on what a line happens to contain", () => {
    // `quicknode` appears in the line only as another provider's group.
    const rec = record({ endpoints: [{ providerAddress: "alchemy", providerGroup: "quicknode", outcome: "agreed" }] });
    expect(matches(rec, { provider: "quicknode" })).toBe(false);
    // A provider that dissented elsewhere in the record is not this one's dissent.
    const two = record({ endpoints: [{ providerAddress: "alchemy", outcome: "agreed" }, { providerAddress: "infura", outcome: "disagreed" }] });
    expect(matches(two, { provider: "alchemy", providerOutcome: "disagreed" })).toBe(false);
  });

  it("skips a line that mentions the key but is not a record", () => {
    expect(recordOf('level=info msg="crossValidationRecord":{ broken')).toBeNull();
    expect(recordOf(JSON.stringify({ crossValidationRecord: "not an object" }))).toBeNull();
    expect(recordOf(lineOf(record()))).not.toBeNull();
  });
});

describe("paging: every record exactly once", () => {
  it("resumes between two records written in the same nanosecond, by two routers", async () => {
    const t = nsAt(NOW - 600_000);
    const stored = [
      { ns: t - 5n, line: lineOf(record({ requestId: "a" })), pod: "router-0" },
      { ns: t, line: lineOf(record({ requestId: "b" })), pod: "router-0" },
      { ns: t, line: lineOf(record({ requestId: "c" })), pod: "router-1" },
      { ns: t, line: lineOf(record({ requestId: "d" })), pod: "router-2" },
      { ns: t + 7n, line: lineOf(record({ requestId: "e" })), pod: "router-1" },
    ];
    const { loki } = fakeLoki(stored);
    for (const perPage of [1, 2, 3, 100]) {
      const got = ids(await pullAll(service(loki), query({ perPage })));
      expect([...got].sort(), `per_page=${perPage}`).toEqual(["a", "b", "c", "d", "e"]);
      expect(got.length, `per_page=${perPage}`).toBe(5);
    }
  });

  /** The reason a read asks for the page plus what it has already served at the position. */
  it("never stands still on a timestamp holding more lines than a page", async () => {
    const t = nsAt(NOW - 600_000);
    const stored = ["a", "b", "c", "d"].map((id, i) => ({ ns: t, line: lineOf(record({ requestId: id })), pod: `router-${i}` }));
    const { loki } = fakeLoki(stored);
    const got = ids(await pullAll(service(loki), query({ perPage: 1 }), 20));
    expect([...got].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("does not serve the last minute oldest-first - and serves it on the next pull", async () => {
    const stored = [
      { ns: nsAt(NOW - 120_000), line: lineOf(record({ requestId: "settled" })), pod: "router-0" },
      { ns: nsAt(NOW - 10_000), line: lineOf(record({ requestId: "recent" })), pod: "router-0" },
    ];
    const { loki } = fakeLoki(stored);
    const first = await service(loki).page(query());
    expect(ids(first!.items)).toEqual(["settled"]);
    expect(first!.has_more).toBe(false);

    // The same cursor, a minute later: the line is settled now, and nothing is served twice.
    const later = new CrossValidationRecordsService(loki, SELECTOR, () => NOW + LATE_MS);
    const next = await later.page(query({ toMs: NOW + LATE_MS, after: decodeCursor(first!.cursor)!.position }));
    expect(ids(next!.items)).toEqual(["recent"]);
  });

  it("reads a heavy stretch in parts - an empty page with more to come, not a gap", async () => {
    const stored = [
      { ns: nsAt(NOW - 3000_000), line: lineOf(record({ requestId: "old" })), pod: "router-0" },
      { ns: nsAt(NOW - 300_000), line: lineOf(record({ requestId: "new" })), pod: "router-0" },
    ];
    // 5e9 bytes per 10 minutes: more than one read's budget for anything over ~8.
    const { loki, calls } = fakeLoki(stored, { bytes: (s, e) => ((e - s) / 600_000) * 5e9 });
    const items = await pullAll(service(loki), query({ fromMs: NOW - 3600_000 }));
    expect(ids(items)).toEqual(["old", "new"]);
    expect(calls.length).toBeGreaterThan(3);
    // Each read stayed inside the budget's span.
    for (const c of calls) expect(Number(c.end - c.start) / 1e6).toBeLessThanOrEqual(600_000);
  });

  it("never asks Loki for more than 30 days in one read - and a first page still reaches today", async () => {
    const stored = [{ ns: nsAt(NOW - 300_000), line: lineOf(record({ requestId: "today" })), pod: "router-0" }];
    const { loki, calls } = fakeLoki(stored);
    const page = await service(loki).page(query({ fromMs: NOW - 90 * 24 * 3600_000 }));
    expect(ids(page!.items)).toEqual(["today"]);
    expect(page!.has_more).toBe(false);
    expect(calls).toHaveLength(READS_PER_PAGE);
    for (const c of calls) expect(Number(c.end - c.start) / 1e6).toBeLessThanOrEqual(MAX_READ_SPAN_MS);
  });

  it("ends a page at the last read Loki answered, and resumes from there", async () => {
    const stored = [
      { ns: nsAt(NOW - 50 * 24 * 3600_000), line: lineOf(record({ requestId: "old" })), pod: "router-0" },
      { ns: nsAt(NOW - 300_000), line: lineOf(record({ requestId: "new" })), pod: "router-0" },
    ];
    const healthy = fakeLoki(stored);
    let answers = 1;
    const flaky = {
      ...healthy.loki,
      volume: healthy.loki.volume.bind(healthy.loki),
      queryRangeNs: (...a: Parameters<LokiClient["queryRangeNs"]>) => (answers-- > 0 ? healthy.loki.queryRangeNs(...a) : Promise.resolve(null)),
    } as unknown as LokiClient;
    const first = await service(flaky).page(query({ fromMs: NOW - 60 * 24 * 3600_000 }));
    expect(ids(first!.items)).toEqual(["old"]);
    expect(first!.has_more).toBe(true);
    const rest = await service(healthy.loki).page(query({ fromMs: NOW - 60 * 24 * 3600_000, after: decodeCursor(first!.cursor)!.position }));
    expect(ids(rest!.items)).toEqual(["new"]);
  });

  it("pages newest first just as exactly", async () => {
    const t = nsAt(NOW - 600_000);
    const stored = [
      { ns: t - 5n, line: lineOf(record({ requestId: "a" })), pod: "router-0" },
      { ns: t, line: lineOf(record({ requestId: "b" })), pod: "router-0" },
      { ns: t, line: lineOf(record({ requestId: "c" })), pod: "router-1" },
      { ns: t + 7n, line: lineOf(record({ requestId: "d" })), pod: "router-1" },
    ];
    const { loki } = fakeLoki(stored);
    for (const perPage of [1, 2, 100]) {
      const got = ids(await pullAll(service(loki), query({ order: "desc", perPage })));
      expect(got[0], `per_page=${perPage}`).toBe("d");
      expect(got[3], `per_page=${perPage}`).toBe("a");
      expect([...got].sort(), `per_page=${perPage}`).toEqual(["a", "b", "c", "d"]);
    }
  });

  it("takes `to` whole to its millisecond", async () => {
    const at = NOW - 600_000;
    const stored = [{ ns: nsAt(at) + 999_999n, line: lineOf(record({ requestId: "edge" })), pod: "router-0" }];
    const { loki } = fakeLoki(stored);
    expect(ids(await pullAll(service(loki), query({ fromMs: at - 1000, toMs: at })))).toEqual(["edge"]);
    expect(ids(await pullAll(service(loki), query({ order: "desc", fromMs: at - 1000, toMs: at })))).toEqual(["edge"]);
  });

  it("answers null, not an empty page, when Loki does not answer", async () => {
    const { loki } = fakeLoki([], { down: true });
    expect(await service(loki).page(query())).toBeNull();
  });
});
