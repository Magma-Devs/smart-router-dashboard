/**
 * Where an error code is explained.
 *
 * The router classifies every failure into a four-layer taxonomy, and the
 * published reference documents each layer as one table on a single page.
 * A code shown in the dashboard is a name the reader has to look up
 * somewhere; this is the somewhere, so the name links straight to the table
 * that defines it rather than to a page they then have to scan.
 *
 * The anchors are the slugs mkdocs generates from that page's headings — they
 * change only if the headings are retitled, which retitles the layers.
 */

const ERROR_CODES_PAGE = "https://docs.magmadevs.com/reference/error-codes/";

/** Prefix → the layer section that tabulates it. Order is irrelevant: the
 *  four prefixes are disjoint. */
const LAYER_ANCHOR: ReadonlyArray<readonly [prefix: string, anchor: string]> = [
  ["PROTOCOL_", "layer-a-protocol-errors-protocol_-10001999"],
  ["NODE_", "layer-b-node-errors-node_-20002999"],
  ["CHAIN_", "layer-c-blockchain-errors-chain_-30003999"],
  ["USER_", "layer-d-user-errors-user_-40004999"],
];

/** Codes that sit outside the four layers. `UNKNOWN_ERROR` is code 0 — the
 *  fallback the classifier assigns when nothing matched — so it is defined
 *  where classification is explained, not in a layer table. */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  UNKNOWN_ERROR: "how-classification-works",
};

/**
 * The docs url for one error code. Unrecognised codes land on the page
 * itself: the reference is still the right place to be, and a wrong anchor
 * would drop the reader somewhere that doesn't mention their code.
 */
export function errorDocsUrl(code: string): string {
  const name = code.trim().toUpperCase();
  const exception = EXCEPTIONS[name];
  if (exception) return `${ERROR_CODES_PAGE}#${exception}`;
  const layer = LAYER_ANCHOR.find(([prefix]) => name.startsWith(prefix));
  return layer ? `${ERROR_CODES_PAGE}#${layer[1]}` : ERROR_CODES_PAGE;
}
