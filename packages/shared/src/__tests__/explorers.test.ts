import { describe, expect, it } from "vitest";
import {
  EXPLORER_KINDS,
  explorerHome,
  explorerTemplate,
  explorerUrl,
  explorersFor,
  hasExplorer,
  primaryExplorer,
  type ChainExplorer,
  type ExplorerRef,
} from "../constants/explorers.js";
import explorerMap from "../constants/chain-explorers.generated.json" with { type: "json" };
import chainMap from "../constants/chain-map.generated.json" with { type: "json" };

const MAP = explorerMap as Record<string, ChainExplorer[]>;
const REFS: ExplorerRef[] = ["block", "tx", "address"];
const hostOf = (u: string) => new URL(u).host;

/* The generated catalog is only as trustworthy as its shapes. These assertions
 * are the ones that catch a mis-derivation the eye slides over: a kind that no
 * longer exists, or a template quietly pointing one chain's links at another
 * chain's explorer. */
describe("chain-explorers.generated.json", () => {
  const entries = Object.entries(MAP);

  it("covers a useful share of the chain map and no chain outside it", () => {
    const chains = Object.keys(chainMap as Record<string, unknown>);
    expect(entries.length).toBeGreaterThan(chains.length / 2);
    for (const spec of Object.keys(MAP)) expect(chains).toContain(spec);
  });

  it.each(entries)("%s: urls are https with no trailing slash", (_spec, rows) => {
    for (const r of rows) {
      expect(r.url).toMatch(/^https:\/\//);
      expect(r.url).not.toMatch(/\/$/);
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.source.length).toBeGreaterThan(0);
      // Every row says how its shape is known — a row nobody can review is
      // the failure mode this catalog exists to avoid.
      expect(r.verified.length).toBeGreaterThan(0);
    }
  });

  it.each(entries)("%s: every kind resolves, and custom carries its own templates", (_spec, rows) => {
    for (const r of rows) {
      if (r.kind === "custom") expect(Object.keys(r.tpl ?? {}).length).toBeGreaterThan(0);
      else expect(EXPLORER_KINDS[r.kind]).toBeDefined();
    }
  });

  // The one that matters: a template must stay on its own explorer's host and
  // must carry the placeholder it claims to fill. Both halves have to hold —
  // a same-host template with no placeholder links every block to block one.
  it.each(entries)("%s: templates stay on-host and keep their placeholder", (_spec, rows) => {
    for (const r of rows) {
      for (const ref of REFS) {
        const tpl = explorerTemplate(r, ref);
        if (tpl === null) continue;
        expect(tpl).toMatch(/^https:\/\//);
        expect(hostOf(tpl)).toBe(hostOf(r.url));
        expect(tpl).toContain(`{${ref}}`);
      }
    }
  });

  it("offers deep links for most chains, not just home pages", () => {
    const deep = entries.filter(([spec]) => explorerUrl(spec, "block", 1) !== null);
    expect(deep.length).toBeGreaterThan(entries.length / 2);
  });
});

describe("explorer kinds", () => {
  it.each(Object.entries(EXPLORER_KINDS))("%s: templates are {base}-rooted and documented", (kind, def) => {
    expect(def.label.length).toBeGreaterThan(0);
    expect(def.proven.length).toBeGreaterThan(0);
    for (const ref of REFS) {
      const tpl = def[ref];
      if (tpl === undefined) continue;
      expect(tpl.startsWith("{base}")).toBe(true);
      expect(tpl).toContain(`{${ref}}`);
    }
    if (kind === "home") expect(def.block ?? def.tx ?? def.address).toBeUndefined();
  });
});

describe("explorerUrl", () => {
  it("composes an EIP-3091 deep link", () => {
    expect(explorerUrl("ETH1", "block", 21345102)).toBe("https://etherscan.io/block/21345102");
    expect(explorerUrl("ETH1", "tx", "0xabc")).toBe("https://etherscan.io/tx/0xabc");
    expect(explorerUrl("ETH1", "address", "0xdef")).toBe("https://etherscan.io/address/0xdef");
  });

  it("keeps a network suffix on both the home page and the deep link", () => {
    expect(explorerHome("SOLANAD")).toBe("https://explorer.solana.com?cluster=devnet");
    expect(explorerUrl("SOLANAD", "block", 42)).toBe("https://explorer.solana.com/block/42?cluster=devnet");
  });

  // A consensus-layer spec reports a SLOT as its latest block, and beaconcha.in
  // has no transaction page at all — the two halves of the same entry.
  it("uses an explicit template and returns null for the refs it lacks", () => {
    expect(explorerUrl("ETHBEACON", "block", 9876543)).toBe("https://beaconcha.in/slot/9876543");
    expect(explorerUrl("ETHBEACON", "tx", "0xabc")).toBeNull();
  });

  it("returns null rather than a guess when nothing is known", () => {
    expect(explorerUrl("NOT_A_CHAIN", "block", 1)).toBeNull();
    expect(explorerHome("NOT_A_CHAIN")).toBeNull();
    expect(explorersFor("NOT_A_CHAIN")).toEqual([]);
    expect(hasExplorer("NOT_A_CHAIN")).toBe(false);
    // Declared `none` in the overlay — a deliberate gap, not an oversight.
    expect(hasExplorer("CANTON")).toBe(false);
  });

  it("returns null for a home-only explorer instead of linking the home page", () => {
    const home = Object.keys(MAP).find((s) => primaryExplorer(s)?.kind === "home");
    expect(home).toBeDefined();
    expect(explorerUrl(home as string, "block", 1)).toBeNull();
    expect(explorerHome(home as string)).not.toBeNull();
  });

  it("refuses an empty value and escapes the one it is given", () => {
    expect(explorerUrl("ETH1", "tx", "   ")).toBeNull();
    expect(explorerUrl("ETH1", "address", "a b")).toBe("https://etherscan.io/address/a%20b");
  });

  it("can be pointed at a specific explorer rather than the primary", () => {
    const spec = Object.keys(MAP).find(
      (s) => (MAP[s]?.length ?? 0) > 1 && explorerUrl(s, "block", 7, MAP[s]?.[1]) !== null,
    );
    expect(spec).toBeDefined();
    const alt = MAP[spec as string]?.[1] as ChainExplorer;
    const url = explorerUrl(spec as string, "block", 7, alt);
    expect(url).toContain(alt.url);
    expect(url).not.toBe(explorerUrl(spec as string, "block", 7));
  });
});
