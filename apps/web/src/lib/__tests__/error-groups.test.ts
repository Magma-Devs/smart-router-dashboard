import { describe, expect, it } from "vitest";
import type { ErrorRequestRow, RelayAttempt } from "@sr/shared";
import { decidingError, groupBuckets, groupErrors } from "../error-groups";

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
