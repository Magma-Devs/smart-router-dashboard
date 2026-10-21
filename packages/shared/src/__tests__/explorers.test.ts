import { describe, expect, it } from "vitest";
import {
  EXPLORER_KINDS,
  explorerBlockTemplate,
  explorerBlockUrl,
  explorerHome,
  explorersFor,
  explorerTxUrl,
  hasExplorer,
  primaryExplorer,
  TX_PAGES,
  type ChainExplorer,
} from "../constants/explorers.js";
import explorerMap from "../constants/chain-explorers.generated.json" with { type: "json" };
import chainMap from "../constants/chain-map.generated.json" with { type: "json" };

const MAP = explorerMap as Record<string, ChainExplorer[]>;
const hostOf = (u: string) => new URL(u).host;

/* The catalog is only as trustworthy as its block shapes. These assertions are
 * the ones that catch a mis-derivation the eye slides over: a kind that no
 * longer exists, a template pointing one chain's links at another chain's
 * explorer, or a block link on a row that just told you it has none. */
describe("chain-explorers.generated.json", () => {
  const entries = Object.entries(MAP);

  it("covers a useful share of the chain map and no chain outside it", () => {
    const chains = Object.keys(chainMap as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(chains.length / 2);
    for (const spec of Object.keys(MAP)) expect(chains).toContain(spec);
  });

  it.each(entries)("%s: urls are https with no trailing slash, and say how they are known", (_spec, rows) => {
    for (const r of rows) {
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.url).not.toMatch(/\/$/);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.source.length).toBeGreaterThan(0);
      expect(r.verified.length).toBeGreaterThan(0);
    }
  });

  it.each(entries)("%s: every kind resolves, and custom carries its own block template", (_spec, rows) => {
    for (const r of rows) {
      if (r.kind === "custom") expect(r.tpl?.block).toBeTruthy();
      else expect(EXPLORER_KINDS[r.kind]).toBeDefined();
      // The catalog links blocks. A leftover ref is a template for a value the
      // dashboard does not hold.
      if (r.tpl) expect(Object.keys(r.tpl)).toEqual(["block"]);
    }
  });

  it.each(entries)("%s: block templates stay on-host and keep their placeholder", (_spec, rows) => {
    for (const r of rows) {
      const tpl = explorerBlockTemplate(r);
      if (tpl === null) continue;
      expect(tpl).toMatch(/^https:\/\//);
      expect(hostOf(tpl)).toBe(hostOf(r.url));
      expect(tpl).toContain("{block}");
      expect(tpl.replace("https://", "")).not.toContain("//");
    }
  });

  /* The regression test for the bug this catalog shipped once: a kind was
   * matched on the transaction and address templates and then contributed its
   * own block shape, so 31 rows claimed a block page nobody had seen work. A
   * row that says it has no block page must not have one. */
  it.each(entries)("%s: a row that announces no block page does not ship one", (_spec, rows) => {
    for (const r of rows) {
      if (!/no block page|only the home page is offered/.test(r.verified)) continue;
      expect(r.kind).toBe("home");
      expect(explorerBlockTemplate(r)).toBeNull();
    }
  });

  it("offers a block link for most chains, and a home page for the rest", () => {
    const deep = entries.filter(([spec]) => explorerBlockUrl(spec, 1) !== null);
    expect(deep.length).toBeGreaterThan(entries.length / 2);
    const homeOnly = entries.filter(([spec]) => explorerBlockUrl(spec, 1) === null);
    for (const [spec] of homeOnly) expect(explorerHome(spec)).not.toBeNull();
  });
});

describe("explorer kinds", () => {
  it.each(Object.entries(EXPLORER_KINDS))("%s: the block template is {base}-rooted and documented", (kind, def) => {
    expect(def.label.length).toBeGreaterThan(0);
    expect(def.proven.length).toBeGreaterThan(0);
    if (kind === "home") {
      expect(def.block).toBeUndefined();
      return;
    }
    expect(def.block?.startsWith("{base}")).toBe(true);
    expect(def.block).toContain("{block}");
  });
});

describe("explorerBlockUrl", () => {
  it("composes a block link", () => {
    expect(explorerBlockUrl("ETH1", 21345102)).toBe("https://etherscan.io/block/21345102");
  });

  it("keeps a network suffix on both the home page and the block link", () => {
    expect(explorerHome("SOLANAD")).toBe("https://explorer.solana.com?cluster=devnet");
    expect(explorerBlockUrl("SOLANAD", 42)).toBe("https://explorer.solana.com/block/42?cluster=devnet");
  });

  // A consensus-layer spec reports a SLOT as its latest block.
  it("uses an explicit template where a kind does not fit", () => {
    expect(explorerBlockUrl("ETHBEACON", 9876543)).toBe("https://beaconcha.in/slot/9876543");
  });

  it("returns null rather than a guess when nothing is known", () => {
    expect(explorerBlockUrl("NOT_A_CHAIN", 1)).toBeNull();
    expect(explorerHome("NOT_A_CHAIN")).toBeNull();
    expect(explorersFor("NOT_A_CHAIN")).toEqual([]);
    expect(hasExplorer("NOT_A_CHAIN")).toBe(false);
    // Declared `none` in the overlay — a deliberate gap, not an oversight.
    expect(hasExplorer("CANTON")).toBe(false);
  });

  it("returns null for a home-only explorer instead of linking the home page", () => {
    const home = Object.keys(MAP).find((s) => primaryExplorer(s)?.kind === "home");
    expect(home).toBeDefined();
    expect(explorerBlockUrl(home as string, 1)).toBeNull();
    expect(explorerHome(home as string)).not.toBeNull();
  });

  // A height is digits. A hash reaching this function means a caller passed
  // the wrong field, and composing a url from it would link to nothing.
  it("refuses anything that is not a height", () => {
    expect(explorerBlockUrl("ETH1", "0xabc")).toBeNull();
    expect(explorerBlockUrl("ETH1", "  ")).toBeNull();
    expect(explorerBlockUrl("ETH1", " 42 ")).toBe("https://etherscan.io/block/42");
  });

  it("can be pointed at a specific explorer rather than the primary", () => {
    const spec = Object.keys(MAP).find(
      (s) => (MAP[s]?.length ?? 0) > 1 && explorerBlockUrl(s, 7, MAP[s]?.[1]) !== null,
    );
    expect(spec).toBeDefined();
    const alt = MAP[spec as string]?.[1] as ChainExplorer;
    expect(explorerBlockUrl(spec as string, 7, alt)).toContain(alt.url);
  });
});

/* Transaction pages are curated, not generated: each chain's page was watched
 * rendering a real transaction. These keep the table and the catalog in step. */
describe("explorerTxUrl", () => {
  const EVM = "0x" + "8f3a91c2".repeat(8);
  const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYVCJjBRSJ2mWbmJu3pXr8ZqAiBXhBxwMpvz1k7iVNyQFJqU1n2Yb";
  const DIGEST = "8kNVrbs2QzMnVuMxQ7f2YtaE9qH1rJ4Z5pW3cX6vB9dL";
  const COSMOS = "4D1E9F0A6B2C8E7D3F5A1B9C0D2E4F6A8B0C1D3E5F7A9B1C3D5E7F9A1B3C5D7E";

  it("an EVM chain: its explorer's /tx/<hash>", () => {
    expect(explorerTxUrl("ETH1", EVM)).toBe(`https://etherscan.io/tx/${EVM}`);
    expect(explorerTxUrl("BASE", EVM)).toBe(`https://basescan.org/tx/${EVM}`);
  });

  it("Solana: the cluster stays on the url for testnet and devnet", () => {
    expect(explorerTxUrl("SOLANA", SIG)).toBe(`https://explorer.solana.com/tx/${SIG}`);
    expect(explorerTxUrl("SOLANAT", SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=testnet`);
    expect(explorerTxUrl("SOLANAD", SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
  });

  it("Sui and Cosmos: the network's own path", () => {
    expect(explorerTxUrl("SUI", DIGEST)).toBe(`https://suiscan.xyz/mainnet/tx/${DIGEST}`);
    expect(explorerTxUrl("SUIT", DIGEST)).toBe(`https://suiscan.xyz/testnet/tx/${DIGEST}`);
    expect(explorerTxUrl("COSMOSHUB", COSMOS)).toBe(`https://www.mintscan.io/cosmos/tx/${COSMOS}`);
  });

  it("null for a chain with no watched page, and for a hash not in the chain's form", () => {
    expect(explorerTxUrl("BSC", EVM)).toBeNull(); // its page sits behind a challenge no one has watched past
    expect(explorerTxUrl("NOT_A_CHAIN", EVM)).toBeNull();
    expect(explorerTxUrl("ETH1", SIG)).toBeNull();
    expect(explorerTxUrl("ETH1", EVM.slice(0, 40))).toBeNull();
    expect(explorerTxUrl("SOLANA", EVM)).toBeNull();
    expect(explorerTxUrl("COSMOSHUB", `${COSMOS}"><script>`)).toBeNull();
  });

  it.each(Object.entries(TX_PAGES))("%s: names an explorer the catalog lists for it, on its host, and says how it is known", (spec, page) => {
    const e = explorersFor(spec).find((x) => x.name === page.explorer);
    expect(e).toBeDefined();
    expect(page.tx).toContain("{base}");
    expect(page.tx).toContain("{hash}");
    expect(page.verified.length).toBeGreaterThan(0);
    const sample = { evm: EVM, base58: SIG, hex: COSMOS }[page.hash];
    expect(hostOf(explorerTxUrl(spec, sample)!)).toBe(hostOf(e!.url));
  });
});
