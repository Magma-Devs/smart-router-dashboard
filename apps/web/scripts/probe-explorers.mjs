/**
 * probe-explorers.mjs — check that every explorer the dashboard is about to
 * link actually answers, and that it is still the site we think it is.
 *
 *   node apps/web/scripts/probe-explorers.mjs           # home page of each
 *   node apps/web/scripts/probe-explorers.mjs --deep    # + one block link
 *
 * WHAT THIS PROVES, precisely:
 *
 *   ✓ the host resolves, serves https, and does not redirect to a DIFFERENT
 *     host (a domain that lapsed and now parks elsewhere is the failure this
 *     catches, and it is silent otherwise)
 *   ✓ with --deep, the block route exists at all
 *
 * WHAT IT DOES NOT PROVE: that a deep link renders the thing you asked for.
 * Most explorers are single-page apps that answer 200 for any path under their
 * router and decide at runtime that the id is unknown. A shape is therefore
 * curated by a human reading the explorer's own URL bar, and this script only
 * guards against the site moving out from under that reading afterwards.
 *
 * AND A THIRD BUCKET, which is the one that makes this script honest: a large
 * minority of explorers sit behind bot management (Cloudflare and friends) and
 * answer 401/403/429 to anything without a real browser's TLS fingerprint and
 * JS. Etherscan, Blockchair, Subscan, beaconcha.in and Cardanoscan all do.
 * Those are reported as CHALLENGED, not failed — a 403 here is the script
 * being turned away, not evidence about the URL. Only a resolvable host that
 * answers 404/5xx, or one that does not resolve at all, is a failure.
 *
 * Not wired into CI — it talks to a few dozen third parties, and their
 * flakiness must never fail an unrelated PR. Run it when curating an entry or
 * during a chain resync; `.claude/rules/chain-resync.md` says when.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const DEEP = process.argv.includes("--deep");
const TIMEOUT_MS = 15000;

const KINDS = JSON.parse(
  readFileSync(path.join(ROOT, "packages/shared/src/constants/explorer-kinds.json"), "utf8"),
);
const EXPLORERS = JSON.parse(
  readFileSync(path.join(ROOT, "packages/shared/src/constants/chain-explorers.generated.json"), "utf8"),
);

/** Distinct explorer urls, with the chains that would link to each. */
const targets = new Map();
for (const [spec, rows] of Object.entries(EXPLORERS)) {
  for (const r of rows) {
    const key = r.url + (r.suffix ?? "");
    if (!targets.has(key)) targets.set(key, { row: r, specs: [] });
    targets.get(key).specs.push(spec);
  }
}

const blockLink = (r) => {
  const tpl = r.tpl?.block ?? KINDS[r.kind]?.block?.replace("{base}", r.url);
  return tpl ? tpl.replace("{block}", "1") + (r.suffix ?? "") : null;
};

async function probe(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // Some explorers reject HEAD outright; GET is what a user's browser sends.
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (srdash explorer probe)" },
    });
    return { status: res.status, finalUrl: res.url };
  } catch (err) {
    return { status: 0, error: err.name === "AbortError" ? `timeout after ${TIMEOUT_MS}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

const hostOf = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
};

const rows = [...targets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`probing ${rows.length} explorers behind ${Object.keys(EXPLORERS).length} chains${DEEP ? " (+ block links)" : ""} …\n`);

/** Bot-management refusals. Inconclusive: the script was turned away before
 *  the URL was ever evaluated. 402/530 are the same story from other CDNs. */
const CHALLENGED = new Set([401, 402, 403, 405, 429, 530]);

const failures = [];
const challenged = [];
const moved = [];
for (const [url, { row, specs }] of rows) {
  const res = await probe(url);
  const label = `${specs[0]}${specs.length > 1 ? ` +${specs.length - 1}` : ""}`;
  if (CHALLENGED.has(res.status)) {
    challenged.push({ url, label, status: res.status });
    console.log(`? ${res.status} ${label.padEnd(18)} ${url}  (bot management — inconclusive)`);
    continue;
  }
  if (res.status === 0 || res.status >= 400) {
    failures.push({ url, label, why: res.error ?? `HTTP ${res.status}` });
    console.log(`✗ ${String(res.status || "ERR").padEnd(3)} ${label.padEnd(18)} ${url}  ${res.error ?? ""}`);
    continue;
  }
  const from = hostOf(url);
  const to = hostOf(res.finalUrl);
  if (from && to && from !== to) {
    moved.push({ url, label, to: res.finalUrl });
    console.log(`⚠ ${res.status} ${label.padEnd(18)} ${url}\n      → redirects off-host to ${res.finalUrl}`);
  } else {
    console.log(`✓ ${res.status} ${label.padEnd(18)} ${url}`);
  }
  if (!DEEP) continue;
  const deep = blockLink(row);
  if (!deep) continue;
  const dres = await probe(deep);
  const ok = (dres.status > 0 && dres.status < 400) || CHALLENGED.has(dres.status);
  console.log(`  ${ok ? "·" : "✗"} ${String(dres.status || "ERR").padEnd(3)} block route      ${deep}`);
  if (!ok) failures.push({ url: deep, label, why: `block route ${dres.error ?? dres.status}` });
}

console.log(
  `\n${rows.length - failures.length - moved.length - challenged.length} ok · ${challenged.length} challenged` +
    ` · ${moved.length} redirect off-host · ${failures.length} failed`,
);
if (challenged.length) {
  console.log("\nchallenged — bot management answered for the site. Nothing is proven either");
  console.log("way; open one in a browser if you are curating or doubting it:");
  for (const c of challenged) console.log(`  ${String(c.status).padEnd(4)} ${c.label.padEnd(18)} ${c.url}`);
}
if (moved.length) {
  console.log("\noff-host redirects — confirm the destination is the same explorer, then");
  console.log("update the url in apps/web/scripts/data/explorer-overlay.json:");
  for (const m of moved) console.log(`  ${m.label.padEnd(18)} ${m.url} → ${m.to}`);
}
if (failures.length) {
  console.log("\nfailed — fix the url, or record the chain as `none` with a reason:");
  for (const f of failures) console.log(`  ${f.label.padEnd(18)} ${f.url}  (${f.why})`);
  process.exit(1);
}
