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
catalog silently fell seven specs behind: the new chains rendered everywhere in
the UI while their Try-it drawers fell back to a family guess.

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
   Cosmos chain the cosmos ones — CANTON, TSC and POLKADOTASSETHUBP each landed
   with 23–108 runnable commands and no hand-written line.
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

- `.claude/rules/testing.md` — `chain-methods.test.ts` asserts the head is
  non-empty and placeholder-free for a sample of chains; extend that sample
  when you add a family.
- `CHANGELOG.md` — a resync that adds chains is a user-visible change; the
  Build and Push workflow also refuses a VERSION at or below the latest tag.
