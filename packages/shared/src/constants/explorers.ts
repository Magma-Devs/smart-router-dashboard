// Same JSON-import attribute requirement as chains.ts — the compiled dist runs
// on Node 24, whose ESM loader hard-errors without it.
import explorerMap from "./chain-explorers.generated.json" with { type: "json" };
import explorerKinds from "./explorer-kinds.json" with { type: "json" };

/**
 * Where a human goes to check a chain, keyed by Lava spec index.
 *
 * Every number the dashboard renders for a chain — a latest block, a tip lag,
 * a hash in a Try-it response — is a claim about a public chain. This map is
 * what lets the UI hand the reader the receipt.
 *
 * GENERATED from lava-specs joined to ethereum-lists/chains and
 * cosmos/chain-registry through each spec's `chain-id` verification, plus a
 * curated overlay for the families neither registry covers. Regenerate:
 * `node apps/web/scripts/generate-chain-explorers.mjs`. Procedure and the
 * curation rules: docs/CHAINS.md.
 *
 * THE CONTRACT, and the reason this module has an api instead of being a
 * plain record: `explorerUrl()` returns **null** rather than a guessed URL.
 * A chain with no verified deep-link shape offers its home page and nothing
 * else, and a caller that cannot get a url must render plain text. A link
 * that 404s is worse than no link — it makes the dashboard look wrong about
 * the chain when it is only wrong about the explorer.
 */

/** What a link points at. `block` always takes a block HEIGHT, never a hash —
 *  explorers whose block page is addressed by hash ship no block template. */
export type ExplorerRef = "block" | "tx" | "address";

/** A deep-link shape shared by many explorers. `{base}` is the entry's url. */
export interface ExplorerKind {
  label: string;
  /** Which explorers this shape was proven against. */
  proven: string;
  block?: string;
  tx?: string;
  address?: string;
}

export interface ChainExplorer {
  /** Display name — "Etherscan", "Mintscan". */
  name: string;
  /** Home page, no trailing slash. */
  url: string;
  /** A key in explorer-kinds.json, or "custom" when `tpl` carries the shapes. */
  kind: string;
  /** Explicit per-ref templates; present when no kind matched. */
  tpl?: Partial<Record<ExplorerRef, string>>;
  /** Appended to every url including the home one — "?cluster=devnet". */
  suffix?: string;
  /**
   * How this shape is known: a registry's own assertion, a page watched
   * rendering in a browser, or "unverified — <reason>". Never empty. A
   * surface that offers the link may show it; a reviewer reads it to tell a
   * checked claim from an inherited one.
   */
  verified: string;
  /** Provenance: which registry row, or which curation, this came from. */
  source: string;
}

const MAP = explorerMap as Record<string, ChainExplorer[]>;
const KINDS = explorerKinds as Record<string, ExplorerKind>;

/** Every deep-link shape, for a reference surface that wants to show them. */
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

/** The template for one ref on one explorer, or null when it serves none. */
export function explorerTemplate(explorer: ChainExplorer, ref: ExplorerRef): string | null {
  const explicit = explorer.tpl?.[ref];
  if (explicit) return explicit;
  const shape = KINDS[explorer.kind]?.[ref];
  return shape ? shape.replace("{base}", explorer.url) : null;
}

/**
 * A deep link to `value` on the chain's explorer, or **null** when no verified
 * shape exists for that ref. Callers must handle null by rendering the value
 * as plain text — never by falling back to the home page, which silently sends
 * the reader somewhere that does not answer their question.
 *
 * `value` is not encoded beyond `encodeURIComponent`: every ref is a height,
 * hash or address, so anything needing more escaping than that is not a value
 * this function was given honestly.
 */
export function explorerUrl(
  spec: string,
  ref: ExplorerRef,
  value: string | number,
  explorer?: ChainExplorer,
): string | null {
  const e = explorer ?? primaryExplorer(spec);
  if (!e) return null;
  const tpl = explorerTemplate(e, ref);
  if (tpl === null) return null;
  const raw = typeof value === "number" ? String(value) : value.trim();
  if (!raw) return null;
  return tpl.replace(`{${ref}}`, encodeURIComponent(raw)) + (e.suffix ?? "");
}
