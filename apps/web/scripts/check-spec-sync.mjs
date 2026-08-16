/**
 * check-spec-sync.mjs — CI spec-drift guard.
 *
 * Downloads the LIVE Magma-Devs/lava-specs repo once, regenerates all three
 * committed artifacts from it into a temp dir, and diffs each against what is
 * in the tree:
 *
 *   packages/shared/src/constants/chain-map.generated.json   names, families, icons
 *   apps/web/src/components/try-me/chain-methods.generated.json   method catalog
 *   apps/web/scripts/data/no-runnable-defaults.generated.json     coverage roll-call
 *
 * Any difference fails the build — upstream added a chain, renamed one, changed
 * its interfaces or its methods, and the dashboard is stale. The third file is
 * the one that catches a subtler regression: a new chain whose methods all need
 * caller input, so the Try-it drawer has no working default to open on.
 *
 * The fix is always regenerate + commit; `.claude/rules/chain-resync.md` has
 * the full procedure, including what to do about a chain with no runnable
 * defaults.
 *
 *   node apps/web/scripts/check-spec-sync.mjs
 *
 * `GITHUB_TOKEN` raises the API rate limit (CI passes the workflow token). A
 * network/API failure is a soft skip (exit 0) so upstream flakiness never
 * blocks a merge — only a real, confirmed drift fails.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSpecsToDir } from "./lib/lava-specs.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, "..");
const ROOT = path.resolve(WEB, "../..");

/** Each artifact: how to regenerate it, and where the committed copy lives. */
const ARTIFACTS = [
  {
    label: "chain-map.generated.json",
    script: path.join(__dirname, "generate-chain-map.mjs"),
    outEnv: "CHAIN_MAP_OUT",
    committed: path.join(ROOT, "packages/shared/src/constants/chain-map.generated.json"),
    fix: "node apps/web/scripts/generate-chain-map.mjs",
    // Chain-keyed object — report which indices moved.
    summarize: (before, after) => {
      const a = JSON.parse(before);
      const b = JSON.parse(after);
      const added = Object.keys(b).filter((k) => !(k in a));
      const removed = Object.keys(a).filter((k) => !(k in b));
      const changed = Object.keys(b).filter(
        (k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
      );
      return [
        added.length ? `  new chains (${added.length}): ${added.join(", ")}` : "",
        removed.length ? `  removed (${removed.length}): ${removed.join(", ")}` : "",
        changed.length ? `  changed (${changed.length}): ${changed.join(", ")}` : "",
      ].filter(Boolean);
    },
  },
  {
    label: "chain-methods.generated.json",
    script: path.join(__dirname, "generate-try-me-catalog.mjs"),
    outEnv: "TRY_ME_OUT",
    committed: path.join(WEB, "src/components/try-me/chain-methods.generated.json"),
    fix: "LAVA_SPECS_DIR=<clone> node apps/web/scripts/generate-try-me-catalog.mjs",
    summarize: (before, after) => {
      const a = JSON.parse(before);
      const b = JSON.parse(after);
      const added = Object.keys(b).filter((k) => !(k in a));
      const removed = Object.keys(a).filter((k) => !(k in b));
      const changed = Object.keys(b).filter(
        (k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]),
      );
      return [
        added.length ? `  new specs (${added.length}): ${added.join(", ")}` : "",
        removed.length ? `  removed (${removed.length}): ${removed.join(", ")}` : "",
        changed.length ? `  methods changed (${changed.length}): ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? " …" : ""}` : "",
      ].filter(Boolean);
    },
  },
  {
    label: "no-runnable-defaults.generated.json",
    // Written by the same run as the catalog above; regenerated with it.
    script: null,
    outEnv: "NO_RUNNABLE_OUT",
    committed: path.join(WEB, "scripts/data/no-runnable-defaults.generated.json"),
    fix: "regenerated with the try-me catalog",
    summarize: (before, after) => {
      const a = new Set(JSON.parse(before));
      const b = new Set(JSON.parse(after));
      const gained = [...b].filter((k) => !a.has(k));
      const fixed = [...a].filter((k) => !b.has(k));
      return [
        gained.length
          ? `  NO runnable default (${gained.length}): ${gained.join(", ")}\n` +
            "    → the Try-it drawer opens these on a list where nothing can be\n" +
            "      sent as-is. Curate hints for them (see the rule below) or\n" +
            "      commit this file to accept the gap deliberately."
          : "",
        fixed.length ? `  now covered (${fixed.length}): ${fixed.join(", ")}` : "",
      ].filter(Boolean);
    },
  },
];

const tmp = mkdtempSync(path.join(tmpdir(), "spec-sync-"));
let specsDir;

try {
  try {
    specsDir = process.env.LAVA_SPECS_DIR ?? (await fetchSpecsToDir());
  } catch (err) {
    // Fetch failed (rate limit, network). Don't block the merge.
    console.log(`::warning title=spec drift check skipped::could not reach lava-specs — ${err.message}`);
    process.exit(0);
  }

  const fresh = Object.fromEntries(
    ARTIFACTS.map((a) => [a.label, path.join(tmp, a.label)]),
  );
  const env = {
    ...process.env,
    LAVA_SPECS_DIR: specsDir,
    ...Object.fromEntries(ARTIFACTS.map((a) => [a.outEnv, fresh[a.label]])),
  };

  for (const artifact of ARTIFACTS) {
    if (!artifact.script) continue;
    try {
      execFileSync("node", [artifact.script], { stdio: ["ignore", "ignore", "inherit"], env });
    } catch (err) {
      console.log(`::warning title=spec drift check skipped::${artifact.label} could not be regenerated — ${err.message}`);
      process.exit(0);
    }
  }

  const stale = [];
  for (const artifact of ARTIFACTS) {
    const committed = readFileSync(artifact.committed, "utf8");
    const regenerated = readFileSync(fresh[artifact.label], "utf8");
    if (committed === regenerated) {
      console.log(`✓ ${artifact.label} is in sync with lava-specs`);
      continue;
    }
    stale.push({ artifact, committed, regenerated });
  }

  if (stale.length === 0) process.exit(0);

  console.error("\n✗ committed spec artifacts are OUT OF SYNC with lava-specs\n");
  for (const { artifact, committed, regenerated } of stale) {
    console.error(`${artifact.label}:`);
    for (const line of artifact.summarize(committed, regenerated)) console.error(line);
    console.error("");
  }
  console.error(
    "  Fix: clone Magma-Devs/lava-specs, then\n" +
      "       node apps/web/scripts/generate-chain-map.mjs\n" +
      "       LAVA_SPECS_DIR=<clone> node apps/web/scripts/generate-try-me-catalog.mjs\n" +
      "       and commit the regenerated files.\n" +
      "       Procedure and what to check afterwards: .claude/rules/chain-resync.md",
  );
  console.error("::error title=spec drift::lava-specs changed; regenerate the committed catalogs");
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
  if (specsDir && specsDir !== process.env.LAVA_SPECS_DIR) {
    rmSync(specsDir, { recursive: true, force: true });
  }
}
