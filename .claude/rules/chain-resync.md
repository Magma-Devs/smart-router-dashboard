# Chain resync (lava-specs → committed catalogs)

Three committed files are **generated from lava-specs**. Never hand-edit them:

| File | Generator | What it drives |
|------|-----------|----------------|
| `packages/shared/src/constants/chain-map.generated.json` | `apps/web/scripts/generate-chain-map.mjs` | chain names, families, icons, mainnet flag |
| `apps/web/src/components/try-me/chain-methods.generated.json` | `apps/web/scripts/generate-try-me-catalog.mjs` | the Try-it drawer's per-chain method catalog |
| `apps/web/scripts/data/no-runnable-defaults.generated.json` | (same run as the catalog) | roll-call of surfaces with no working default |

`node apps/web/scripts/check-spec-sync.mjs` regenerates all three from the live
repo and fails on any difference. It runs in CI as **Chain catalogs ↔
lava-specs drift**, and soft-skips when GitHub is unreachable.

## The procedure

```bash
git clone https://github.com/Magma-Devs/lava-specs /tmp/lava-specs
node apps/web/scripts/generate-chain-map.mjs
LAVA_SPECS_DIR=/tmp/lava-specs node apps/web/scripts/generate-try-me-catalog.mjs
node apps/web/scripts/check-spec-sync.mjs      # must print ✓ for all three
```

Regenerate BOTH. The chain map alone was gated for a long time, and the method
catalog drifted in both directions behind it: Trusted Smart Chain rendered with
a name and icon while its Try-it drawer fell back to a family guess, and Ronin
kept serving 57 methods for months after its spec was deleted upstream — it had
already left the *gated* map.

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
4. **Mainnet only is usually enough — and usually correct.** Testnet siblings
   inherit by base name and then by index prefix (`BERAB` → `BERA`), so a
   testnet with its own brand name is covered too. Vendoring a separate SVG for
   a testnet index is how one chain ends up looking like two: `arbitrum-nova`
   did that until it was removed, because lava-specs models Nova as
   `ARBITRUMN`, a testnet inside `arbitrum.json`. Re-run the generator
   afterwards and commit the regenerated map with the SVG.
   **Watch for silent borrowing in the other direction too.** `resolveIcon`
   falls back to the first segment of the name slug, so "Ethereum Classic"
   resolved to `ethereum` and wore the wrong chain's logo for as long as nobody
   looked. A chain whose name starts with another chain's name needs its own
   icon, not a fallback.
5. **A wordmark is not a dead end.** RACE sat on the fallback for months as
   "wordmark only, illegible at icon size" — but its wordmark draws the four
   letters as ascending columns, and that rhythm survives 24px even though the
   letterforms don't. Look for the structural idea in the mark before giving
   up, and if you do abstract rather than trace, say which in the README.
6. **Leaving one on the fallback is still a decision, not an oversight** — just
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

- [`apps/web/public/chains/README.md`](../../apps/web/public/chains/README.md) —
  icon sources, house style, and the per-icon provenance note each vendored SVG
  carries. Add one when you add an icon.
- `.claude/rules/testing.md` — `chain-methods.test.ts` asserts the head is
  non-empty and placeholder-free for a sample of chains; extend that sample
  when you add a family.
- `CHANGELOG.md` — a resync that adds chains is a user-visible change; the
  Build and Push workflow also refuses a VERSION at or below the latest tag.
