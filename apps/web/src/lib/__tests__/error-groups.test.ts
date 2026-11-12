import { describe, expect, it } from "vitest";
import type { ErrorRequestRow, RelayAttempt } from "@sr/shared";
import { coveredSpan, decidingError, groupBuckets, groupErrors } from "../error-groups";

const attempt = (upstream: string, over: Partial<RelayAttempt> = {}): RelayAttempt => ({
  upstream, batch: 0, outcome: "failed", replied: false, code: null, retryable: null, message: "server error", note: null,
  ...over,
} as RelayAttempt);

let n = 0;
const row = (over: Partial<ErrorRequestRow>): ErrorRequestRow => ({
  guid: `g${n++}`, time: 1_000_000, spec: "NEAR", method: "block", attempts: [], result: "error-reply",
  errorCode: null, error: null,
  ...over,
} as ErrorRequestRow);

describe("decidingError - the error that decided a request, and who caused it", () => {
  it("two providers each failing differently, with the client getting one: every provider failed", () => {
    const r = row({ attempts: [attempt("lava", { message: "malformed JSON-RPC response" }), attempt("tatum", { replied: true, code: "NODE_INTERNAL_ERROR" })] });
    expect(decidingError(r)).toMatchObject({ key: "all-failed", cause: "all-failed", providerCount: 2 });
  });

  it("is the provider that gave it, when only one failed", () => {
    const r = row({ attempts: [attempt("tatum", { replied: true, code: "NODE_INTERNAL_ERROR" })] });
    expect(decidingError(r)).toEqual({ key: "NODE_INTERNAL_ERROR", label: "internal error", cause: "provider", provider: "tatum", providerCount: 1 });
  });

  it("is the last failed try when none went back (the request recovered)", () => {
    const r = row({ result: "recovered", attempts: [attempt("lava", { message: "timeout after 5000ms" }), attempt("tatum", { outcome: "ok", replied: true })] });
    expect(decidingError(r)).toMatchObject({ key: "msg:timeout after #ms", label: "timeout after 5000ms", cause: "provider", provider: "lava" });
  });

  it("is the client's request when the router's code says so, whichever provider answered", () => {
    for (const code of ["USER_INVALID_PARAMS", "CHAIN_NONCE_TOO_LOW"]) {
      expect(decidingError(row({ attempts: [attempt("tatum", { replied: true, code })] }))).toMatchObject({ cause: "request", provider: null });
    }
  });

  it("is every provider when two or more gave the same provider-side error", () => {
    const err = { code: "NODE_DATA_NOT_HELD" };
    const r = row({ attempts: [attempt("lava", err), attempt("tatum", { ...err, replied: true })] });
    expect(decidingError(r)).toMatchObject({ cause: "every-provider", providerCount: 2 });
  });

  it("is 'every provider failed' when each gave a different error and the client got one", () => {
    const r = row({ result: "failed", attempts: [attempt("a", { code: "NODE_TIMEOUT" }), attempt("b", { message: "HTTP 503" }), attempt("c", { message: "HTTP 429" })] });
    expect(decidingError(r)).toMatchObject({ key: "all-failed", label: "Every provider failed", cause: "all-failed", providerCount: 3 });
  });

  it("does not count the cache as a provider", () => {
    const r = row({ attempts: [attempt("Cached", { code: "NODE_INTERNAL_ERROR" }), attempt("tatum", { replied: true, code: "NODE_INTERNAL_ERROR" })] });
    expect(decidingError(r)).toMatchObject({ cause: "provider", provider: "tatum" });
  });

  it("names the error in the list's words, without the request a transport error wraps", () => {
    const r = row({ attempts: [attempt("lava", { replied: true, message: 'http request failed: Post "http://node-a.example:8545": dial tcp 10.0.0.1:8545: connect: connection refused' })] });
    expect(decidingError(r).label).toBe("dial tcp 10.0.0.1:8545: connect: connection refused");
  });

  it("falls back to the request's own code, then to its error words", () => {
    expect(decidingError(row({ result: "write-unknown", errorCode: "NODE_GATEWAY_TIMEOUT" })))
      .toMatchObject({ key: "NODE_GATEWAY_TIMEOUT", label: "gateway timeout", cause: "none" });
    expect(decidingError(row({ result: "failed", error: "insufficient results 3" }))).toMatchObject({ key: "err:insufficient results #", label: "insufficient results 3" });
  });
});

describe("groupErrors", () => {
  it("folds a burst of one error at one provider into one group, biggest first", () => {
    const burst = Array.from({ length: 5 }, (_, k) => row({ time: 1000 + k, attempts: [attempt("lava", { replied: true, code: "NODE_SERVER_ERROR" })] }));
    const other = row({ time: 5000, attempts: [attempt("lava", { replied: true, message: "malformed JSON-RPC response" })] });
    const groups = groupErrors([other, ...burst]);
    expect(groups.map((g) => [g.errorLabel, g.provider, g.count])).toEqual([["server error", "lava", 5], ["malformed JSON-RPC response", "lava", 1]]);
    expect(groups[0]!.methods).toEqual([{ method: "block", count: 5 }]);
    expect(groups[0]).toMatchObject({ firstMs: 1000, lastMs: 1004, reached: true });
    expect(groups[0]!.rows.map((r) => r.time)).toEqual([1004, 1003, 1002, 1001, 1000]);
  });

  it("keeps apart the same error on another chain, at another provider, or one the client never saw", () => {
    const err = () => [attempt("lava", { replied: true, code: "NODE_SERVER_ERROR" })];
    const groups = groupErrors([
      row({ attempts: err() }),
      row({ spec: "ETH1", attempts: err() }),
      row({ attempts: [attempt("tatum", { replied: true, code: "NODE_SERVER_ERROR" })] }),
      row({ result: "recovered", attempts: [attempt("lava", { code: "NODE_SERVER_ERROR" }), attempt("tatum", { outcome: "ok", replied: true })] }),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.filter((g) => !g.reached)).toHaveLength(1);
  });

  it("keeps a request with no end logged apart from recovered ones: nobody knows what its client got", () => {
    const tries = () => [attempt("lava", { code: "NODE_SERVER_ERROR" }), attempt("tatum", { outcome: "ok", replied: true })];
    const groups = groupErrors([row({ result: "recovered", attempts: tries() }), row({ result: "unknown", attempts: tries() })]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => [g.reached, g.noEnd]).sort()).toEqual([[false, false], [false, true]]);
  });

  it("blanks the numbers in a message, so one error on different blocks is one group", () => {
    const groups = groupErrors([
      row({ attempts: [attempt("lava", { replied: true, message: "block 101 not found" })] }),
      row({ attempts: [attempt("lava", { replied: true, message: "block 202 not found" })] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.count).toBe(2);
  });
});

describe("groupErrors - one error reads as one, whatever ids it carries", () => {
  const one = (message: string) => row({ attempts: [attempt("lava", { replied: true, message })] });
  const groupsOf = (...messages: string[]) => groupErrors(messages.map(one));

  it("blanks transaction hashes, addresses and ids, with or without 0x", () => {
    expect(groupsOf(
      "transaction 0x5f3a9c0e7d1b2a4c6e8f0a1b3c5d7e9f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d already known",
      "transaction 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefab12 already known",
    )).toHaveLength(1);
    expect(groupsOf(
      "tx 4F3A9C0E7D1B2A4C6E8F0A1B3C5D7E9F1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D already exists in cache",
      "tx 0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5E6F7A8B9C0D1E already exists in cache",
    )).toHaveLength(1);
    expect(groupsOf(
      "signature 5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW not found",
      "signature 2jg9xbGLtZRsiJBrDWQnz33JuLjDkiKSZuxZPdjJ3qrJbMeTEerXFAKynkPW63J88nNJmSzwcp6Djbm5frmh1SW6 not found",
    )).toHaveLength(1);
    expect(groupsOf("request 3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f timed out", "request 7a1c0e2d-1b3f-4e5a-9c8d-6f5e4d3c2b1a timed out")).toHaveLength(1);
  });

  it("keeps different errors apart", () => {
    expect(groupsOf("header not found", "missing trie node", "HTTP 429", "HTTP 503", "getTransactionReceipt failed")).toHaveLength(5);
  });

  it("blanks them in a router error too, when no try failed", () => {
    const failed = (error: string) => row({ result: "failed", error });
    expect(groupErrors([failed("no upstream for 0x5f3a9c0e7d1b"), failed("no upstream for 0x77aa")])).toHaveLength(1);
  });
});

describe("groupErrors - who caused it", () => {
  it("puts the client's own error in one group whichever provider answered", () => {
    const nonce = (p: string) => [attempt(p, { replied: true, code: "CHAIN_NONCE_TOO_LOW" })];
    const groups = groupErrors([row({ attempts: nonce("tatum") }), row({ attempts: nonce("tatum") }), row({ attempts: nonce("blockdaemon") })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ cause: "request", count: 3 });
  });

  it("keeps a provider's CHAIN_ code at that provider: data a node doesn't hold is the provider's, not the request's", () => {
    for (const code of ["CHAIN_STATE_PRUNED", "CHAIN_BLOCK_NOT_FOUND", "CHAIN_DATA_NOT_AVAILABLE", "CHAIN_SOLANA_MISSING_LONG_TERM"]) {
      expect(decidingError(row({ attempts: [attempt("tatum", { replied: true, code })] }))).toMatchObject({ cause: "provider", provider: "tatum" });
    }
    const pruned = (p: string) => [attempt(p, { replied: true, code: "CHAIN_STATE_PRUNED" })];
    const groups = groupErrors([row({ attempts: pruned("tatum") }), row({ attempts: pruned("tatum") }), row({ attempts: pruned("blockdaemon") })]);
    expect(groups.map((g) => [g.provider, g.count])).toEqual([["tatum", 2], ["blockdaemon", 1]]);
  });

  it("reads who caused a code from the catalogue, the USER_ prefix only where it says nothing", () => {
    const cause = (code: string) => decidingError(row({ attempts: [attempt("tatum", { replied: true, code })] })).cause;
    expect(cause("NODE_ABORTED")).toBe("request"); // the chain's: any provider says the same
    expect(cause("USER_PARSE_ERROR")).toBe("request"); // undetermined, but the router calls it the user's
    expect(cause("CHAIN_TX_UNDERPRICED")).toBe("provider"); // undetermined: kept at the provider
    expect(cause("USER_SOMETHING_NEW")).toBe("request");
    expect(cause("CHAIN_SOMETHING_NEW")).toBe("provider");
  });

  it("pins 'every provider failed' above bigger groups", () => {
    const big = Array.from({ length: 4 }, () => row({ attempts: [attempt("lava", { replied: true, code: "NODE_SERVER_ERROR" })] }));
    const all = row({ result: "failed", attempts: [attempt("a", { code: "NODE_TIMEOUT" }), attempt("b", { message: "HTTP 503" })] });
    const groups = groupErrors([...big, all]);
    expect(groups[0]).toMatchObject({ pinned: true, count: 1 });
  });

  it("keeps HTTP statuses apart when there is no code", () => {
    const groups = groupErrors([
      row({ attempts: [attempt("lava", { replied: true, message: "HTTP 429" })] }),
      row({ attempts: [attempt("lava", { replied: true, message: "HTTP 503" })] }),
    ]);
    expect(groups.map((g) => g.errorLabel).sort()).toEqual(["HTTP 429", "HTTP 503"]);
  });

  it("counts each method in a group", () => {
    const err = () => [attempt("blockfrost", { replied: true, code: "NODE_DATA_NOT_HELD" })];
    const groups = groupErrors([row({ method: "/addresses/{a}", attempts: err() }), row({ method: "/blocks/{n}", attempts: err() }), row({ method: "/blocks/{n}", attempts: err() })]);
    expect(groups[0]!.methods).toEqual([{ method: "/blocks/{n}", count: 2 }, { method: "/addresses/{a}", count: 1 }]);
  });
});

describe("groupBuckets - a group's requests across the list's span", () => {
  it("counts each request in its stretch of the span", () => {
    expect(groupBuckets([{ time: 0 }, { time: 1 }, { time: 99 }, { time: 100 }], 0, 100, 4)).toEqual([2, 0, 0, 2]);
  });

  it("puts a request outside the span in the nearest end, and a zero span in the last bucket", () => {
    expect(groupBuckets([{ time: -5 }, { time: 500 }], 0, 100, 2)).toEqual([1, 1]);
    expect(groupBuckets([{ time: 7 }], 7, 7, 3)).toEqual([0, 0, 1]);
  });
});

describe("coveredSpan - the times the grouped view says it covers", () => {
  const read = { startMs: 0, endMs: 10_000 };

  it("is the whole of the times read once nothing older is left, wherever the requests fall", () => {
    expect(coveredSpan([5_000, 6_000], read, null)).toEqual({ fromMs: 0, toMs: 10_000 });
  });

  it("starts where the reads on screen begin while older requests are left to load, and ends with the read", () => {
    expect(coveredSpan([7_000, 9_000], read, 6_500)).toEqual({ fromMs: 6_500, toMs: 10_000 });
  });

  it("widens to a request whose lines straddle the read's lower end", () => {
    expect(coveredSpan([6_000, 9_000], read, 6_500)).toEqual({ fromMs: 6_000, toMs: 10_000 });
  });

  it("is the times read even with one request, or none", () => {
    expect(coveredSpan([9_999], read, 9_000)).toEqual({ fromMs: 9_000, toMs: 10_000 });
    expect(coveredSpan([], read, null)).toEqual({ fromMs: 0, toMs: 10_000 });
  });

  it("falls back to the requests' own times without the times read, and to nothing without either", () => {
    expect(coveredSpan([3_000, 1_000, Number.NaN], undefined, null)).toEqual({ fromMs: 1_000, toMs: 3_000 });
    expect(coveredSpan([], undefined, null)).toBeNull();
  });

  it("gives bars that cover it end to end: its first moment in the first bar, its last in the last", () => {
    const span = coveredSpan([2_500], read, 2_000)!;
    expect(groupBuckets([{ time: span.fromMs }, { time: span.toMs }], span.fromMs, span.toMs, 4)).toEqual([1, 0, 0, 1]);
  });
});

describe("groupErrors - every request lands in exactly one group (mixed fixtures)", () => {
  /** A seeded generator, so a failure names a case that comes back. */
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const RESULTS: ErrorRequestRow["result"][] = ["ok", "recovered", "error-reply", "failed", "write-unknown", "unknown"];
  const OUTCOMES: RelayAttempt["outcome"][] = ["ok", "failed", "failed", "skipped", "cancelled", "no-result"];
  const UPSTREAMS = ["lava", "tatum", "blockdaemon", "Cached"];
  const CODES = [null, null, "UNKNOWN_ERROR", "NODE_SERVER_ERROR", "NODE_RATE_LIMITED", "CHAIN_NONCE_TOO_LOW", "CHAIN_STATE_PRUNED", "USER_INVALID_PARAMS", "CHAIN_SOMETHING_NEW"];
  const hex = (next: () => number, n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join("");
  const MESSAGES = [
    (next: () => number) => `transaction 0x${hex(next, 64)} already known`,
    (next: () => number) => `block ${Math.floor(next() * 1e6)} not found`,
    () => "HTTP 429",
    () => "HTTP 503",
    () => 'http request failed: Post "https://node.example.com": context deadline exceeded',
    () => null,
  ];

  function fixtures(seed: number, count: number): ErrorRequestRow[] {
    const next = rng(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!;
    return Array.from({ length: count }, (_, i) => {
      const attempts = Array.from({ length: Math.floor(next() * 5) }, (_, k) =>
        attempt(pick(UPSTREAMS), { batch: k, outcome: pick(OUTCOMES), code: pick(CODES), message: pick(MESSAGES)(next) }));
      const back = attempts.length && next() < 0.6 ? attempts[Math.floor(next() * attempts.length)] : undefined;
      if (back) back.replied = true;
      return row({
        guid: `s${seed}-${i}`,
        time: 1_700_000_000_000 + Math.floor(next() * 3_600_000),
        spec: pick(["ETH1", "SOLANA", null]),
        method: pick(["eth_call", "eth_sendRawTransaction", "getBlock", "unknown"]),
        result: pick(RESULTS),
        attempts,
        errorCode: pick([null, "NODE_GATEWAY_TIMEOUT", "UNKNOWN_ERROR", "USER_INVALID_PARAMS"]),
        error: pick([null, "insufficient results", `no upstream for 0x${hex(next, 40)}`]),
      });
    });
  }

  for (const seed of [1, 2, 3, 42, 2026]) {
    it(`seed ${seed}: each request once, in the group its own key names, with the group's figures its own`, () => {
      const rows = fixtures(seed, 400);
      const groups = groupErrors(rows);

      // Exactly once: every GUID in, each in one group, nothing added.
      const placed = groups.flatMap((g) => g.rows.map((r) => r.guid));
      expect(placed).toHaveLength(rows.length);
      expect(new Set(placed)).toEqual(new Set(rows.map((r) => r.guid)));
      expect(groups.reduce((n, g) => n + g.count, 0)).toBe(rows.length);
      expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);

      for (const g of groups) {
        expect(g.count).toBe(g.rows.length);
        expect(g.methods.reduce((n, m) => n + m.count, 0)).toBe(g.count);
        expect(g.firstMs).toBe(Math.min(...g.rows.map((r) => r.time)));
        expect(g.lastMs).toBe(Math.max(...g.rows.map((r) => r.time)));
        expect(g.rows.map((r) => r.time)).toEqual([...g.rows.map((r) => r.time)].sort((a, b) => b - a));
        for (const r of g.rows) {
          const d = decidingError(r);
          expect([r.spec, d.key, d.cause, d.provider]).toEqual([g.spec, g.errorKey, g.cause, g.provider]);
          expect(["error-reply", "failed", "write-unknown"].includes(r.result)).toBe(g.reached);
          expect(r.result === "unknown").toBe(g.noEnd);
        }
      }

      // Pinned first, then the biggest.
      const order = groups.map((g) => [Number(g.pinned), g.count] as const);
      for (let k = 1; k < order.length; k++) {
        const [pa, ca] = order[k - 1]!;
        const [pb, cb] = order[k]!;
        expect(pa > pb || (pa === pb && ca >= cb)).toBe(true);
      }

      // The bars cover the span the view states: each group's add up to its count.
      const span = coveredSpan(rows.map((r) => r.time), { startMs: 1_700_000_000_000, endMs: 1_700_003_600_000 }, null)!;
      for (const g of groups) expect(groupBuckets(g.rows, span.fromMs, span.toMs, 24).reduce((a, b) => a + b, 0)).toBe(g.count);

      // The same requests in another order make the same groups.
      const again = groupErrors([...rows].reverse());
      expect(new Map(again.map((g) => [g.key, g.count]))).toEqual(new Map(groups.map((g) => [g.key, g.count])));
    });
  }
});
