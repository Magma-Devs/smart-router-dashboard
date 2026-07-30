/**
 * generate-chain-map.mjs — build the dashboard's chain metadata map from the
 * Magma-Devs/lava-specs repo, mirroring the v1 chains.ts model.
 *
 * The dashboard only ever knows a chain by its Lava spec INDEX (the `spec`
 * Prometheus label / the values-file `chain-id`, e.g. ETH1, HYPERLIQUID). This
 * script produces one entry per index:
 *
 *   { name, family, icon, interfaces, mainnet }
 *
 *   - name       display name (from the spec's `name`, "Mainnet" trimmed)
 *   - family     chain-type family (evm, cosmos, solana, …) — from the v1
 *                overlay where present, else auto-derived from the spec's
 *                interfaces + imports
 *   - icon       basename of a file in public/chains/ (no extension), matched
 *                to a vendored local SVG; "default" when none matches
 *   - interfaces the api-interfaces the spec actually serves (jsonrpc, rest,
 *                tendermintrpc, grpc)
 *   - mainnet    true unless the name/index marks it a testnet
 *
 * Source of truth = lava-specs on GitHub (fetched at generate time). The v1
 * chains.ts overlay (scripts/data/v1-chain-overlay.json) supplies curated
 * icon-slug + family for the chains it covered; everything else is derived.
 *
 *   node apps/web/scripts/generate-chain-map.mjs
 *   GITHUB_TOKEN=… node …           # higher GitHub rate limit
 *   LAVA_SPECS_DIR=~/projects/lava-specs node …   # read local clone instead
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_PATH = path.resolve(__dirname, "data/v1-chain-overlay.json");
const ICONS_DIR = path.resolve(__dirname, "../public/chains");
// CHAIN_MAP_OUT lets the CI drift check (check-chain-map.mjs) write to a temp
// file instead of overwriting the committed one.
const OUT_PATH =
  process.env.CHAIN_MAP_OUT ??
  path.resolve(__dirname, "../../../packages/shared/src/constants/chain-map.generated.json");

const GH_OWNER = "Magma-Devs";
const GH_REPO = "lava-specs";
const GH_REF = process.env.LAVA_SPECS_REF ?? "main";

/* ── spec loading (GitHub, or a local clone) ─────────────────────────────── */

async function ghFetch(url) {
  const headers = { "User-Agent": "srdash-chain-map", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res;
}

async function loadSpecFilesFromGitHub() {
  const listUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/?ref=${GH_REF}`;
  const list = await (await ghFetch(listUrl)).json();
  const files = list.filter((f) => f.type === "file" && f.name.endsWith(".json"));
  console.log(`fetching ${files.length} spec files from ${GH_OWNER}/${GH_REPO}@${GH_REF} …`);
  const out = [];
  // Sequential-ish batches to stay polite to the raw CDN.
  for (const f of files) {
    const raw = await (await ghFetch(f.download_url)).text();
    out.push({ name: f.name, json: JSON.parse(raw) });
  }
  return out;
}

function loadSpecFilesFromDisk(dir) {
  const files = readdirSync(dir).filter((n) => n.endsWith(".json"));
  console.log(`reading ${files.length} spec files from ${dir} …`);
  return files.map((name) => ({
    name,
    json: JSON.parse(readFileSync(path.join(dir, name), "utf8")),
  }));
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

// `testnet\d*` because Bitcoin's is literally "Testnet4" (a plain \btestnet\b
// misses it — there is no word boundary between the "t" and the "4"), and
// `signet` because Bitcoin's other public test network is named that instead.
const TESTNET_RE = /\b(testnet\d*|signet|sepolia|holesky|hoodi|devnet|preprod|shasta|shadownet|alfajores|amoy|blaze|arabica|mocha|artio|bartio|se)\b/i;

/**
 * Brands whose canonical casing plain capitalization would get wrong. Keyed
 * by the all-lowercase form; only consulted when upstream wrote the word in
 * all-lowercase, so a spec that already cases it deliberately wins.
 */
const WORD_CASE = {
  bob: "BOB",
  dydx: "dYdX",
  race: "RACE",
  thorchain: "THORChain",
  xdc: "XDC",
};

/**
 * Title-case a single word without flattening intentional casing. lava-specs
 * is inconsistent — "Ethereum Mainnet" and "BSC Mainnet" sit next to "akash
 * mainnet" and "dydx testnet" — so names are normalized here rather than
 * trusting upstream. A blanket .toTitleCase() would corrupt the specs that
 * are already right (zkSync → Zksync, MultiversX → Multiversx, BSC → Bsc),
 * hence the word-level rules.
 */
function titleCaseWord(word) {
  const lower = word.toLowerCase();
  // Upstream wrote it lowercase and it's a brand we know the casing for.
  if (word === lower && WORD_CASE[lower]) return WORD_CASE[lower];
  // Any existing capital means the spec cased it on purpose — leave it be.
  if (/[A-Z]/.test(word)) return word;
  // Version / numeric tokens ("v50") must not become "V50".
  if (/^v?\d/.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function displayName(rawName, index) {
  if (typeof rawName !== "string" || !rawName.trim()) return index;
  const trimmed = rawName.replace(/\s+mainnet$/i, "").trim() || rawName.trim();
  return trimmed.split(/\s+/).map(titleCaseWord).join(" ");
}

function isMainnet(name, index) {
  return !TESTNET_RE.test(name) && !TESTNET_RE.test(index);
}

/** Local icon basenames (no extension) available in public/chains/. */
const localIcons = new Set(
  readdirSync(ICONS_DIR)
    .filter((n) => n.endsWith(".svg"))
    .map((n) => n.replace(/\.svg$/, "")),
);

/** Slugify a display name to a candidate icon basename. */
function nameToSlug(name) {
  return name
    .replace(new RegExp(TESTNET_RE.source, "gi"), "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Resolve an icon basename that exists locally, or "default". Tries the v1
 *  curated slug first, then name-derived variants. */
function resolveIcon(index, name, overlaySlug) {
  const tries = [];
  if (overlaySlug) tries.push(overlaySlug);
  const slug = nameToSlug(name);
  tries.push(slug, slug.replace(/-/g, ""), slug.split("-")[0], index.toLowerCase());
  for (const t of tries) {
    if (t && localIcons.has(t)) return t;
  }
  return "default";
}

/**
 * Every spec by index, including `enabled: false` base specs — they are not
 * emitted as chains but a real chain's family often hangs off what it imports.
 * Populated once the spec files are read (see main).
 */
const specsByIndex = new Map();

/** Transitive `imports` closure for a spec index. A testnet usually imports its
 *  mainnet, which in turn imports the base spec, so the useful marker (ETH1,
 *  BTC, SOLANA, COSMOSSDK*) is frequently two hops up. */
function importClosure(index, seen = new Set()) {
  for (const imp of specsByIndex.get(index)?.imports ?? []) {
    const up = String(imp).toUpperCase();
    if (seen.has(up)) continue;
    seen.add(up);
    importClosure(up, seen);
  }
  return seen;
}

/** Every api name a spec serves, following imports. Lets us classify by the
 *  RPC surface actually exposed instead of guessing from the index. */
function methodNames(index, seen = new Set(), out = new Set()) {
  if (seen.has(index)) return out;
  seen.add(index);
  const spec = specsByIndex.get(index);
  if (!spec) return out;
  for (const c of spec.api_collections ?? []) {
    for (const a of c.apis ?? []) if (a.name) out.add(a.name);
  }
  for (const imp of spec.imports ?? []) methodNames(String(imp).toUpperCase(), seen, out);
  return out;
}

/** True when the chain actually answers Ethereum JSON-RPC. This is what makes a
 *  chain "EVM" for our purposes — it is the surface the gateway serves and the
 *  method set the try-me drawer should offer. Note it is not exclusive: Astar,
 *  Moonbeam, Moonriver and Bittensor serve eth_* *and* substrate RPC, and EVM
 *  is the more useful family for them. */
function servesEvm(index) {
  for (const n of methodNames(index)) if (n.startsWith("eth_")) return true;
  return false;
}

/** Substrate/polkadot-SDK nodes all expose the same JSON-RPC surface. Checked
 *  after `servesEvm`, so this only claims chains with no EVM layer at all
 *  (Enjin, Polymesh) rather than the EVM-compatible parachains. */
function isSubstrate(index) {
  const m = methodNames(index);
  return (
    m.has("account_nextIndex") ||
    m.has("author_submitExtrinsic") ||
    m.has("state_getRuntimeVersion") ||
    m.has("chain_getFinalizedHead")
  );
}

/**
 * Derive a chain-type family from the spec when v1 doesn't cover it.
 *
 * Ordered strongest-evidence-first: what the spec *imports* and the RPC surface
 * it actually serves beat any index-name heuristic. `evm` is the last resort
 * and is only reached by a jsonrpc chain that showed no other marker — it used
 * to be a blanket catch-all, which silently labelled every non-EVM chain
 * outside the prefix list (Monero, Stacks, Algorand, Dash, …) as EVM.
 */
function deriveFamily(index, interfaces, imports) {
  const has = (i) => interfaces.includes(i);
  const imp = new Set([...(imports ?? []).map((s) => String(s).toUpperCase()), ...importClosure(index)]);
  const impHas = (p) => [...imp].some((s) => s.includes(p));
  const idx = (...p) => p.some((s) => index.startsWith(s));
  const methods = methodNames(index);
  /** True when the chain serves any of these exact api names. */
  const serves = (...names) => names.some((n) => methods.has(n));
  /** True when any served api name starts with one of these prefixes. */
  const servesPrefix = (...prefixes) =>
    [...methods].some((n) => prefixes.some((p) => n.startsWith(p)));

  // Cosmos first: a cosmos chain with an EVM module (Sei, Kava, Canto) imports
  // ETH1 too, and its cosmos identity is the more useful grouping. gRPC alone
  // is NOT cosmos evidence — Concordium serves its own `concordium.v2.*`
  // service over grpc — so the marker is the cosmos-SDK surface itself
  // (`/cosmos/…` REST paths, `cosmos.*` grpc services) or a cosmos import.
  if (
    has("tendermintrpc") ||
    impHas("COSMOS") ||
    impHas("TENDERMINT") ||
    impHas("IBC") ||
    servesPrefix("/cosmos/", "cosmos.")
  ) {
    return "cosmos";
  }

  // Native L1 API surfaces that ALSO ship an EVM compatibility layer. Same
  // call the cosmos branch above makes for Sei/Kava/Canto: the native identity
  // is the useful grouping, so these are matched before `servesEvm`. Keyed on
  // methods only the native surface has, not on the index name.
  if (serves("/wallet/getnowblock", "/wallet/getnodeinfo")) return "tron";
  if (serves("/v1/chain/get_info", "/v1/chain/get_block_info")) return "eos";
  if (serves("/blocks/{revision}", "/node/network/peers")) return "vechain";
  // TON's HTTP API (toncenter v2 + tonindex v3). Ice Open Network is a TON
  // fork and serves the identical paths, so the surface pairs them.
  if (serves("/v3/runGetMethod", "/v2/sendBoc", "/v3/masterchainInfo")) return "ton";
  if (servesPrefix("concordium.v2.")) return "concordium";

  // Polkadot ecosystem (relay chains + asset hubs) — substrate, but grouped
  // under the pre-existing family the v1 overlay already uses for them.
  if (idx("POLKADOT", "WESTEND", "KUSAMA")) return "polkadotassethub";
  // Serving eth_* is what makes a chain EVM here, and it wins over the
  // substrate check: Astar/Moonbeam/Moonriver/Bittensor speak both.
  if (servesEvm(index)) return "evm";
  // Substrate chains with no EVM layer at all.
  if (isSubstrate(index)) return "substrate";

  // Import-driven: a fork inherits its parent's family (Dash imports BTC,
  // Koii imports SOLANA) even when its index shares no prefix.
  if (imp.has("BTC")) return "bitcoin";
  if (imp.has("SOLANA")) return "solana";

  if (idx("SOLANA")) return "solana";
  if (idx("NEAR")) return "near";
  if (idx("STRK")) return "starknet";
  if (idx("BTC", "LTC", "DOGE", "BCH", "DASH")) return "bitcoin";
  if (idx("APT", "SUI")) return "aptos";
  if (idx("XRP")) return "xrp";
  if (idx("XLM")) return "xlm";
  if (idx("TRX")) return "tron";
  if (idx("TON")) return "ton";
  if (idx("HEDERA")) return "hedera";
  if (idx("CARDANO")) return "cardano";
  if (idx("CASPER")) return "casper";
  if (idx("TEZOS")) return "tezos";
  if (idx("IOTA")) return "iota";
  if (idx("MONERO")) return "monero";
  if (idx("ALEO")) return "aleo";
  if (idx("ALGORAND")) return "algorand";
  if (idx("ARWEAVE")) return "arweave";
  if (idx("MINA")) return "mina";
  if (idx("MULTIVERSX")) return "multiversx";
  if (idx("STACKS")) return "stacks";

  if (imp.has("ETH1") || has("jsonrpc")) return "evm";
  return "evm";
}

/** Collect a spec's served, enabled api-interfaces from api_collections. */
function specInterfaces(spec) {
  const set = new Set();
  for (const c of spec.api_collections ?? []) {
    if (c.enabled === false) continue;
    const iface = c.collection_data?.api_interface;
    if (iface) set.add(iface);
  }
  return [...set];
}

/* ── main ────────────────────────────────────────────────────────────────── */

const overlay = JSON.parse(readFileSync(OVERLAY_PATH, "utf8"));

const specFiles = process.env.LAVA_SPECS_DIR
  ? loadSpecFilesFromDisk(process.env.LAVA_SPECS_DIR)
  : await loadSpecFilesFromGitHub();

// Index every spec — disabled base specs included — before deriving anything,
// so family resolution can walk `imports` and read the inherited RPC surface.
for (const { json } of specFiles) {
  for (const spec of json?.proposal?.specs ?? []) {
    if (spec.index && !specsByIndex.has(spec.index)) specsByIndex.set(spec.index, spec);
  }
}

const out = {};
let derived = 0;
let overlaid = 0;
let defaultIcon = 0;

for (const { json } of specFiles) {
  const specs = json?.proposal?.specs ?? [];
  for (const spec of specs) {
    const index = spec.index;
    if (!index || out[index]) continue;
    // Abstract base specs (IBC, TENDERMINT, COSMOSSDK*, ETHERMINT, …) are
    // `enabled: false` upstream: they exist only to be `imports`-ed by real
    // chains and are never served on their own. Emitting them put them in
    // KNOWN_CHAINS, which backs lists/pickers. Same rule the try-me catalog
    // generator applies.
    if (spec.enabled === false) continue;

    const name = displayName(spec.name, index);
    const interfaces = specInterfaces(spec);
    const ov = overlay[index];

    const family = ov?.family ?? deriveFamily(index, interfaces, spec.imports);
    const icon = resolveIcon(index, name, ov?.icon);
    if (ov) overlaid += 1;
    else derived += 1;
    if (icon === "default") defaultIcon += 1;

    out[index] = {
      name,
      family,
      icon,
      // Prefer the interfaces the spec actually declares; fall back to v1's
      // curated list only when the spec yielded none (abstract/base specs).
      interfaces: interfaces.length ? interfaces : (ov?.interfaces ?? []),
      mainnet: isMainnet(name, index),
    };
  }
}

// Second pass: a testnet whose icon fell to "default" inherits its mainnet
// sibling's icon. Chains are grouped by base name (name minus the testnet
// qualifier) — "Dogecoin Testnet" and "Dogecoin" share base "dogecoin", so
// DOGET picks up doge.svg from DOGE even though its own slug didn't match.
const byBase = new Map();
for (const [index, e] of Object.entries(out)) {
  const base = nameToSlug(e.name); // testnet words already stripped by nameToSlug
  if (!byBase.has(base)) byBase.set(base, []);
  byBase.get(base).push(index);
}
let inherited = 0;
for (const indices of byBase.values()) {
  const donor = indices.find((i) => out[i].icon !== "default");
  if (!donor) continue;
  for (const i of indices) {
    if (out[i].icon === "default") {
      out[i].icon = out[donor].icon;
      inherited += 1;
      defaultIcon -= 1;
    }
  }
}

// Third pass: a testnet that is *branded* differently from its mainnet still
// belongs to it — Astar's testnet is "Shibuya", Polkadot's is "Westend",
// Berachain's is "Bepolia" — so grouping by name can't pair them. The spec
// index does: a testnet index is its mainnet's index plus a suffix ("T" for
// most, "B" for BERAB, "4" for BTCT4), so the longest index prefix that is
// itself a known chain is the donor. Only fills gaps, and only from a parent
// that actually exists, so it can never override a real match.
for (const [index, e] of Object.entries(out)) {
  if (e.icon !== "default" || e.mainnet) continue;
  // Stop at 3 chars: shorter prefixes pair unrelated chains by accident.
  for (let cut = index.length - 1; cut >= 3; cut -= 1) {
    const parent = out[index.slice(0, cut)];
    if (!parent || parent.icon === "default") continue;
    e.icon = parent.icon;
    inherited += 1;
    defaultIcon -= 1;
    break;
  }
}

// Fourth pass: an index that is its mainnet's index plus a trailing "T" is a
// testnet even when neither the name nor the index says so — Enjin's "Canary
// Matrixchain" (ENJINT ← ENJIN) is the case that needs it. Same index pairing
// the icon pass above uses, and it only ever flips true → false.
let demoted = 0;
for (const [index, e] of Object.entries(out)) {
  if (!e.mainnet || !index.endsWith("T") || !out[index.slice(0, -1)]) continue;
  e.mainnet = false;
  demoted += 1;
}

// Deterministic key order for a diff-clean file.
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
writeFileSync(OUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

/* ── summary ─────────────────────────────────────────────────────────────── */
const total = Object.keys(sorted).length;
console.log(`chains          ${total} (${overlaid} from v1 overlay, ${derived} derived)`);
console.log(`icons           ${total - defaultIcon} matched a local SVG (${inherited} inherited from a mainnet sibling), ${defaultIcon} → default.svg`);
const mainnets = Object.values(sorted).filter((v) => v.mainnet).length;
console.log(`networks        ${mainnets} mainnet, ${total - mainnets} testnet (${demoted} demoted by the index-pair rule)`);
const famCounts = {};
for (const v of Object.values(sorted)) famCounts[v.family] = (famCounts[v.family] ?? 0) + 1;
console.log(`families        ${Object.entries(famCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f, n]) => `${f}:${n}`).join(" ")}`);
console.log(`output          ${OUT_PATH}`);
