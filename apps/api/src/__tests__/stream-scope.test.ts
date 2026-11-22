import { describe, expect, it } from "vitest";
import {
  isServiceNameOf,
  serviceNameClash,
  serviceNameId,
  serviceNameMatcher,
  serviceNameOf,
  StreamScope,
  withMatcher,
} from "../services/stream-scope.js";
import type { LokiClient } from "../services/loki-client.js";
import { selectorMatches } from "./label-matchers.js";

const SELECTOR = '{cluster="t1",component="router"}';
const UNPINNED = '{component="router"}';

function loki(labels: Record<string, string[] | null>) {
  const asked: string[] = [];
  const client = {
    async labelValues(label: string, selector: string) {
      asked.push(`${label} ${selector}`);
      return labels[label] ?? null;
    },
  } as unknown as LokiClient;
  return { client, asked };
}

describe("withMatcher", () => {
  it("adds one equality matcher to a stream selector", () => {
    expect(withMatcher(SELECTOR, "chain", "solana")).toBe('{cluster="t1",component="router", chain="solana"}');
  });

  it("refuses a value that can't sit in a matcher as is, and a selector that isn't a plain {…}", () => {
    expect(withMatcher(SELECTOR, "chain", 'x"} |= "y')).toBeNull();
    expect(withMatcher(`${SELECTOR} |= "x"`, "chain", "solana")).toBeNull();
  });
});

/* The chart labels a router's pods with its id lower-cased, and the fleet's
   collector names them `<tenant>-<that label>`: a values file's `ETH-Prod`
   is `example-eth-prod` on its streams, series and recorded counts. */
describe("a router's service_name", () => {
  it("carries the id lower-cased, after the tenant", () => {
    expect(serviceNameId("ETH-Prod")).toBe("eth-prod");
    expect(serviceNameOf("example", "ETH-Prod")).toBe("example-eth-prod");
  });

  it("is told by its end where the tenant isn't known, in any case the values file writes the id", () => {
    expect(isServiceNameOf("example-eth-prod", "ETH-Prod")).toBe(true);
    expect(isServiceNameOf("example-eth-prod", "eth-prod")).toBe(true);
    expect(isServiceNameOf("example-xeth-prod", "eth-prod")).toBe(false);
    expect(isServiceNameOf("eth-prod", "eth-prod")).toBe(false);
  });

  it("clashes with another router of the chain whose id is its own or ends in it, compared lower-cased", () => {
    expect(serviceNameClash("eth-a", ["Archive-ETH-A"])).toBe(true);
    expect(serviceNameClash("ETH-A", ["archive-eth-a"])).toBe(true);
    expect(serviceNameClash("eth-a", ["ETH-A"])).toBe(true);
    expect(serviceNameClash("eth-a", ["eth-b", "eth-ab", "eth-a-archive"])).toBe(false);
    expect(serviceNameClash("eth-a", [])).toBe(false);
  });

  it("is matched as `.+-<id lower-cased>` where the tenant isn't known", () => {
    const matcher = serviceNameMatcher("ETH-Prod");
    expect(matcher).toBe('service_name=~".+-eth-prod"');
    const sel = `{${matcher}}`;
    expect(selectorMatches(sel, { service_name: "example-eth-prod" })).toBe(true);
    expect(selectorMatches(sel, { service_name: "example-eth-canary" })).toBe(false);
    // The tenant is required: a bare id is no router's service_name.
    expect(selectorMatches(sel, { service_name: "eth-prod" })).toBe(false);
  });

  it("escapes the id for the regex and the quoted string: a dot matches only a dot", () => {
    const matcher = serviceNameMatcher("Eth.A");
    expect(matcher).toBe('service_name=~".+-eth\\\\.a"');
    const sel = `{${matcher}}`;
    expect(selectorMatches(sel, { service_name: "example-eth.a" })).toBe(true);
    expect(selectorMatches(sel, { service_name: "example-ethxa" })).toBe(false);
  });

  it("is no matcher for an id that isn't a plain token", () => {
    expect(serviceNameMatcher('eth"} or vector(1) #')).toBeNull();
    expect(serviceNameMatcher("eth a")).toBeNull();
    expect(serviceNameMatcher("")).toBeNull();
  });
});

describe("StreamScope · the router's streams narrowed by their own labels", () => {
  it("a chain reads only its streams: chain is the spec lower-cased", async () => {
    const { client } = loki({ chain: ["solana", "solanat", "eth1"] });
    expect(await new StreamScope(client, SELECTOR).narrow("SOLANA")).toBe('{cluster="t1",component="router", chain="solana"}');
  });

  it("a router reads only its own streams: <tenant>-<id lower-cased>, exactly, where the selector names the tenant", async () => {
    const { client } = loki({ service_name: ["t1-eth-hoodi-testnet", "t1-eth-hoodi-testnet-2", "t2-eth-hoodi-testnet"], chain: ["hod1"] });
    expect(await new StreamScope(client, SELECTOR).narrow("HOD1", "ETH-Hoodi-Testnet"))
      .toBe('{cluster="t1",component="router", service_name="t1-eth-hoodi-testnet"}');
  });

  it("with no tenant in the selector, the one service_name ending in -<id>; several fall back to the chain", async () => {
    const one = loki({ service_name: ["t1-a-x", "t1-b-y"], chain: ["hod1"] });
    expect(await new StreamScope(one.client, UNPINNED).narrow("HOD1", "a-x")).toBe('{component="router", service_name="t1-a-x"}');
    expect(await new StreamScope(one.client, UNPINNED).narrow("HOD1", "A-X")).toBe('{component="router", service_name="t1-a-x"}');
    const two = loki({ service_name: ["t1-a-x", "t2-a-x"], chain: ["hod1"] });
    expect(await new StreamScope(two.client, UNPINNED).narrow("HOD1", "a-x")).toBe('{component="router", chain="hod1"}');
  });

  it("streams without the labels, or a Loki that doesn't say, narrow nothing: the lists read as before", async () => {
    expect(await new StreamScope(loki({ chain: [] }).client, SELECTOR).narrow("SOLANA")).toBeNull();
    expect(await new StreamScope(loki({}).client, SELECTOR).narrow("SOLANA", "solana-mainnet")).toBeNull();
    expect(await new StreamScope(loki({ chain: ["solana"] }).client, SELECTOR).narrow()).toBeNull();
  });

  it("asks Loki once per label for ten minutes", async () => {
    let now = 1_000_000;
    const { client, asked } = loki({ chain: ["solana"] });
    const scope = new StreamScope(client, SELECTOR, () => now);
    await scope.narrow("SOLANA");
    await scope.narrow("SOLANA");
    expect(asked).toHaveLength(1);
    now += 10 * 60_000;
    await scope.narrow("SOLANA");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(`chain ${SELECTOR}`);
  });
});

/* The fleet's log agent labels a router's relay_end lines relay_end="1". A
   line written before the label existed carries none, so a read uses the label
   only where the index has it before the read's start and at its end. */
describe("StreamScope.relayEnd", () => {
  const MIN = 60_000;
  const END = 1_800_000_000_000;
  const START = END - 60 * MIN;

  /** A series index whose relay_end="1" streams hold lines from `since` on (null: Loki doesn't say). */
  function index(since: number | null) {
    const asked: [number, number][] = [];
    const client = {
      async hasStreams(selector: string, startMs: number, endMs: number) {
        asked.push([startMs, endMs]);
        if (!selector.includes('relay_end="1"') || since === null) return null;
        return endMs > since;
      },
    } as unknown as LokiClient;
    return { client, asked };
  }

  it("narrows to relay_end=\"1\" when labelled streams hold lines before the start and at the end", async () => {
    const { client, asked } = index(START - 30 * MIN);
    expect(await new StreamScope(client, SELECTOR, () => END).relayEnd(SELECTOR, START, END))
      .toBe('{cluster="t1",component="router", relay_end="1"}');
    expect(asked).toEqual([[START - 5 * MIN, START], [END - 5 * MIN, END]]);
  });

  it("keeps the selector for a read that starts before the label existed, or where it never does", async () => {
    expect(await new StreamScope(index(START + MIN).client, SELECTOR, () => END).relayEnd(SELECTOR, START, END)).toBe(SELECTOR);
    expect(await new StreamScope(index(START).client, SELECTOR, () => END).relayEnd(SELECTOR, START, END)).toBe(SELECTOR);
    expect(await new StreamScope(index(Infinity).client, SELECTOR, () => END).relayEnd(SELECTOR, START, END)).toBe(SELECTOR);
  });

  it("keeps the selector when Loki doesn't say, and for one it can't add a matcher to, without asking", async () => {
    expect(await new StreamScope(index(null).client, SELECTOR, () => END).relayEnd(SELECTOR, START, END)).toBe(SELECTOR);
    const { client, asked } = index(0);
    const piped = `${SELECTOR} |= "x"`;
    expect(await new StreamScope(client, SELECTOR, () => END).relayEnd(piped, START, END)).toBe(piped);
    expect(asked).toEqual([]);
  });

  it("asks about a read shorter than five minutes from its start to its end", async () => {
    const { client, asked } = index(0);
    await new StreamScope(client, SELECTOR, () => END).relayEnd(SELECTOR, END - 2 * MIN, END);
    expect(asked[1]).toEqual([END - 2 * MIN, END]);
  });

  it("narrows a selector already narrowed to a chain, as the caller passes it", async () => {
    const chain = withMatcher(SELECTOR, "chain", "solana")!;
    expect(await new StreamScope(index(0).client, SELECTOR, () => END).relayEnd(chain, START, END))
      .toBe('{cluster="t1",component="router", chain="solana", relay_end="1"}');
  });

  it("keeps an answer a minute, per minute of the read's start and end", async () => {
    let now = END;
    const { client, asked } = index(0);
    const scope = new StreamScope(client, SELECTOR, () => now);
    await scope.relayEnd(SELECTOR, START, END);
    await scope.relayEnd(SELECTOR, START + 1_000, END + 1_000);
    expect(asked).toHaveLength(2);
    await scope.relayEnd(SELECTOR, START + MIN, END + MIN);
    expect(asked).toHaveLength(4);
    now += MIN;
    await scope.relayEnd(SELECTOR, START, END);
    expect(asked).toHaveLength(6);
  });
});
