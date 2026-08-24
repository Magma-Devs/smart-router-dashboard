/**
 * Upstream VENDOR identity — which commercial RPC provider is behind a
 * configured node.
 *
 * Shared, not duplicated, because both sides of the app ask the same question
 * and a disagreement is a visible bug: the **api** derives which vendors this
 * deployment routes through (so it knows whose status page to read, and for
 * which chains), and the **web** decides which upstream card gets that
 * vendor's logo and its status chip. Two copies of this map would eventually
 * put a chip on a card the api never fetched a status for.
 *
 * The ids ARE the Status Page Index slugs (`drpc`, `quicknode`, …), which is
 * what lets a card join itself to a vendor's status with no translation
 * table. Presentation — brand colour, onboarding flow, JWT support — stays in
 * the web's catalog: none of it means anything to the api.
 *
 * Matching is by the node's masked url host first (the values file's own
 * evidence) and only then by the node's name, because an operator's name for
 * a node is free text and a url is not.
 */

export interface VendorIdentity {
  /** SPI slug == the web's upstream catalog id. */
  id: string;
  name: string;
  /** Primary domain — also what the logo lookup uses. */
  domain: string;
  /** Host shapes the primary domain misses (vanity gateways, per-chain hosts). */
  domainPattern?: RegExp;
}

export const VENDOR_IDENTITIES: VendorIdentity[] = [
  { id: "alchemy",     name: "Alchemy",     domain: "alchemy.com" },
  { id: "infura",      name: "Infura",      domain: "infura.io" },
  { id: "quicknode",   name: "QuickNode",   domain: "quicknode.com",   domainPattern: /\.quiknode\.pro/ },
  { id: "ankr",        name: "Ankr",        domain: "ankr.com" },
  { id: "chainstack",  name: "Chainstack",  domain: "chainstack.com",  domainPattern: /\.p2pify\.com|chainstack/ },
  { id: "drpc",        name: "dRPC",        domain: "drpc.org" },
  { id: "getblock",    name: "GetBlock",    domain: "getblock.io",     domainPattern: /getblock\.io/ },
  { id: "blockpi",     name: "BlockPI",     domain: "blockpi.io",      domainPattern: /blockpi\.network/ },
  { id: "nodereal",    name: "NodeReal",    domain: "nodereal.io" },
  { id: "tatum",       name: "Tatum",       domain: "tatum.io",        domainPattern: /gateway\.tatum\.io/ },
  { id: "blockdaemon", name: "Blockdaemon", domain: "blockdaemon.com", domainPattern: /blockdaemon\.com/ },
  { id: "tenderly",    name: "Tenderly",    domain: "tenderly.co",     domainPattern: /tenderly\.co/ },
  /* The rest of the index's roster. A vendor missing from this list can never
     light a chip however loudly their status page is burning — which is what
     happened to OnFinality, in a major outage while the dashboard had no way
     to name them. The ids are pinned against the index's slugs by test. */
  { id: "coinbase-developer-platform", name: "Coinbase Developer Platform", domain: "coinbase.com", domainPattern: /developer\.coinbase\.com|\.cdp\.coinbase\.com/ },
  { id: "dwellir",     name: "Dwellir",     domain: "dwellir.com" },
  { id: "grove",       name: "Grove",       domain: "grove.city",      domainPattern: /rpc\.grove\.city/ },
  { id: "helius",      name: "Helius",      domain: "helius.dev",      domainPattern: /helius-rpc\.com|helius\.xyz/ },
  { id: "moralis",     name: "Moralis",     domain: "moralis.io",      domainPattern: /moralis-nodes\.com/ },
  { id: "nownodes",    name: "NOWNodes",    domain: "nownodes.io" },
  { id: "onfinality",  name: "OnFinality",  domain: "onfinality.io" },
  { id: "triton-one",  name: "Triton One",  domain: "triton.one",      domainPattern: /rpcpool\.com|triton\.one/ },
];

export function vendorById(id: string | null | undefined): VendorIdentity | null {
  if (!id) return null;
  return VENDOR_IDENTITIES.find((v) => v.id === id) ?? null;
}

/**
 * The vendor behind one configured node, or null for a node nobody sells —
 * a public endpoint or the operator's own. Null is the common answer and is
 * never guessed around: an unmatched node simply carries no vendor status.
 */
export function matchVendor(nodeName: string, urlHosts: string[]): VendorIdentity | null {
  for (const vendor of VENDOR_IDENTITIES) {
    for (const host of urlHosts) {
      if (host.includes(vendor.domain)) return vendor;
      if (vendor.domainPattern?.test(host)) return vendor;
    }
  }
  const lower = nodeName.toLowerCase();
  return (
    VENDOR_IDENTITIES.find((v) => lower.includes(v.name.toLowerCase()) || lower.includes(v.id)) ??
    null
  );
}
