/**
 * Provider names as their companies write them.
 *
 * The values file names a node however the operator typed it — "quicknode",
 * "blockdaemon" — and a card read "Quicknode" in one line and "quicknode" in
 * the next. Every sentence the api writes goes through this.
 *
 * A name that is not listed is kept exactly as configured: a guess at
 * someone's brand is worse than their own id.
 */
const BRANDS: Record<string, string> = {
  alchemy: "Alchemy",
  blockdaemon: "Blockdaemon",
  blockpi: "BlockPI",
  chainstack: "Chainstack",
  drpc: "dRPC",
  getblock: "GetBlock",
  helius: "Helius",
  infura: "Infura",
  lava: "Lava",
  nodereal: "NodeReal",
  publicnode: "PublicNode",
  quicknode: "QuickNode",
  tatum: "Tatum",
};

export function providerName(id: string): string {
  return BRANDS[id.trim().toLowerCase()] ?? id;
}
