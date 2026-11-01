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

  it("gives every code a known source and a meaning, and any action, as full sentences", () => {
    for (const e of all) {
      expect(ERROR_SOURCES, e.name).toContain(e.source);
      for (const text of e.action ? [e.meaning, e.action] : [e.meaning]) {
        expect(text.trim(), e.name).toBe(text);
        expect(text, e.name).toMatch(/^[A-Z].*[.]$/s);
        expect(text, e.name).not.toMatch(/[–—]/);
      }
    }
  });

  it("keeps a meaning to two short sentences at most, with no hedging about the code", () => {
    for (const e of all) {
      expect(e.meaning.split(/(?<=[.])\s+/).length, e.name).toBeLessThanOrEqual(2);
      expect(e.meaning.length, e.name).toBeLessThanOrEqual(130);
      expect(e.meaning, e.name).not.toMatch(/\bthe code (alone )?doesn't say\b/i);
      expect(e.meaning, e.name).not.toMatch(/\bthe provider's message does\b/i);
    }
  });

  it("labels every source", () => {
    expect(Object.keys(ERROR_SOURCE_LABELS).sort()).toEqual([...ERROR_SOURCES].sort());
  });

  it("never tells the client to ask us for work", () => {
    for (const e of all)
      expect(e.action, e.name).not.toMatch(/\b(contact us|ask us|we will|we'll)\b/i);
  });

  it("calls the sender the client, never the customer", () => {
    for (const e of all)
      for (const text of [e.meaning, e.action]) expect(text, e.name).not.toMatch(/\bcustomer/i);
  });

  it("leaves the action empty rather than saying there is nothing to do", () => {
    for (const e of all) {
      expect(e.action, e.name).not.toMatch(/\bno action\b/i);
      expect(e.action, e.name).not.toMatch(/^nothing\b/i);
      // The screen already shows the provider's message.
      expect(e.action, e.name).not.toMatch(/\bread the (provider's |error )?message\b/i);
    }
  });

  it("doesn't tell the client to retry a provider failure the router already retries", () => {
    for (const name of [
      "PROTOCOL_CONNECTION_TIMEOUT",
      "PROTOCOL_CONNECTION_REFUSED",
      "PROTOCOL_CONNECTION_RESET",
      "PROTOCOL_CONNECTION_CLOSED",
      "PROTOCOL_NO_RESPONSE_TIMEOUT",
      "NODE_INTERNAL_ERROR",
      "NODE_SERVER_ERROR",
      "NODE_RATE_LIMITED",
      "NODE_SERVICE_UNAVAILABLE",
      "NODE_GATEWAY_TIMEOUT",
      "NODE_BAD_GATEWAY",
      "NODE_SYNCING",
      "UNKNOWN_ERROR",
    ]) {
      expect(ROUTER_ERROR_CODES[name]?.routerRetries, name).toBe(true);
      expect(ROUTER_ERROR_CODES[name]?.action, name).toBe("");
    }
    for (const e of all) {
      if (e.source === "provider" && e.routerRetries)
        expect(e.action, e.name).not.toMatch(/^retry (later|shortly)\.$/i);
    }
  });

  it("leaves the may-have-gone-through warning to its tag, not the action", () => {
    for (const e of all) expect(e.action, e.name).not.toMatch(/it may have gone through/i);
    // A broken or timed-out connection still carries the tag.
    for (const name of [
      "PROTOCOL_CONNECTION_TIMEOUT",
      "PROTOCOL_CONNECTION_RESET",
      "PROTOCOL_CONNECTION_CLOSED",
      "PROTOCOL_CONTEXT_DEADLINE",
      "NODE_GATEWAY_TIMEOUT",
      "NODE_BAD_GATEWAY",
      "UNKNOWN_ERROR",
    ])
      expect(ROUTER_ERROR_CODES[name]?.mayHaveGoneThrough, name).toBe(true);
    // Refused before it was sent: nothing reached a node.
    expect(ROUTER_ERROR_CODES.PROTOCOL_CONNECTION_REFUSED?.mayHaveGoneThrough).toBe(false);
  });

  it("keeps the check before resending where it is the main step", () => {
    expect(ROUTER_ERROR_CODES.CHAIN_NONCE_TOO_LOW?.action).toBe(
      "Check the chain before sending again.",
    );
    expect(ROUTER_ERROR_CODES.CHAIN_TX_REJECTED?.action).toBe(
      "Check the chain before sending again.",
    );
  });

  it("uses the approved wording", () => {
    const approved: Record<string, [meaning: string, action: string]> = {
      NODE_SERVER_ERROR: ["The provider's server failed while handling the request.", ""],
      UNKNOWN_ERROR: ["The router got an error it doesn't recognize.", ""],
      PROTOCOL_CONNECTION_TIMEOUT: ["The provider didn't answer in time.", ""],
      NODE_RATE_LIMITED: ["The provider is limiting our requests right now.", ""],
      NODE_METHOD_NOT_SUPPORTED: ["This provider doesn't support this method.", ""],
      NODE_DATA_NOT_HELD: [
        "The provider doesn't have this data. It may not exist yet, or be older than the provider keeps.",
        "Check the ID, address or block number.",
      ],
      CHAIN_INSUFFICIENT_FUNDS: [
        "Not enough funds for the amount and the fee.",
        "Add funds or lower the amount.",
      ],
      CHAIN_NONCE_TOO_LOW: [
        "This nonce was already used.",
        "Check the chain before sending again.",
      ],
    };
    for (const [name, [meaning, action]] of Object.entries(approved)) {
      expect(ROUTER_ERROR_CODES[name]?.meaning, name).toBe(meaning);
      expect(ROUTER_ERROR_CODES[name]?.action, name).toBe(action);
    }
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
