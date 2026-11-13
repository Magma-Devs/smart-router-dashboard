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
