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
const OUT_PATH = path.resolve(
  __dirname,
  "../../../packages/shared/src/constants/chain-map.generated.json",
);

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

const TESTNET_RE = /\b(testnet|sepolia|holesky|hoodi|devnet|preprod|shasta|shadownet|alfajores|amoy|blaze|arabica|mocha|artio|bartio|se)\b/i;

function displayName(rawName, index) {
  if (typeof rawName !== "string" || !rawName.trim()) return index;
  return rawName.replace(/\s+mainnet$/i, "").trim() || rawName.trim();
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
 * Derive a chain-type family from the spec when v1 doesn't cover it.
 * Uses the served interfaces + a few index heuristics. Conservative: the
 * family only drives the try-me method fallback + grouping, and an unknown
 * chain still renders fine (name + icon + real per-spec methods).
 */
function deriveFamily(index, interfaces, imports) {
  const has = (i) => interfaces.includes(i);
  const imp = (imports ?? []).map((s) => s.toUpperCase());
  const impHas = (p) => imp.some((s) => s.includes(p));

  if (has("tendermintrpc") || has("grpc") || impHas("COSMOS") || impHas("TENDERMINT") || impHas("IBC")) {
    return "cosmos";
  }
  if (index.startsWith("SOLANA")) return "solana";
  if (index.startsWith("NEAR")) return "near";
  if (index.startsWith("STRK")) return "starknet";
  if (index.startsWith("BTC") || index.startsWith("LTC") || index.startsWith("DOGE") || index.startsWith("BCH")) {
    return "bitcoin";
  }
  if (index.startsWith("APT")) return "aptos";
  if (index.startsWith("SUI")) return "aptos";
  if (index.startsWith("XRP")) return "xrp";
  if (index.startsWith("XLM")) return "xlm";
  if (index.startsWith("TRX")) return "tron";
  if (index.startsWith("TON")) return "ton";
  if (index.startsWith("HEDERA")) return "hedera";
  if (index.startsWith("CARDANO")) return "cardano";
  if (index.startsWith("CASPER")) return "casper";
  if (index.startsWith("TEZOS")) return "tezos";
  if (index.startsWith("IOTA")) return "iota";
  if (index.startsWith("POLKADOT") || index.startsWith("WESTEND")) return "polkadotassethub";
  // jsonrpc-only, no cosmos markers → assume EVM (the largest family).
  if (has("jsonrpc")) return "evm";
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

const out = {};
let derived = 0;
let overlaid = 0;
let defaultIcon = 0;

for (const { json } of specFiles) {
  const specs = json?.proposal?.specs ?? [];
  for (const spec of specs) {
    const index = spec.index;
    if (!index || out[index]) continue;

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

// Deterministic key order for a diff-clean file.
const sorted = {};
for (const k of Object.keys(out).sort()) sorted[k] = out[k];
writeFileSync(OUT_PATH, `${JSON.stringify(sorted, null, 2)}\n`);

/* ── summary ─────────────────────────────────────────────────────────────── */
const total = Object.keys(sorted).length;
console.log(`chains          ${total} (${overlaid} from v1 overlay, ${derived} derived)`);
console.log(`icons           ${total - defaultIcon} matched a local SVG (${inherited} inherited from a mainnet sibling), ${defaultIcon} → default.svg`);
const famCounts = {};
for (const v of Object.values(sorted)) famCounts[v.family] = (famCounts[v.family] ?? 0) + 1;
console.log(`families        ${Object.entries(famCounts).map(([f, n]) => `${f}:${n}`).join(" ")}`);
console.log(`output          ${OUT_PATH}`);
