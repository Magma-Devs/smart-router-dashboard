---
name: chain-resync
description: "Runbook for a red 'Chain catalogs ↔ lava-specs drift' gate in smart-router-dashboard. Keyed on the exact lines check-spec-sync.mjs prints — new chains, methods changed (base-spec or own), removed, renamed, explorer / roll-call moves — and says precisely what to regenerate, vendor, curate, verify, release and open a PR for. Use when: the Quality Gate fails on spec drift, lava-specs added or changed a chain, 'resync the chains', 'the drift check is red', a new chain needs an icon or explorer, or the docs site needs the new chains."
---

# Chain resync

The gate regenerates five committed files from live lava-specs and fails on
any byte of difference. The fix is always *regenerate, curate what the
generators cannot know, commit*. This runbook is keyed on the lines the gate
prints; read the reasoning in [`.claude/rules/chain-resync.md`](../../rules/chain-resync.md)
when a step asks for judgement.

## 0. Read the gate output first

Open the failing job and find the block under `✗ committed spec artifacts are
OUT OF SYNC`. Each line routes to one section below:

| Gate prints | Meaning | Go to |
|---|---|---|
| `chain-map: new chains (N)` / `chain-methods: new specs (N)` | chains arrived upstream | §2 (icons) → §3 (explorers) → §4 (runnable defaults) |
| `chain-methods: methods changed (N)` + `→ every changed spec is, or imports, X` | one base spec (ETH1, COSMOSSDK50, …) changed | §5 |
| `chain-methods: methods changed (N)` + `→ … changed in its own file` / `no import in common` | specs edited individually | §5 |
| `chain-map: removed (N)` / `chain-methods: removed (N)` | chains left upstream | §6 |
| `chain-map: changed (N)` | name, family, interfaces or mainnet flag moved | §7 |
| `explorers: gained / lost their explorer / explorer changed` | registry snapshot or overlay moved | §3 |
| `no-explorer: NO explorer (N)` | new chains with nothing to link | §3 |
| `no-runnable-defaults: NO runnable default (N)` | a (spec × iface) with no command that runs as-is | §4 |

Whatever the lines say, §1 and §8 always apply.

## 1. Set up (always)

1. **Ticket, then branch.** Open a MAG ticket in the current sprint first; the
   branch is its key, lowercase (`mag-3488`).
2. **Work in a worktree off `origin/main`**, never in a shared checkout:
   ```bash
   git fetch origin && git worktree add <scratch>/wt-resync origin/main --detach
   cd <scratch>/wt-resync && git checkout -b mag-XXXX
   pnpm install --offline --frozen-lockfile && pnpm -r --filter "./packages/**" build
   ```
   Node 24 (`nvm use 24`). Tests read `packages/*/dist`, hence the build.
3. **Check out lava-specs `main` into a scratch dir — from the lava-specs repo.**
   `git worktree add` run inside the *dashboard* repo makes a dashboard
   worktree that happens to be called lava-specs; the generators then read
   3 files and emit an empty catalog. Confirm with `ls <dir>/*.json | wc -l`
   (≈140), not with the directory name.
   ```bash
   (cd ~/projects/lava-specs && git fetch origin && git worktree add <scratch>/lava-specs origin/main --detach)
   export LAVA_SPECS_DIR=<scratch>/lava-specs
   ```
4. **Regenerate, in this order** (the explorer catalog is keyed off the map):
   ```bash
   node apps/web/scripts/generate-chain-map.mjs
   node apps/web/scripts/generate-chain-explorers.mjs
   node apps/web/scripts/generate-try-me-catalog.mjs
   node apps/web/scripts/check-spec-sync.mjs      # must print ✓ for all five
   ```
   The check compares the regenerated output against the *working tree*, so
   it is green as soon as you have regenerated — that proves consistency, not
   that the curation below is done. Keep the generators' tails; every section
   below reads from them.
5. **Diff against `HEAD`, not against your working tree**, when you want to
   know what changed: `git diff --stat` plus a key diff of each JSON.

## 2. New chains — icons

The map generator prints `icons … N → default.svg` and names each chain under
`no icon`. The fallback renders fine, so nothing else will tell you.

1. **Testnets inherit**, by base name and then by index prefix (`AVTT` → `AVT`).
   Vendor mainnets only. A testnet with its own brand ("Bepolia", "Shibuya") is
   covered by its mainnet's icon and must not get its own.
2. **Source in the README's order**
   ([`apps/web/public/chains/README.md`](../../../apps/web/public/chains/README.md)):
   web3icons `networks/mono` → `tokens/mono` when the network has no entry →
   `cosmos/chain-registry` → polkadot-js/apps `ui/logos/nodes` for Substrate
   chains web3icons lacks → the project's own mark reduced to a silhouette.
   List the repo with the git-trees API, not the contents API — the contents
   listing caps at 1000 entries and silently omits the rest:
   ```bash
   gh api "repos/0xa3k5/web3icons/git/trees/main?recursive=1" --jq '.tree[].path' | grep -i '<name>'
   curl -s https://raw.githubusercontent.com/0xa3k5/web3icons/main/raw-svgs/networks/mono/<slug>.svg
   curl -s https://raw.githubusercontent.com/0xa3k5/web3icons/main/raw-svgs/networks/background/<slug>.svg
   ```
3. **Colour comes from the source, never invented.** Circle = the
   `background` variant's backdrop; a gradient backdrop → one of its own stops
   (say which). Glyph = white on a dark circle, `#111` on a light one. The
   line sits near a white-contrast ratio of 2.5: `#01C853` (2.2) took `#111`,
   `#4DA2FF` (2.65) and `#03A2E5` (2.9) took white. Compute it rather than
   eyeballing: relative luminance L → `1.05 / (L + 0.05)`.
4. **House template**, 24×24, glyph scaled 0.72 and centred; the slug is what
   `resolveIcon` derives from the spec's *name* (`"NeuroWeb Mainnet"` →
   `neuroweb`), read it off the map entry, not off the index:
   ```svg
   <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="12" fill="#BRAND"/><g transform="translate(12 12) scale(0.72) translate(-12 -12)">…glyph…</g></svg>
   ```
   A 100-unit source (polkadot-js) nests a `scale(0.24)` inside the group.
5. **Look at them.** Rasterise a contact sheet and open it — a wordmark that
   is illegible at 24px, a glyph that fills the circle, a wrong colour are all
   visible in one glance and invisible in the SVG text:
   ```bash
   for n in …; do convert -background '#151515' -density 384 apps/web/public/chains/$n.svg -resize 96x96 /tmp/$n.png; done
   convert /tmp/{…}.png -background '#151515' -gravity center -extent 112x112 +append /tmp/icons-sheet.png
   ```
6. **Write the provenance paragraph in the README** (source, colour, why a
   stop or `#111`), re-run the map generator, and confirm `0 → default.svg`.
7. **Two ways a chain wears the wrong mark**, check on every resync: a name
   whose first word is another chain's (`resolveIcon` falls back to the first
   slug segment — "Ethereum Classic" wore Ethereum's), and a testnet whose
   name has no testnet word ("Canary Relaychain") — the generator demotes it
   by index pair before icons are inherited; if a new shape slips past both
   passes, fix the generator, not the data.

## 3. New chains — explorers

The explorer generator prints `explorers N/M`, then `no explorer` and
`unverified`. Every new chain lands on `no explorer` until someone decides.

1. **Re-fetch the registry snapshot first** — a brand-new EVM or Cosmos chain
   is not in the committed snapshot:
   ```bash
   node apps/web/scripts/generate-chain-explorers.mjs --refresh
   ```
   Read what else moved (`git diff` on `chain-explorers.generated.json` keys
   other than the new ones) and list it in the changelog — the refresh
   updates every chain, and a registry row can drop an explorer or point at
   a different network.
2. **Find the deployment.** Subscan runs one host per network and answers
   **404 on every path** for a host it does not serve, so a curl of
   `/block/1000` settles "does it exist" in one call:
   ```bash
   for h in <name> <alt-name>; do curl -s -o /dev/null -w "$h %{http_code}\n" https://$h.subscan.io/block/1000; done
   ```
   Then the chain's own docs page named "explorer" / "tools". Treat it as a
   lead: Acala's docs still name `acala.subscan.io`, which is gone.
   Statescan is `/#/blocks/<n>`; Blockscout is `/block/<n>` and may redirect
   to `/block/<n>/transactions` (same page).
3. **Watch the block page render the height** — a 200 proves nothing for a
   single-page app. Use the Playwright MCP browser:
   `browser_navigate` to `<explorer>/block/1000`, then `browser_find` for
   `Block #1,?000` or read the page title (Subscan titles carry the network:
   "Enjin **Relay** Block Details" vs "Enjin **Matrix** Block Details" — this
   is how a wrong-network link is caught). A project's own explorer may
   namespace paths (Aventus: `/aventus/block/<n>`); open the home page and
   read the URL it redirects to.
4. **Write the overlay entry** in `apps/web/scripts/data/explorer-overlay.json`,
   sorted by key. `kind` is a key of `explorer-kinds.json`; a shape no kind
   spells is `custom` with a `tpl.block`. `verified` says what was *seen*,
   with the date; `source` says who named it and what was rejected:
   ```json
   "LIT": { "explorers": [ { "name": "Statescan", "url": "https://heima.statescan.io",
     "kind": "custom", "tpl": { "block": "https://heima.statescan.io/#/blocks/{block}" },
     "verified": "browser 2026-09-08 — block page watched rendering the requested height (\"Block #1,000\")",
     "source": "curated — Statescan is the explorer Heima's app links to; heima.subscan.io answers 404 as of 2026-09-08" } ] }
   ```
   The overlay wins over the registries, so a chainlist row that is
   home-only can be upgraded to `block` once you have watched it.
5. **Not an explorer:** polkadot.js apps with an `?rpc=` parameter renders a
   height but is an RPC client pointed at someone's node. Record `none` with
   the reason instead. A hash-addressed block page is `home`-only.
6. **Accepting a gap is a decision, written down:**
   `"BSX": { "none": "… as of 2026-09-08" }`. The roll-call file
   (`no-explorer.generated.json`) then carries the index and the diff
   records it.
7. Re-run the explorer generator (without `--refresh`), then the check.

## 4. New chains — runnable defaults

The catalog generator prints `runnable N commands` and then every
`(spec × iface)` with none; `no-runnable-defaults.generated.json` is the
roll-call.

- **A new chain in a known family needs nothing** — hints are keyed by method
  name (`eth_*`, `chain_*`, cosmos REST paths), so it inherits them. Confirm
  the roll-call diff is empty or only names the expected surface.
- **A new family needs hints** in `generate-try-me-catalog.mjs`
  (`JSONRPC_HINTS`, `REST_HINTS`, `TENDERMINT_HINTS`, `GRPC_HINTS`), scoped
  with `only: ["PREFIX"]` when the method name is generic. **Fire every
  hint with `p` before it ships** — at the router if the chain is in
  `dev-config/values.yml`, else at a public endpoint — and say in the PR
  which endpoint answered. Params shapes differ per family (CometBFT `{}`,
  XRPL `[{}]`, EVM `[]`). A method that needs an argument gets `d` only.
- **A GraphQL-over-POST surface is an accepted gap**; commit the roll-call
  with the entry in it.

## 5. `methods changed (N)` — a base spec or a spec moved

Read the attribution line under the per-spec counts:

- **`→ every changed spec is, or imports, ETH1 (ethereum.json) — one
  base-spec change`**: nothing to curate. Regenerate, read the roll-call diff
  (a base spec losing a method can remove a chain's last runnable default),
  and commit. Say in the changelog which base spec moved and by how much
  (`+1 -0 ~0` on every importer).
- **`→ XRT changed in its own file`** or **`no import in common`**: look at
  each `+ - ~` line. Methods *removed* can strand a hint (`only: [...]`)
  that now matches nothing — grep the hint tables for the method names.
  Methods *added* in a known family just inherit hints.
- **An import swapped for an equivalent explicit list does not show up
  here**, by design: the catalog is the resolved surface. If it *does* show
  up, the inlining was not equivalent (a common miss: the `debug` / `trace`
  add-on collections) — that is a lava-specs bug to report, not a dashboard
  change.

## 6. `removed (N)` — a chain left upstream

1. Regenerate; the entries disappear from the map and catalog.
2. **Delete the icon nobody resolves to any more** — the README's pairing
   rule is one SVG per chain that exists; run the map generator and grep
   `"icon": "<slug>"` before deleting, since another chain may share it.
3. **Delete the overlay entry** for the index (and its `none`).
4. Changelog under *Removed*, naming the upstream commit that dropped it.

## 7. `chain-map: changed (N)` — a rename, a family flip, a testnet flag

- **Name changed** → the icon slug may have changed with it. Re-run the map
  generator: if the chain fell to `default.svg`, rename the SVG (do not
  duplicate it); if it now resolves to *another chain's* icon by first-word
  fallback, vendor its own.
- **Mainnet flag flipped** → check the explorer still belongs to the same
  network (Sonic renumbered its testnets and the curated explorer belonged
  to the other one). If the flag is wrong upstream, fix it in lava-specs.
- **Family changed** → the docs site buckets by the spec's real surface, not
  by this field; note it for §9.

## 8. Ship

1. **CHANGELOG** under `## [Unreleased]`: one *Added* bullet for a resync
   that adds chains (which arrived, what they needed, what was accepted as a
   gap), *Fixed* bullets for anything found on the way, and the closing
   line `N chains, M with an explorer, K primaries linking a height` from
   the generator tails.
2. **Release commit in the same PR**: `VERSION` bump (chains added → minor,
   only fixes → patch), `## [X.Y.Z]` inserted under the kept `## [Unreleased]`,
   commit `chore(release): X.Y.Z`.
3. **Gate locally before pushing**: `pnpm typecheck && pnpm test && pnpm lint`
   (lint fails on errors only; warnings are the baseline).
4. **Push and open the PR** with `--head mag-XXXX --base main`. Body: the
   gate run link, what arrived, an explorer table (chain / host / shape /
   how verified), what was accepted as a gap and why, side effects of a
   `--refresh`, the icon contact sheet (push the PNG to a `mag-XXXX-assets`
   branch and embed its raw URL — the repo is public), and the two ticket
   lines:
   ```
   #Closes MAG-XXXX

   Jira ticket: MAG-XXXX
   ```
5. Comment on the ticket with the PR URL and branch. Expect a fast merge —
   do everything above *before* opening, not after.

## 9. Docs-site follow-up (Magma-Devs/docs)

The public Supported chains explorer is a separate, hand-maintained catalog.
After the dashboard PR: one card per new lava-specs *file* in
`docs/javascripts/chains-data.js` (appended at the end of its ecosystem group),
an SVG per card id under `docs/assets/chains/` byte-identical to the
dashboard's, and the counts in `reference/chains/index.md` (front matter and
prose) and `llms.txt` (three mentions). Bucket by the spec's own surface:
`eth_*` on the base collection or an `ETH1` import → EVM; only `chain_*` /
`state_*` / `system_*` → L1, like Polkadot. Before opening that PR:
`node --check docs/javascripts/chains-data.js`, load it to count rows,
`mkdocs build --strict`, and open the built chains page in the browser — the
strict build does not parse JavaScript.

## Traps, dated

- 2026-09-08 — `git worktree add` for lava-specs run from the dashboard repo
  produced an empty catalog with no error; the generators read 3 files.
- 2026-09-08 — `enjin.subscan.io` is the Relay chain; the Matrixchain is
  `matrix.subscan.io`. The overlay had them crossed for a month.
- 2026-09-08 — "Canary Relaychain" (ENJT) stayed on the fallback icon
  because the testnet demotion ran after icon inheritance; fixed in the
  generator (demotion now runs first).
- 2026-09-08 — `--refresh` also moved Berachain, Bepolia and Celestia;
  list every non-new key that changed.
- 2026-09-08 — docs #43 shipped `]];` at the end of chains-data.js; strict
  mkdocs did not notice, Cloudflare cached it, the fix was invisible for
  hours. Verify the page in a browser before the PR.
