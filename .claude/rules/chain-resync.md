# Chain resync (lava-specs → committed catalogs)

Five committed files are **generated from lava-specs**. Never hand-edit them:

| File | Generator | What it drives |
|------|-----------|----------------|
| `packages/shared/src/constants/chain-map.generated.json` | `apps/web/scripts/generate-chain-map.mjs` | chain names, families, icons, mainnet flag |
| `packages/shared/src/constants/chain-explorers.generated.json` | `apps/web/scripts/generate-chain-explorers.mjs` | the block explorer each chain links to |
| `apps/web/scripts/data/no-explorer.generated.json` | (same run as the explorers) | roll-call of chains with no explorer |
| `apps/web/src/components/try-me/chain-methods.generated.json` | `apps/web/scripts/generate-try-me-catalog.mjs` | the Try-it drawer's per-chain method catalog |
| `apps/web/scripts/data/no-runnable-defaults.generated.json` | (same run as the catalog) | roll-call of surfaces with no working default |

`node apps/web/scripts/check-spec-sync.mjs` regenerates all five from the live
repo and fails on any difference. It runs in CI as **Chain catalogs ↔
lava-specs drift**, and soft-skips when GitHub is unreachable.

## The procedure

```bash
git clone https://github.com/Magma-Devs/lava-specs /tmp/lava-specs
export LAVA_SPECS_DIR=/tmp/lava-specs
node apps/web/scripts/generate-chain-map.mjs
node apps/web/scripts/generate-chain-explorers.mjs
node apps/web/scripts/generate-try-me-catalog.mjs
node apps/web/scripts/check-spec-sync.mjs      # must print ✓ for all five
```

Regenerate ALL THREE — the map first, since the explorer catalog is keyed off
it. The chain map alone was gated for a long time, and the method
catalog drifted in both directions behind it: Trusted Smart Chain rendered with
a name and icon while its Try-it drawer fell back to a family guess, and Ronin
kept serving 57 methods for months after its spec was deleted upstream — it had
already left the *gated* map.

## Internal paths are metadata, never part of the identifier

A few specs split one interface across `internal_path` collections — TON's REST
`/v2` + `/v3`, AVAX's jsonrpc `/C/rpc` + `/P` + `/X`. The catalog emits every
one of them, and each command carries its path as `ip`. **Do not splice it into
`m`.** `m` is what a client sends through the router, and the router matches
REST by api name alone (smart-router `matchSpecApiByName`), then dials the
node-url pinned to that name's collection. A prefixed path matches nothing:

```console
$ curl -s localhost:3460/getMasterchainInfo | head -c 48
{"ok":true,"result":{"@type":"blocks.masterchainInfo"…
$ curl -s localhost:3460/v2/getMasterchainInfo
{"code":12,"message":"Not Implemented","details":[]}
```

This was shipped and reverted once (0.18.3 → 0.18.4). The reasoning that led
there — "the router owns internal-path routing, so send it the path" — is true
of the *routing* and false of the *request*. `ip` is what the direct-to-upstream
leg needs instead; see `docs/UPSTREAM-DIRECT-TEST.md` → "Internal paths".

Curated hints are keyed by the spec's own api name for the same reason: a
prefixed hint table silently stops matching, which is how TON lost every
description and example it had.

## Explorers — a new chain arrives without one

Same failure shape as the icons, one step further out: a chain with no explorer
renders perfectly well, and nothing on the dashboard can be checked against the
public chain. `generate-chain-explorers.mjs` names them, and the roll-call file
is committed so the gap is a reviewed decision rather than an accident.

1. **Read the generator's tail.** It prints the coverage, then every chain with
   no explorer, then every chain whose link shape nobody has verified:

   ```
   explorers       213/245 chains (92 chainlist, 36 chain-registry, 85 curated)
   block links     145/213 primaries can link a height (16 inherited)
   verification    112 registry-asserted, 63 checked by hand, 18 unverified
   declared none   AGRT, ALEOT, CANTON, …
   ```

2. **A new chain in a covered family usually needs nothing.** An EVM chain
   whose spec declares a `chain-id` verification is resolved straight out of
   chainlist, and a cosmos chain out of chain-registry — but only if the
   committed registry snapshot has that chain id, which it will not for a
   brand-new one. Re-fetch:

   ```bash
   node apps/web/scripts/generate-chain-explorers.mjs --refresh
   ```

3. **Read the chain-id name mismatches.** The generator prints every case where
   the chainlist row's name does not resemble the spec's. Most are aliases
   (BSC/BNB, Mordor/ETC testnet). Some are collisions, and a collision hands a
   chain another chain's explorer — Astar Shibuya wore Japan Open Chain's, and
   Hyperliquid wore Wanchain Testnet's, until the overlay corrected both.

4. **Start from the chain's own docs, not from the registry order.** A
   registry lists whoever registered; a chain's documentation names who it
   considers official. `cosmos/chain-registry` lists eleven Lava explorers, all
   validator-run, and taking the first two gave the dashboard two dead links —
   `explorer.finteh.org/lava` unreachable, and `lava.explorers.guru` bouncing
   to `explorers.guru`, whose catalog does not carry Lava at all.
   [docs.lavanet.xyz/block-explorer](https://docs.lavanet.xyz/block-explorer/)
   was what led to the explorer that actually works. Look for a
   `docs.<chain>` / `<chain>.org/docs` page named "block explorer",
   "explorers" or "tools" before curating anything.

   Treat that page as a lead, not as truth: the same Lava page designates as
   **"official"** the very explorer that has since been retired. Whatever it
   names, open it and watch it render.

5. **Anything else is curated**, in
   `apps/web/scripts/data/explorer-overlay.json`. Open the deep link in a
   browser before you write a `kind` down, and record what you did in
   `verified` — including which source named it. `probe-explorers.mjs` proves
   the host is up and the route exists; it cannot prove the page rendered the
   block you asked for, because most explorers answer 200 for any path under
   their router.

6. **A shape you cannot check is not a shape you invent.** Use `home` and the
   entry offers only the explorer's front page — honest, and still useful. The
   catalog links a block HEIGHT and nothing else, so an explorer whose block
   page is addressed by hash is `home`-only. `explorerBlockUrl()` returning
   null is a supported outcome the UI handles; a link to an empty page is not.
   Watch the page render the height you asked for: a 200 proves nothing, since
   these are single-page apps that answer 200 for any path under their router.

7. **Accepting a gap is allowed**, and is recorded the same way as everything
   else: `"CANTON": { "none": "Canton's network is permissioned — no public
   block explorer" }`. Commit the roll-call file with the entry in it; the diff
   records the decision.

Full reference, including the kind table and the registry snapshot:
[`docs/CHAINS.md`](../../docs/CHAINS.md).

## Icons — a new chain arrives without one

`generate-chain-map.mjs` matches each chain to a local SVG in
`apps/web/public/chains/` and falls back to `default.svg` when there is none.
The fallback renders fine, so nothing breaks and nothing complains: a new chain
just quietly appears without its brand. **Vendoring the icon is part of the
resync, not a follow-up.**

1. **Read the generator's icon line.** It prints the count and then names every
   chain on the fallback:

   ```
   icons           243 matched a local SVG (98 inherited from a mainnet sibling), 2 → default.svg
     no icon       RACE, RACET (testnet)
   ```

2. **Source it the way the existing ones were sourced.**
   [`apps/web/public/chains/README.md`](../../apps/web/public/chains/README.md)
   is the authority and documents the order:
   [`@web3icons`](https://github.com/0xa3k5/web3icons) `networks/mono` for the
   glyph with the circle colour read off that icon's own `background` variant →
   its `tokens/mono/` entry when the network has none (Concordium, VeChain,
   Zcash, Oasis, Hydration, ION) →
   [`cosmos/chain-registry`](https://github.com/cosmos/chain-registry) (Neutron,
   Babylon) → the project's own brand asset, reduced to a silhouette, when
   web3icons has nothing at all (Canton, TSC).
3. **Follow the house style** from that README — 24×24, brand-coloured circle,
   glyph scaled 0.72 and centred, white on dark / `#111` on light. Never invent
   a colour: take it from the source icon's backdrop, or one stop of its
   gradient when the backdrop is a gradient.
4. **Mainnet only is usually enough.** Testnet siblings inherit by base name
   and then by index prefix (`BERAB` → `BERA`), so a testnet with its own brand
   name is covered too — `ARBITRUMS` (Arbitrum Sepolia) has no icon of its own
   and shouldn't. Re-run the generator afterwards and commit the regenerated
   map with the SVG.
5. **Two ways a chain ends up under the wrong mark**, both worth a look on
   every resync:
   - *Borrowing.* `resolveIcon` falls back to the first segment of the name
     slug, so "Ethereum Classic" resolved to `ethereum` and wore another
     chain's logo for as long as nobody checked. A chain whose name starts
     with another chain's name needs its own icon.
   - *A wrong upstream name.* The spec's `name` is what decides mainnet vs
     testnet and therefore what inherits from what — and it can be wrong.
     Arbitrum Nova (chain 42170, a production AnyTrust network) was named
     "Arbitrum Nova Testnet", which filed it under Testnet and folded it into
     Arbitrum One's branding. When the name looks wrong, check
     [ethereum-lists/chains](https://github.com/ethereum-lists/chains) and fix
     it upstream rather than working around it here.
6. **A wordmark is not a dead end.** RACE sat on the fallback for months as
   "wordmark only, illegible at icon size" — but its wordmark draws the four
   letters as ascending columns, and that rhythm survives 24px even though the
   letterforms don't. Look for the structural idea in the mark before giving
   up, and if you do abstract rather than trace, say which in the README.
7. **Leaving one on the fallback is still a decision, not an oversight** — just
   write the reason next to it. Every chain resolves to a vendored SVG today,
   so a new `no icon` line means a chain arrived since the last resync.

## What to check after regenerating — this is the part that needs judgement

The generator classifies every command as **runnable** (what it ships with is
already a complete request), **needs params** (a placeholder, a hint that
documents the argument instead of curating one, or the spec's own
`block_parsing` naming a positional argument), or unknown. The drawer opens on
the runnable ones, so a chain with none opens on a list where nothing works.

1. **Read the generator's tail.** It prints `runnable N commands` and then every
   `(spec × iface)` pair with none. New entries there are the whole point of
   the roll-call file.
2. **A new chain in a known family needs nothing.** Hints are keyed by METHOD
   NAME, not by chain, so a new EVM chain inherits the `eth_*` hints and a new
   Cosmos chain the cosmos ones — TSC arrived with 57 JSON-RPC and 242 REST
   methods and runnable defaults on all four interfaces, with no hand-written
   line.
3. **A new chain FAMILY needs hints**, in `generate-try-me-catalog.mjs`'s hint
   tables (`JSONRPC_HINTS`, `REST_HINTS`, `TENDERMINT_HINTS`, `GRPC_HINTS`).
   Scope them with `only: ["SPECPREFIX"]` when the method name is generic.
4. **Verify before you curate.** A hint with `p` is a claim that the command
   works as-is. Fire it first — at the router if the chain is in
   `dev-config/values.yml`, else at a public endpoint:

   ```bash
   curl -s -X POST http://localhost:3360 -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
   grpcurl -d '{}' fullnode.mainnet.sui.io:443 sui.rpc.v2.LedgerService/GetServiceInfo
   ```

   Params shapes differ per family and the difference is invisible until you
   send: CometBFT wants `{}` and rejects `[]`; XRPL wants `[{}]`; Monero and
   Avalanche-P want `{}`; EVM wants `[]`. If you cannot reach an endpoint, say
   so in the PR rather than implying a check happened.
5. **A method needing an argument stays out.** Use a description (`d` with no
   `p`) to tell the caller what to supply — the generator reads that as "needs
   params" and labels it in the drawer. Never invent a plausible address, hash
   or height to make something look runnable: a baked-in value that 404s later
   is worse than an honest label.
6. **Accepting a gap is allowed.** GraphQL-over-POST surfaces (Mina, Fuel,
   Subgraph) need a query body the console has no field for. Commit the
   roll-call file with the entry in it; the diff records the decision.

## Related

- [`docs/CHAINS.md`](../../docs/CHAINS.md) — the full chain-catalog reference:
  what each generated file holds, how the explorer join key works, the link-shape
  kind table, and the verification statuses.
- [`apps/web/public/chains/README.md`](../../apps/web/public/chains/README.md) —
  icon sources, house style, and the per-icon provenance note each vendored SVG
  carries. Add one when you add an icon.
- `.claude/rules/testing.md` — `chain-methods.test.ts` asserts the head is
  non-empty and placeholder-free for a sample of chains; extend that sample
  when you add a family.
- `CHANGELOG.md` — a resync that adds chains is a user-visible change; the
  Build and Push workflow also refuses a VERSION at or below the latest tag.
