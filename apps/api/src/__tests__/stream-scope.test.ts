import { describe, expect, it } from "vitest";
import { StreamScope, withMatcher } from "../services/stream-scope.js";
import type { LokiClient } from "../services/loki-client.js";

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
