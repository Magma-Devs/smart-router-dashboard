/**
 * generate-chain-explorers.mjs — resolve every Lava spec index to its official
 * block explorer(s), so the dashboard can link a number it renders (a latest
 * block, a tip, a hash) to the public chain it is a claim about.
 *
 * One entry per index, an ARRAY ordered primary-first:
 *
 *   "ETH1": [{ name, url, kind, verified, source }]
 *
 * The catalog links ONE thing: a block HEIGHT. That is the only value the
 * dashboard holds which a public chain can confirm — the router's tip, an
 * upstream's tip, the lag between them. It has no transaction hash and no
 * chain address anywhere, so transaction and address templates addressed
 * values that did not exist and are gone.
 *
 *   - name    what to render on the link ("Etherscan")
 *   - url     the explorer home, no trailing slash
 *   - kind    a key in packages/shared/src/constants/explorer-kinds.json —
 *             the deep-link SHAPE. Never a guess: it is either the registry's
 *             own template proven to match, or a human-probed curation.
 *   - tpl     an explicit block template, when the registry's shape matches
 *             no kind. Same-host + https enforced here and re-asserted by
 *             the shared unit test.
 *   - suffix  appended to every URL including the home ("?cluster=devnet")
 *   - verified HOW THE SHAPE IS KNOWN — a registry's own assertion, a shape
 *             proven on another deployment of the SAME explorer, a page
 *             watched rendering in a browser, or an honest "unverified" with
 *             the reason. Every row carries one; see docs/CHAINS.md
 *
 * ⚠ A kind is never allowed to CONTRIBUTE a shape the registry did not
 * supply. An earlier version matched a kind on the transaction and address
 * templates and let it add its own block template on top; that shipped 31
 * block links nobody had ever seen work, 23 of them the primary. On Lava's
 * STAVR explorer the invented `/block/<height>` renders an empty shell. A
 * shape is now either supplied by the registry, proven on another deployment
 * of the same host, or absent.
 *   - source  provenance — which registry row or which curation this came from
 *
 * THE JOIN KEY is the spec's `chain-id` VERIFICATION, not the index:
 * ETH1 → "0x1", COSMOSHUB → "cosmoshub-4". Two public registries key off it:
 *
 *   ethereum-lists/chains   EVM-family hex chain ids → explorers[] + EIP3091
 *   cosmos/chain-registry   cosmos chain ids → tx/account/block page templates
 *
 * Everything else — bitcoin, solana, aptos/sui, ton, tron, xrp, xlm, … — comes
 * from the curated overlay (scripts/data/explorer-overlay.json), which also
 * OVERRIDES either registry and can record "this chain has no explorer" as a
 * deliberate, reviewable fact.
 *
 * ⚠ A hex chain-id is NOT an EVM chain id. Starknet's 0x534e5f4d41494e is
 * ASCII "SN_MAIN"; the Polkadot/Kusama/substrate/VeChain values are 32-byte
 * genesis hashes. The chainlist lookup is therefore gated on BOTH the family
 * and the hex width — without that, KUSAMA silently wears the logo and links
 * of whatever chain holds that decimal id.
 *
 * DETERMINISM: the registries are read from a COMMITTED snapshot, so a CI
 * drift run depends only on lava-specs + the committed inputs. Refreshing the
 * snapshot from the live registries is a deliberate act:
 *
 *   node apps/web/scripts/generate-chain-explorers.mjs              # snapshot
 *   node apps/web/scripts/generate-chain-explorers.mjs --refresh    # re-fetch
 *   LAVA_SPECS_DIR=~/projects/lava-specs node …                     # local specs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSpecsToDir } from "./lib/lava-specs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, "..");
const ROOT = path.resolve(WEB, "../..");

const REFRESH = process.argv.includes("--refresh");

const SNAPSHOT_PATH = path.join(__dirname, "data/explorer-registry.snapshot.json");
const OVERLAY_PATH = path.join(__dirname, "data/explorer-overlay.json");
const KINDS_PATH = path.join(ROOT, "packages/shared/src/constants/explorer-kinds.json");
// The drift check regenerates the chain map first and points us at the FRESH
// one, so a chain added upstream is resolved in the same pass instead of
// waiting for the next run.
const CHAIN_MAP_IN =
  process.env.CHAIN_MAP_IN ?? path.join(ROOT, "packages/shared/src/constants/chain-map.generated.json");
const OUT_PATH =
  process.env.EXPLORERS_OUT ?? path.join(ROOT, "packages/shared/src/constants/chain-explorers.generated.json");
const NO_EXPLORER_OUT =
  process.env.NO_EXPLORER_OUT ?? path.join(__dirname, "data/no-explorer.generated.json");

/** Families whose `chain-id` verification really is an EVM chain id. */
const EVM_FAMILIES = new Set(["evm", "evm-arbitrum", "hedera"]);
/** 0x + at most 8 hex digits. Wider means a genesis hash, not a chain id. */
const EVM_CHAIN_ID_RE = /^0x[0-9a-f]{1,8}$/i;
/** Chainlist rows that are analytics dashboards rather than block explorers. */
const NOT_AN_EXPLORER = [/(^|\.)dex\.guru$/i];
/** At most this many explorers per chain — the first is what the UI links. */
const MAX_PER_CHAIN = 2;

const KINDS = JSON.parse(readFileSync(KINDS_PATH, "utf8"));
const OVERLAY = JSON.parse(readFileSync(OVERLAY_PATH, "utf8"));
const CHAIN_MAP = JSON.parse(readFileSync(CHAIN_MAP_IN, "utf8"));

/* ── spec loading ────────────────────────────────────────────────────────── */

function loadSpecs(dir) {
  const byIndex = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const json = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    for (const spec of json?.proposal?.specs ?? []) {
      if (spec.index && !byIndex.has(spec.index)) byIndex.set(spec.index, spec);
    }
  }
  return byIndex;
}

/** The spec's declared chain-id, or null. "*" is a wildcard, not an id. */
function chainIdOf(spec) {
  for (const c of spec.api_collections ?? []) {
    for (const v of c.verifications ?? []) {
      if (v.name !== "chain-id") continue;
      for (const pv of v.values ?? []) {
        const ev = pv.expected_value;
        if (typeof ev === "string" && ev && ev !== "*") return ev;
      }
    }
  }
  return null;
}

/* ── url helpers ─────────────────────────────────────────────────────────── */

const trimBase = (u) => String(u).trim().replace(/\/+$/, "");

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/** Render a kind template for a base. */
function render(tpl, base) {
  return tpl.replace("{base}", base);
}

/** An https URL on the same host as `base`. Anything else is dropped rather
 *  than shipped — a template pointing off-host is a mis-derivation. */
function sameHostHttps(url, base) {
  const h = hostOf(url);
  return Boolean(h) && h === hostOf(base) && url.startsWith("https://");
}

/* ── registry snapshot ───────────────────────────────────────────────────── */

const GH_TREE = "https://api.github.com/repos/cosmos/chain-registry/git/trees/master?recursive=1";
const CHAINLIST = "https://chainid.network/chains.json";
const RAW = "https://raw.githubusercontent.com/cosmos/chain-registry/master";

function ghHeaders() {
  const h = { "User-Agent": "srdash-chain-explorers", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: headers ?? { "User-Agent": "srdash-chain-explorers" } });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Re-fetch both registries, keeping only the rows the current specs need.
 * Cosmos is the expensive side: the registry is one directory per chain, so
 * the recursive tree is fetched once and only the directories whose name
 * plausibly matches a chain-id we need are downloaded — then VERIFIED by
 * comparing the file's own chain_id. A near-miss directory is discarded, not
 * accepted; an unmatched chain-id is reported for curation.
 */
async function refreshSnapshot(needEvm, needCosmos) {
  const snapshot = { chainlist: {}, cosmos: {} };

  console.log(`refreshing chainlist for ${needEvm.size} evm chain ids …`);
  const chains = await getJson(CHAINLIST);
  for (const c of chains) {
    const id = String(c.chainId);
    if (!needEvm.has(id)) continue;
    const explorers = (c.explorers ?? [])
      .filter((e) => e?.url && !NOT_AN_EXPLORER.some((re) => re.test(hostOf(e.url) ?? "")))
      .map((e) => ({ name: e.name, url: trimBase(e.url), standard: e.standard ?? "none" }));
    if (explorers.length) snapshot.chainlist[id] = explorers;
  }

  console.log(`refreshing chain-registry for ${needCosmos.size} cosmos chain ids …`);
  const tree = await getJson(GH_TREE, ghHeaders());
  const paths = [];
  for (const node of tree.tree ?? []) {
    const m = /^(?:testnets\/)?([^/]+)\/chain\.json$/.exec(node.path);
    if (!m || m[1].startsWith("_") || m[1] === ".github") continue;
    paths.push(node.path);
  }
  // Every chain.json is read rather than guessing which directory holds a
  // chain id. A cosmos chain id rarely resembles its registry directory —
  // bbn-1 is babylon, pion-1 is neutrontestnet, osmo-test-5 is
  // osmosistestnet — and a name-similarity shortlist silently dropped 27 of
  // the 50 chains we serve. The scan costs one --refresh, which is rare.
  console.log(`  scanning ${paths.length} chain.json files …`);
  const CONCURRENCY = 12;
  let cursor = 0;
  let matched = 0;
  async function worker() {
    while (cursor < paths.length) {
      const p = paths[cursor++];
      let chain;
      try {
        chain = await getJson(`${RAW}/${p}`);
      } catch {
        continue;
      }
      // The chain id in the file is the identity; the directory name is not.
      if (!chain?.chain_id || !needCosmos.has(chain.chain_id)) continue;
      const explorers = (chain.explorers ?? [])
        .filter((e) => e?.url)
        .map((e) => ({
          kind: e.kind ?? null,
          url: trimBase(e.url),
          block_page: e.block_page ?? null,
          tx_page: e.tx_page ?? null,
          account_page: e.account_page ?? null,
        }));
      matched += 1;
      if (explorers.length) {
        snapshot.cosmos[chain.chain_id] = { dir: p.replace(/\/chain\.json$/, ""), explorers };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`  matched ${matched} of ${needCosmos.size} cosmos chain ids in the registry`);

  const sortKeys = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const out = {
    note: "Registry rows for the chain ids the current specs declare. Refresh with `node apps/web/scripts/generate-chain-explorers.mjs --refresh`. Committed so a CI drift run never depends on a live third-party registry.",
    chainlist: sortKeys(snapshot.chainlist),
    cosmos: sortKeys(snapshot.cosmos),
  };
  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `snapshot        ${Object.keys(out.chainlist).length} evm ids, ${Object.keys(out.cosmos).length} cosmos ids → ${SNAPSHOT_PATH}`,
  );
  const missed = [...needCosmos].filter((id) => !out.cosmos[id]);
  if (missed.length) console.log(`  no registry dir ${missed.join(", ")}`);
  return out;
}

/* ── resolution ──────────────────────────────────────────────────────────── */

/**
 * Block shapes the registry PROVED, keyed by explorer host.
 *
 * cosmos/chain-registry supplies `block_page` for some rows and not others —
 * Mintscan's `/blocks/${blockHeight}` is spelled out on COSMOSHUB but left
 * null on the twelve other Mintscan deployments we serve. Those twelve are
 * the same explorer on the same host, so the proven shape carries across;
 * that is an inheritance with evidence behind it, not a guess.
 *
 * Keyed on HOST rather than on the registry's `kind` string, which is free
 * text ("guru", "🔥STAVR🔥", "Stake Village") and is not a software identity.
 */
function provenBlockShapes(snapshot) {
  const byHost = new Map();
  for (const entry of Object.values(snapshot.cosmos ?? {})) {
    for (const e of entry.explorers) {
      const base = trimBase(e.url);
      const tpl = convertRegistryTemplate(e.block_page);
      if (!tpl || !sameHostHttps(tpl, base) || !tpl.startsWith(base)) continue;
      const host = hostOf(base);
      // {base} is this deployment's own prefix; what generalises is the tail.
      if (host && !byHost.has(host)) byHost.set(host, tpl.slice(base.length));
    }
  }
  return byHost;
}

/** chain-registry placeholders → ours. Any OTHER ${…} means a template we
 *  cannot fill, so the template is dropped rather than emitted half-rendered. */
function convertRegistryTemplate(t) {
  if (typeof t !== "string" || !t) return null;
  const converted = t
    .replace(/\$\{blockHeight\}/g, "{block}")
    // The registry hands LAV1 "https://lava.explorers.guru//transaction/…".
    // A doubled slash is not a path segment; normalise rather than ship it.
    .replace(/([^:])\/{2,}/g, "$1/");
  return /\$\{/.test(converted) ? null : converted;
}

/** The kind whose rendered block template EXACTLY equals the one we hold, or
 *  null. Exact equality is what makes a kind assignment a proof: the kind is
 *  a shorthand for a shape already established, never a source of one. */
function kindMatching(base, blockTpl) {
  if (!blockTpl) return null;
  for (const [kind, def] of Object.entries(KINDS)) {
    if (kind === "home" || !def.block) continue;
    if (render(def.block, base) === blockTpl) return kind;
  }
  return null;
}

function fromChainlist(rows) {
  const out = [];
  for (const e of rows) {
    const base = trimBase(e.url);
    if (!base.startsWith("https://")) continue;
    // EIP3091 is the registry's own assertion about the shape; anything else
    // gets the home page only.
    // EIP-3091 defines /block/<height>, and the row asserting that standard
    // is the registry's own claim about this explorer's shape.
    const eip3091 = String(e.standard).toUpperCase() === "EIP3091";
    out.push({
      name: e.name,
      url: base,
      kind: eip3091 ? "block" : "home",
      verified: eip3091
        ? "registry — the chainlist row declares standard EIP3091, which defines /block/<height>"
        : "registry — the chainlist row declares no url standard, so only the home page is offered",
      source: "ethereum-lists/chains",
    });
  }
  return out;
}

function fromCosmosRegistry(entry, proven) {
  const out = [];
  for (const e of entry.explorers) {
    const base = trimBase(e.url);
    if (!base.startsWith("https://")) continue;

    // The registry's own block_page, when it has one.
    let block = convertRegistryTemplate(e.block_page);
    if (block && !sameHostHttps(block, base)) block = null;
    let verified = block
      ? "registry — cosmos/chain-registry supplies this block page"
      : null;

    // Otherwise the shape this same host proved on another chain, if any.
    if (!block) {
      const tail = proven.get(hostOf(base));
      if (tail) {
        block = base + tail;
        verified = `inherited — cosmos/chain-registry proves ${hostOf(base)} serves ${tail} on another chain; this is the same host`;
      }
    }
    if (!block) {
      verified = "registry — the registry row supplies no block page and this host proved none elsewhere, so only the home page is offered";
    }

    const kind = kindMatching(base, block);
    const row = {
      name: e.kind ?? hostOf(base),
      url: base,
      kind: block ? (kind ?? "custom") : "home",
      verified,
      source: `cosmos/chain-registry/${entry.dir}`,
    };
    if (block && !kind) row.tpl = { block };
    out.push(row);
  }
  // Mintscan is the de-facto canonical cosmos explorer; when the registry
  // lists it, it leads.
  out.sort((a, b) => (b.name === "mintscan" ? 1 : 0) - (a.name === "mintscan" ? 1 : 0));
  return out;
}

/* ── main ────────────────────────────────────────────────────────────────── */

const specsDir = process.env.LAVA_SPECS_DIR ?? (await fetchSpecsToDir());
const specs = loadSpecs(specsDir);

/** index → declared chain-id, for the indices that are real chains. */
const chainIds = new Map();
for (const index of Object.keys(CHAIN_MAP)) {
  const spec = specs.get(index);
  const id = spec ? chainIdOf(spec) : null;
  if (id) chainIds.set(index, id);
}

const needEvm = new Set();
const needCosmos = new Set();
for (const [index, id] of chainIds) {
  const family = CHAIN_MAP[index]?.family;
  if (EVM_FAMILIES.has(family) && EVM_CHAIN_ID_RE.test(id)) needEvm.add(String(parseInt(id, 16)));
  else if (family === "cosmos" && !id.startsWith("0x")) needCosmos.add(id);
}

const snapshot = REFRESH
  ? await refreshSnapshot(needEvm, needCosmos)
  : JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));

/** Block shapes the registry proved, host-keyed — see provenBlockShapes. */
const PROVEN = provenBlockShapes(snapshot);

const out = {};
const counts = { overlay: 0, chainlist: 0, cosmos: 0, none: 0 };
const declaredNone = [];

for (const index of Object.keys(CHAIN_MAP).sort()) {
  const id = chainIds.get(index) ?? null;
  const family = CHAIN_MAP[index]?.family;
  const ov = OVERLAY[index];

  // The overlay wins over both registries — it is where a human records the
  // explorer this project considers official, including "there isn't one".
  if (ov?.none) {
    declaredNone.push(index);
    counts.none += 1;
    continue;
  }
  if (ov?.explorers?.length) {
    out[index] = ov.explorers.slice(0, MAX_PER_CHAIN);
    counts.overlay += 1;
    continue;
  }

  let rows = [];
  if (id && EVM_FAMILIES.has(family) && EVM_CHAIN_ID_RE.test(id)) {
    const dec = String(parseInt(id, 16));
    rows = fromChainlist(snapshot.chainlist[dec] ?? []).map((r) => ({ ...r, source: `${r.source}#${dec}` }));
    if (rows.length) counts.chainlist += 1;
  } else if (id && family === "cosmos" && snapshot.cosmos[id]) {
    rows = fromCosmosRegistry(snapshot.cosmos[id], PROVEN);
    if (rows.length) counts.cosmos += 1;
  }

  if (rows.length) out[index] = rows.slice(0, MAX_PER_CHAIN);
  else counts.none += 1;
}

/* Referential + shape integrity, enforced at generate time as well as in the
 * shared unit test: a kind that is not in the table, or a template that leaves
 * its own host, is a bug in this script rather than something to ship. */
const errors = [];
for (const [index, rows] of Object.entries(out)) {
  for (const r of rows) {
    if (r.kind !== "custom" && !KINDS[r.kind]) errors.push(`${index}: unknown kind "${r.kind}"`);
    // Every row states how its shape is known. An entry with no verification
    // status is one nobody can review, which is the thing this file exists to
    // prevent.
    if (!r.verified) errors.push(`${index}: no verification status`);
    if (!r.url.startsWith("https://")) errors.push(`${index}: non-https url ${r.url}`);
    for (const [ref, t] of Object.entries(r.tpl ?? {})) {
      if (ref !== "block") errors.push(`${index}: tpl carries "${ref}" — the catalog links blocks only`);
      if (!sameHostHttps(t, r.url)) errors.push(`${index}: block template leaves ${r.url} → ${t}`);
      if (!t.includes("{block}")) errors.push(`${index}: block template has no {block} placeholder`);
      if (/([^:])\/{2,}/.test(t)) errors.push(`${index}: block template has a doubled slash → ${t}`);
    }
  }
}
if (errors.length) {
  console.error("✗ refusing to write — resolved entries failed validation:");
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

const noExplorer = Object.keys(CHAIN_MAP).filter((i) => !out[i]).sort();
writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);
writeFileSync(NO_EXPLORER_OUT, `${JSON.stringify(noExplorer, null, 2)}\n`);

/* ── summary ─────────────────────────────────────────────────────────────── */
const total = Object.keys(CHAIN_MAP).length;
const withExplorer = Object.keys(out).length;
console.log(
  `explorers       ${withExplorer}/${total} chains (${counts.chainlist} chainlist, ${counts.cosmos} chain-registry, ${counts.overlay} curated)`,
);
const kindCounts = {};
for (const rows of Object.values(out)) kindCounts[rows[0].kind] = (kindCounts[rows[0].kind] ?? 0) + 1;
console.log(
  `link shapes     ${Object.entries(kindCounts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(" ")}`,
);
const withBlock = Object.values(out).filter((r) => r[0].tpl?.block || KINDS[r[0].kind]?.block).length;
const inherited = Object.values(out).filter((r) => r[0].verified.startsWith("inherited")).length;
console.log(
  `block links     ${withBlock}/${Object.keys(out).length} primaries can link a height (${inherited} inherited from the same host on another chain); the rest offer a home page`,
);
const unverified = Object.entries(out).filter(([, rows]) => rows[0].verified.startsWith("unverified"));
console.log(
  `verification    ${Object.values(out).filter((r) => r[0].verified.startsWith("registry")).length} registry-asserted, ` +
    `${Object.values(out).filter((r) => r[0].verified.startsWith("browser") || r[0].verified.startsWith("home probed")).length} checked by hand, ` +
    `${unverified.length} unverified`,
);
if (unverified.length) {
  // These are shapes nobody has watched work. They ship — an honest label
  // beats dropping a link a user wants — but they are named on every run so
  // the next person on a network that can reach them can settle it.
  console.log(`  unverified    ${unverified.map(([i]) => i).join(", ")}`);
  console.log("  → node apps/web/scripts/probe-explorers.mjs --deep, then update `verified`");
}
if (declaredNone.length) {
  console.log(`declared none   ${declaredNone.join(", ")}`);
}
// Name them, not just count them — the same rule the icon roll-call follows.
// A chain with no explorer is a chain whose numbers cannot be checked against
// the public chain from the dashboard.
if (noExplorer.length) {
  const unresolved = noExplorer.filter((i) => !OVERLAY[i]?.none);
  console.log(`  no explorer   ${noExplorer.map((i) => (CHAIN_MAP[i].mainnet ? i : `${i} (testnet)`)).join(", ")}`);
  if (unresolved.length) {
    console.log("  → curate them in apps/web/scripts/data/explorer-overlay.json (probe first:");
    console.log("    node apps/web/scripts/probe-explorers.mjs), or record `none` with a reason");
  }
}
console.log(`output          ${OUT_PATH}`);
console.log(`roll-call       ${NO_EXPLORER_OUT}`);
