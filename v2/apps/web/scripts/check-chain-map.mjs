/**
 * check-chain-map.mjs — CI spec-drift guard.
 *
 * Regenerates the chain map from the LIVE Magma-Devs/lava-specs repo into a
 * temp file and diffs it against the committed
 * packages/shared/src/constants/chain-map.generated.json. Exits non-zero (with
 * a readable diff) when they differ — i.e. lava-specs added a chain, renamed
 * one, or changed its served interfaces and the dashboard's map is stale.
 *
 * The fix is always the same: `node apps/web/scripts/generate-chain-map.mjs`
 * and commit the result (also re-run generate-try-me-catalog.mjs if new chains
 * appeared, so the method catalog covers them).
 *
 *   node apps/web/scripts/check-chain-map.mjs
 *
 * Uses GITHUB_TOKEN when set (CI passes the workflow token) for a higher rate
 * limit. A network/API failure is reported as a soft skip (exit 0) so upstream
 * flakiness never blocks a merge — only a real, confirmed drift fails.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEN = path.resolve(__dirname, "generate-chain-map.mjs");
const COMMITTED = path.resolve(
  __dirname,
  "../../../packages/shared/src/constants/chain-map.generated.json",
);

const tmp = mkdtempSync(path.join(tmpdir(), "chain-map-check-"));
const fresh = path.join(tmp, "chain-map.generated.json");

try {
  try {
    execFileSync("node", [GEN], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, CHAIN_MAP_OUT: fresh },
    });
  } catch (err) {
    // Fetch/generate failed (rate limit, network). Don't block the merge.
    console.log("::warning title=chain-map drift check skipped::could not reach lava-specs — " + err.message);
    process.exit(0);
  }

  const a = readFileSync(COMMITTED, "utf8");
  const b = readFileSync(fresh, "utf8");
  if (a === b) {
    console.log("✓ chain-map.generated.json is in sync with lava-specs");
    process.exit(0);
  }

  // Report which indices changed so the failure is actionable.
  const committed = JSON.parse(a);
  const upstream = JSON.parse(b);
  const added = Object.keys(upstream).filter((k) => !(k in committed));
  const removed = Object.keys(committed).filter((k) => !(k in upstream));
  const changed = Object.keys(upstream).filter(
    (k) => k in committed && JSON.stringify(committed[k]) !== JSON.stringify(upstream[k]),
  );

  console.error("✗ chain-map.generated.json is OUT OF SYNC with lava-specs\n");
  if (added.length) console.error(`  new chains (${added.length}): ${added.join(", ")}`);
  if (removed.length) console.error(`  removed (${removed.length}): ${removed.join(", ")}`);
  if (changed.length) console.error(`  changed (${changed.length}): ${changed.join(", ")}`);
  console.error(
    "\n  Fix: node apps/web/scripts/generate-chain-map.mjs" +
      "\n       (and generate-try-me-catalog.mjs if chains were added)" +
      "\n       then commit the regenerated files.",
  );
  console.error(
    "::error title=chain-map drift::lava-specs changed; regenerate chain-map.generated.json",
  );
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
