import { describe, expect, it } from "vitest";
import {
  ERROR_SOURCES,
  ERROR_SOURCE_LABELS,
  ROUTER_ERROR_CODES,
  explainRouterError,
} from "../index.js";

const all = Object.values(ROUTER_ERROR_CODES);

/** The number range the router's registry gives each name prefix. */
const RANGES: ReadonlyArray<readonly [prefix: string, lo: number, hi: number]> = [
  ["PROTOCOL_", 1000, 1999],
  ["NODE_", 2000, 2999],
  ["CHAIN_", 3000, 3999],
  ["USER_", 4000, 4999],
];

describe("router error codes", () => {
  it("covers every code smart-router v1.6.0 registers, plus UNKNOWN_ERROR", () => {
    // 133 registered codes + UNKNOWN_ERROR. A new router code changes this on purpose.
    expect(all).toHaveLength(134);
    expect(ROUTER_ERROR_CODES.UNKNOWN_ERROR?.code).toBe(0);
  });

  it("keys each entry by its own name, and no two share a number", () => {
    for (const [key, entry] of Object.entries(ROUTER_ERROR_CODES)) expect(entry.name).toBe(key);
    expect(new Set(all.map((e) => e.code)).size).toBe(all.length);
  });

  it("files each name under the number range its prefix owns", () => {
    for (const e of all) {
      if (e.name === "UNKNOWN_ERROR") continue;
      const range = RANGES.find(([prefix]) => e.name.startsWith(prefix));
      expect(range, e.name).toBeDefined();
      const [, lo, hi] = range!;
      expect(e.code, e.name).toBeGreaterThanOrEqual(lo);
      expect(e.code, e.name).toBeLessThanOrEqual(hi);
    }
  });

  it("gives every code a known source, a meaning and an action, as full sentences", () => {
    for (const e of all) {
      expect(ERROR_SOURCES, e.name).toContain(e.source);
      for (const text of [e.meaning, e.action]) {
        expect(text.trim(), e.name).toBe(text);
        expect(text, e.name).toMatch(/^[A-Z].*[.]$/s);
        expect(text, e.name).not.toMatch(/[–—]/);
      }
    }
  });

  it("labels every source", () => {
    expect(Object.keys(ERROR_SOURCE_LABELS).sort()).toEqual([...ERROR_SOURCES].sort());
  });

  it("never tells the customer to ask us for work", () => {
    for (const e of all)
      expect(e.action, e.name).not.toMatch(/\b(contact us|ask us|we will|we'll)\b/i);
  });

  it("warns that a transaction may have gone through after a broken or timed-out connection", () => {
    for (const name of [
      "PROTOCOL_CONNECTION_TIMEOUT",
      "PROTOCOL_CONNECTION_RESET",
      "PROTOCOL_CONNECTION_CLOSED",
      "PROTOCOL_CONTEXT_DEADLINE",
      "NODE_GATEWAY_TIMEOUT",
      "NODE_BAD_GATEWAY",
      "UNKNOWN_ERROR",
    ]) {
      const e = ROUTER_ERROR_CODES[name];
      expect(e?.mayHaveGoneThrough, name).toBe(true);
      expect(e?.action, name).toContain("check the chain before sending it again");
    }
    // Refused before it was sent: nothing reached a node.
    expect(ROUTER_ERROR_CODES.PROTOCOL_CONNECTION_REFUSED?.mayHaveGoneThrough).toBe(false);
  });

  it("tags a not-found answer as the provider's", () => {
    for (const name of ["NODE_DATA_NOT_HELD", "CHAIN_BLOCK_NOT_FOUND", "CHAIN_TX_NOT_FOUND"]) {
      expect(ROUTER_ERROR_CODES[name]?.source, name).toBe("provider");
    }
  });

  it("never retries an answer it tags as the chain's or the request's", () => {
    for (const e of all) {
      if (e.source === "chain" || e.source === "request")
        expect(e.routerRetries, e.name).toBe(false);
    }
  });
});

describe("explainRouterError", () => {
  it("finds a code by name, whatever the case or surrounding spaces", () => {
    expect(explainRouterError("NODE_DATA_NOT_HELD")?.code).toBe(2017);
    expect(explainRouterError("  chain_nonce_too_low ")?.source).toBe("chain");
  });

  it("returns null for nothing, an unknown name, or an object key that isn't a code", () => {
    expect(explainRouterError(null)).toBeNull();
    expect(explainRouterError(undefined)).toBeNull();
    expect(explainRouterError("")).toBeNull();
    expect(explainRouterError("NODE_SOMETHING_NEW")).toBeNull();
    expect(explainRouterError("toString")).toBeNull();
    expect(explainRouterError("__proto__")).toBeNull();
    expect(explainRouterError("constructor")).toBeNull();
  });
});
