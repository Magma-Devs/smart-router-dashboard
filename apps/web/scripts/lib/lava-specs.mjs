/**
 * Fetch the lava-specs proposal files from GitHub into a directory.
 *
 * Both generators read specs: `generate-chain-map.mjs` fetches them itself,
 * `generate-try-me-catalog.mjs` reads a directory. The drift check needs both
 * to run against the SAME upstream snapshot (and to pay for one fetch, not
 * two), so the download lives here and hands back a directory either can use.
 *
 * `GITHUB_TOKEN` raises the API rate limit; `LAVA_SPECS_REF` picks a ref other
 * than main.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GH_OWNER = "Magma-Devs";
const GH_REPO = "lava-specs";

function headers() {
  const h = { "User-Agent": "srdash-spec-sync", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghFetch(url) {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res;
}

/**
 * Download every `*.json` spec into a fresh temp directory and return its
 * path. Throws on any network/API failure — callers decide whether that is
 * fatal (a generator) or a soft skip (the drift check).
 */
export async function fetchSpecsToDir() {
  const ref = process.env.LAVA_SPECS_REF ?? "main";
  const listUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/?ref=${ref}`;
  const list = await (await ghFetch(listUrl)).json();
  const files = list.filter((f) => f.type === "file" && f.name.endsWith(".json"));
  if (files.length === 0) throw new Error(`no spec files at ${GH_OWNER}/${GH_REPO}@${ref}`);
  const dir = mkdtempSync(path.join(tmpdir(), "lava-specs-"));
  console.log(`fetching ${files.length} spec files from ${GH_OWNER}/${GH_REPO}@${ref} …`);
  for (const f of files) {
    const raw = await (await ghFetch(f.download_url)).text();
    writeFileSync(path.join(dir, f.name), raw);
  }
  return dir;
}
