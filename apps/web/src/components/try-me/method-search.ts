/**
 * Finding a method in the Try-it drawer.
 *
 * The command dropdown opens on a SHORT list — the commands that run as-is
 * (`headCommands`) — because a list where most entries fail is not a list you
 * can try things from. That short list is a promise, and it stays.
 *
 * What it cost was findability: a customer looking for `eth_getBlockByHash`
 * saw twelve entries, none of them it, and concluded the dashboard did not
 * carry the method. It did — behind "Show all", under a native `<select>`
 * whose popup covers the very button that would have said so.
 *
 * So the picker searches, and this module is the part of that worth testing:
 * how a query matches a command, and how the catalog's three-way
 * classification is worded on screen.
 */

import type { AddonCommand, CatalogInterface } from "./chain-methods";
import { commandKey, friendlyName } from "./method-label";

/**
 * How sure the catalog is that a command can be sent with what it ships.
 *
 * The third state is the point. `ready` and `needsInput` are claims the
 * generator can prove (a curated example; a placeholder, a hint documenting
 * the argument, or the spec's own arity rule). A command with neither is one
 * nobody has checked — and until now the drawer rendered it exactly like a
 * method that genuinely takes no arguments, which is how `eth_getBlockByHash`
 * came to send `[]` at a node and fail with an unexplained RPC error.
 *
 * "Not verified" is not "broken" and not "needs params". It is the honest
 * third answer, and it is worded as one.
 */
export type Runnability = "ready" | "needs-input" | "unverified";

export function runnabilityOf(cmd: AddonCommand): Runnability {
  if (cmd.ready) return "ready";
  if (cmd.needsInput) return "needs-input";
  return "unverified";
}

/** Section headings, in the order the picker stacks them. */
export const RUNNABILITY_ORDER: Runnability[] = ["ready", "needs-input", "unverified"];

export const RUNNABILITY_LABEL: Record<Runnability, string> = {
  ready: "Ready to send",
  "needs-input": "Needs params",
  unverified: "Not verified",
};

/** The `title` on each heading — why the group exists, in one sentence. */
export const RUNNABILITY_HINT: Record<Runnability, string> = {
  ready:
    "These carry a checked example. Pick one and press Send — nothing else to fill in.",
  "needs-input":
    "These take an argument the catalog cannot supply (a hash, an address, a height). Fill the params in before sending.",
  unverified:
    "Nobody has checked these against a live node, so the catalog claims nothing about them. They may take arguments — read the params before sending.",
};

/** Split a tier's commands into the three sections, keeping catalog order. */
export function partitionByRunnability<R extends { cmd: AddonCommand }>(
  rows: R[],
): Record<Runnability, R[]> {
  const out: Record<Runnability, R[]> = {
    ready: [],
    "needs-input": [],
    unverified: [],
  };
  for (const row of rows) out[runnabilityOf(row.cmd)].push(row);
  return out;
}

/**
 * Everything a query and a method id can disagree about that should not stop
 * a match: `eth_getBlockByHash` has to be reachable by "getblockbyhash",
 * "get block by hash", "eth_getblock" and "GetBlockByHash", and a REST path
 * `/cosmos/bank/v1beta1/balances` by "bank balances".
 */
const SEPARATORS = /[\s_\-./:]+/g;

function fold(value: string): string {
  return value.toLowerCase().replace(SEPARATORS, "");
}

/**
 * Where a query matched, best first. Kept as an explicit ladder rather than a
 * fuzzy score because the ranking has to be explainable: a user who types a
 * method id exactly must get that method first, always — not something whose
 * description happens to mention it.
 */
const Rank = {
  ExactId: 0,
  IdPrefix: 1,
  IdContains: 2,
  /** Every word of the query appears in the id, in any order. This is the
   *  band that makes a Cosmos LCD searchable: nobody types
   *  `/cosmos/bank/v1beta1/balances`, they type "bank balances", and the
   *  version segment in the middle stops any contiguous match. */
  IdTokens: 3,
  NameContains: 4,
  DescContains: 5,
} as const;

/** A query, prepared once per search rather than once per command. */
export interface PreparedQuery {
  /** Lowercased and trimmed, spaces intact — for matching prose. */
  raw: string;
  /** Separators removed, so `eth_getBlockByHash` answers to "getblockbyhash". */
  folded: string;
  /** The query's words, each folded. Empty for a query of pure separators. */
  tokens: string[];
}

export function prepareQuery(input: string): PreparedQuery {
  const raw = input.trim().toLowerCase();
  const tokens = raw.split(SEPARATORS).filter((t) => t !== "");
  return { raw, folded: tokens.join(""), tokens };
}

/**
 * Rank one command against a prepared query. Null when it does not match.
 *
 * Exported for the tests; the picker uses `searchCommands`.
 */
export function matchRank(
  iface: CatalogInterface,
  cmd: AddonCommand,
  query: PreparedQuery,
): number | null {
  const id = fold(commandKey(iface, cmd));
  if (query.folded !== "") {
    if (id === query.folded) return Rank.ExactId;
    if (id.startsWith(query.folded)) return Rank.IdPrefix;
    if (id.includes(query.folded)) return Rank.IdContains;
    if (query.tokens.length > 1 && query.tokens.every((t) => id.includes(t))) {
      return Rank.IdTokens;
    }
    const name = friendlyName(iface, cmd);
    if (name !== null) {
      const folded = fold(name);
      if (folded.includes(query.folded)) return Rank.NameContains;
      if (query.tokens.length > 1 && query.tokens.every((t) => folded.includes(t))) {
        return Rank.NameContains;
      }
    }
  }
  // The description is matched unfolded: it is prose, and a reader searching
  // it types words with the spaces in.
  if (query.raw !== "" && (cmd.desc ?? "").toLowerCase().includes(query.raw)) {
    return Rank.DescContains;
  }
  return null;
}

/**
 * Filter and rank rows for a query. An empty query returns the rows as they
 * came, so the caller can use one code path for "searching" and "not".
 *
 * Within a rank band, runnable commands come first — a search for "block"
 * should lead with the ones that answer.
 */
export function searchCommands<R extends { cmd: AddonCommand }>(
  rows: R[],
  query: string,
  iface: CatalogInterface,
): R[] {
  const prepared = prepareQuery(query);
  if (prepared.raw === "") return rows;
  const scored: { row: R; rank: number; order: number }[] = [];
  rows.forEach((row, order) => {
    const rank = matchRank(iface, row.cmd, prepared);
    if (rank !== null) scored.push({ row, rank, order });
  });
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const ar = a.row.cmd.ready ? 0 : 1;
    const br = b.row.cmd.ready ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.order - b.order;
  });
  return scored.map((entry) => entry.row);
}
