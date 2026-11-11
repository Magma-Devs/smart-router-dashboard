/**
 * Provider companies — the business behind an upstream.
 *
 * An upstream is a node name on a chain (`provider_address` on `smartrouter_*`,
 * `endpoint_id` on `rpc_endpoint_*`). One company usually runs many of them:
 * "tatum" on twenty chains, or "blockdaemon" and "blockdaemon-2" as two
 * accounts. The Providers tab groups by company, so the grouping rule lives
 * here, shared by the api (which aggregates) and the web (which labels).
 *
 * The web's `UPSTREAM_CATALOG` still owns logos and the add-upstream flow;
 * this list owns identity for numbers.
 */

export interface ProviderCompany {
  /** Stable id, lowercase. */
  id: string;
  /** Display name. */
  name: string;
  /** URL host patterns that identify the company. */
  hosts: RegExp[];
  /** Other node names the same company appears under. */
  aliases?: string[];
}

export const PROVIDER_COMPANIES: readonly ProviderCompany[] = [
  { id: "tatum", name: "Tatum", hosts: [/(^|\.)tatum\.io$/] },
  { id: "blockdaemon", name: "Blockdaemon", hosts: [/(^|\.)blockdaemon\.com$/] },
  { id: "alchemy", name: "Alchemy", hosts: [/(^|\.)alchemy\.com$/, /(^|\.)alchemyapi\.io$/] },
  { id: "quicknode", name: "QuickNode", hosts: [/\.quiknode\.pro$/, /(^|\.)quicknode\.com$/] },
  { id: "lava", name: "Lava", hosts: [/(^|\.)lavanet\.xyz$/], aliases: ["lavanet"] },
  { id: "blockfrost", name: "Blockfrost", hosts: [/(^|\.)blockfrost\.io$/] },
  { id: "infura", name: "Infura", hosts: [/(^|\.)infura\.io$/] },
  { id: "chainstack", name: "Chainstack", hosts: [/\.p2pify\.com$/, /(^|\.)chainstack\.com$/] },
  { id: "drpc", name: "dRPC", hosts: [/(^|\.)drpc\.org$/] },
  { id: "getblock", name: "GetBlock", hosts: [/(^|\.)getblock\.io$/] },
  { id: "blockpi", name: "BlockPI", hosts: [/(^|\.)blockpi\.network$/] },
  { id: "nodereal", name: "NodeReal", hosts: [/(^|\.)nodereal\.io$/] },
  { id: "publicnode", name: "PublicNode", hosts: [/(^|\.)publicnode\.com$/] },
];

export interface ProviderIdentity {
  /** Company id — the grouping key. */
  id: string;
  /** Company display name. */
  name: string;
  /** Account suffix when the node name carries one (`blockdaemon-2` ⇒ "2"). */
  account: string | null;
}

const BY_ID = new Map(PROVIDER_COMPANIES.map((c) => [c.id, c]));
const BY_ALIAS = new Map(
  PROVIDER_COMPANIES.flatMap((c) => (c.aliases ?? []).map((a) => [a, c] as const)),
);

/**
 * True for a label value that can be a node name. Some router builds write
 * URL or header fragments into `endpoint_id` / `provider_address` (`https`,
 * `gzip,`, `{"sch`, a 5-hex stub). Those never become a provider: their
 * traffic is reported as "unattributed" instead.
 */
export function looksLikeNodeName(name: string): boolean {
  if (!name) return false;
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) return false;
  if (/^(https?|wss?|grpcs?|gzip|deflate|br)$/i.test(name)) return false;
  // A short hex stub like `d644d` or `0c539` - a hash fragment, not a name.
  if (/^[0-9a-f]{4,8}$/i.test(name) && /\d/.test(name)) return false;
  return name.toLowerCase() !== "cached";
}

function companyByName(lower: string): ProviderCompany | undefined {
  const exact = BY_ID.get(lower) ?? BY_ALIAS.get(lower);
  if (exact) return exact;
  // "eth-lava", "tatum-solana": the company id inside a longer node name.
  return PROVIDER_COMPANIES.find((c) => lower.split(/[-_.]/).includes(c.id))
    ?? PROVIDER_COMPANIES.find((c) => (c.aliases ?? []).some((a) => lower.split(/[-_.]/).includes(a)));
}

/**
 * Which company runs this node.
 *
 * Precedence: the values file's `group-label` → a URL host match → the node
 * name → the node name itself, as its own provider. A trailing `-2`, `-3`, …
 * is a second account at the same company.
 */
export function providerOf(node: {
  name: string;
  urlHosts?: readonly string[];
  groupLabel?: string | null;
}): ProviderIdentity {
  const accountMatch = /^(.*?)-(\d+)$/.exec(node.name);
  const base = accountMatch ? accountMatch[1]! : node.name;
  const account = accountMatch ? accountMatch[2]! : null;

  if (node.groupLabel) {
    const g = node.groupLabel.toLowerCase();
    const company = BY_ID.get(g) ?? BY_ALIAS.get(g);
    return { id: company?.id ?? g, name: company?.name ?? node.groupLabel, account };
  }
  for (const host of node.urlHosts ?? []) {
    const h = host.toLowerCase();
    const company = PROVIDER_COMPANIES.find((c) => c.hosts.some((re) => re.test(h)));
    if (company) return { id: company.id, name: company.name, account };
  }
  const company = companyByName(base.toLowerCase());
  if (company) return { id: company.id, name: company.name, account };
  return { id: base.toLowerCase(), name: base, account };
}
