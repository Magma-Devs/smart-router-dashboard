// Same JSON-import attribute requirement as chains.ts — the compiled dist runs
// on Node 24, whose ESM loader hard-errors without it.
import explorerMap from "./chain-explorers.generated.json" with { type: "json" };
import explorerKinds from "./explorer-kinds.json" with { type: "json" };

/**
 * Where a human goes to check a chain, keyed by Lava spec index.
 *
 * The dashboard renders exactly one value a public chain can confirm: a block
 * HEIGHT — the router's tip, an upstream's tip, the lag between them. It holds
 * no transaction hash and no chain address anywhere (`provider_address` is an
 * upstream's name, not an on-chain address), so this catalog offers a block
 * link and a home link, and nothing else. It stored transaction and address
 * templates once; they addressed values that did not exist, and 18 chains
 * carried nothing but those — covered in the catalog, unlinkable in the UI.
 *
 * GENERATED from lava-specs joined to ethereum-lists/chains and
 * cosmos/chain-registry through each spec's `chain-id` verification, plus a
 * curated overlay for the families neither registry covers. Regenerate:
 * `node apps/web/scripts/generate-chain-explorers.mjs`. Procedure and the
 * curation rules: docs/CHAINS.md.
 *
 * THE CONTRACT: `explorerBlockUrl()` returns **null** rather than a guessed
 * URL, and a caller that gets null must render the height as plain text —
 * never fall back to the home page, which sends the reader somewhere that
 * does not answer their question. A block shape is only ever shipped when a
 * registry supplied it or a person watched it render; the alternative is a
 * link that lands on an empty page, which makes the dashboard look wrong
 * about the chain when it is only wrong about the explorer.
 */

/** A block-page shape shared by many explorers. `{base}` is the entry's url. */
export interface ExplorerKind {
  label: string;
  /** Which explorers this shape was proven against. */
  proven: string;
  /** Absent on `home`, which claims no deep link at all. */
  block?: string;
}

export interface ChainExplorer {
  /** Display name — "Etherscan", "Mintscan". */
  name: string;
  /** Home page, no trailing slash. */
  url: string;
  /** A key in explorer-kinds.json, or "custom" when `tpl` carries the shape. */
  kind: string;
  /** Explicit block template; present when no kind matched. */
  tpl?: { block: string };
  /** Appended to every url including the home one — "?cluster=devnet". */
  suffix?: string;
  /**
   * How this shape is known: a registry's own assertion, a shape proven on
   * another deployment of the same explorer, a page watched rendering in a
   * browser, or "unverified — <reason>". Never empty. A reviewer reads it to
   * tell a checked claim from an inherited one.
   */
  verified: string;
  /** Provenance: which registry row, or which curation, this came from. */
  source: string;
}

const MAP = explorerMap as Record<string, ChainExplorer[]>;
const KINDS = explorerKinds as Record<string, ExplorerKind>;

/** Every block-page shape, for a reference surface that wants to show them. */
export const EXPLORER_KINDS = KINDS;

/** Explorers for a spec index, primary first. Empty when the chain has none —
 *  either no explorer exists or none has been verified; both are recorded
 *  deliberately in the overlay rather than left to chance. */
export function explorersFor(spec: string): ChainExplorer[] {
  return MAP[spec] ?? [];
}

/** The primary explorer for a spec index, or null. */
export function primaryExplorer(spec: string): ChainExplorer | null {
  return MAP[spec]?.[0] ?? null;
}

/** True when the chain has any explorer at all. */
export function hasExplorer(spec: string): boolean {
  return (MAP[spec]?.length ?? 0) > 0;
}

/** The explorer's home page (suffix applied), or null. */
export function explorerHome(spec: string): string | null {
  const e = primaryExplorer(spec);
  return e ? e.url + (e.suffix ?? "") : null;
}

/** The block template for one explorer, or null when it serves none. */
export function explorerBlockTemplate(explorer: ChainExplorer): string | null {
  return explorer.tpl?.block ?? KINDS[explorer.kind]?.block?.replace("{base}", explorer.url) ?? null;
}

/**
 * A link to `block` on the chain's explorer, or **null** when no proven shape
 * exists. Null is a supported, common outcome — 45 chains offer a home page
 * and no block link — and callers must render the height as plain text there.
 */
export function explorerBlockUrl(
  spec: string,
  block: string | number,
  explorer?: ChainExplorer,
): string | null {
  const e = explorer ?? primaryExplorer(spec);
  if (!e) return null;
  const tpl = explorerBlockTemplate(e);
  if (tpl === null) return null;
  const raw = typeof block === "number" ? String(block) : block.trim();
  // A height is digits. Anything else reached this function by mistake, and
  // composing a url from it would produce a link that cannot resolve.
  if (!/^\d+$/.test(raw)) return null;
  return tpl.replace("{block}", raw) + (e.suffix ?? "");
}
