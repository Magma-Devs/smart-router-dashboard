# Chain catalogs — what the dashboard knows about a chain

The dashboard only ever knows a chain by its **Lava spec index** — the `spec`
Prometheus label, the values-file `chain-id`: `ETH1`, `COSMOSHUB`,
`HYPERLIQUID`. Everything a human sees about that chain is resolved from
generated catalogs keyed by that index.

| Catalog | File | Accessor |
|---|---|---|
| Name, family, icon, interfaces, mainnet flag | `packages/shared/src/constants/chain-map.generated.json` | `buildChainMetaByIndex(spec)` |
| Block explorers | `packages/shared/src/constants/chain-explorers.generated.json` | `explorersFor(spec)`, `explorerUrl(spec, ref, value)` |
| Try-it method catalog | `apps/web/src/components/try-me/chain-methods.generated.json` | the Try-it drawer |

All are generated from [Magma-Devs/lava-specs](https://github.com/Magma-Devs/lava-specs)
and gated in CI by `apps/web/scripts/check-spec-sync.mjs`. Never hand-edit
them. The procedure for regenerating lives in
[`.claude/rules/chain-resync.md`](../.claude/rules/chain-resync.md).

## Explorers

Every number the dashboard renders for a chain — a latest block, a tip lag, a
hash in a Try-it response — is a claim about a public chain. The explorer map
is what lets a reader check that claim at the source, which is the difference
between a dashboard you believe and one you verify.

### The join key

Each spec declares a `chain-id` **verification** — `ETH1` → `0x1`,
`COSMOSHUB` → `cosmoshub-4`. That is the key into two public registries, so
most of the catalog is derived rather than hand-written:

| Source | Chains | How |
|---|---|---|
| [`ethereum-lists/chains`](https://chainid.network/chains.json) | 92 | hex chain-id → decimal → the row's `explorers[]`, with `standard: EIP3091` carrying the link shape |
| [`cosmos/chain-registry`](https://github.com/cosmos/chain-registry) | 38 | string chain-id matched against every `chain.json`; the registry supplies `block_page` / `tx_page` / `account_page` templates outright |
| `apps/web/scripts/data/explorer-overlay.json` | 80 | curated by hand — bitcoin, solana, move, substrate, ledger-sequence and everything else neither registry covers, plus overrides |

> **A hex chain-id is not an EVM chain id.** Starknet's `0x534e5f4d41494e` is
> ASCII `SN_MAIN`; the Polkadot, Kusama, substrate and VeChain values are
> 32-byte genesis hashes. The chainlist lookup is gated on both the family and
> the hex width for that reason.
>
> **And a chain id is not unique in the wild.** Chainlist has collisions:
> Astar Shibuya and Japan Open Chain both claim 81, Hyperliquid and Wanchain
> Testnet both claim 999. The generator prints every case where the row's name
> does not resemble the spec's, and the overlay carries the correction. Read
> that list on every regeneration — it is how a chain ends up wearing another
> chain's explorer.

### Link shapes are a table, not 750 strings

An entry stores a **kind** — a key in
`packages/shared/src/constants/explorer-kinds.json` — rather than its own copy
of three URL templates. `{base}` is the entry's own url:

```json
"eip3091": { "block": "{base}/block/{block}", "tx": "{base}/tx/{tx}", "address": "{base}/address/{address}" }
```

Eleven kinds cover 210 chains, and each one is auditable in a single read.
Two rules keep them honest:

1. **A kind's `block` template takes a block HEIGHT.** Explorers whose block
   page is addressed by hash (NearBlocks, MultiversX, cspr.live) ship no block
   template at all — they carry an explicit `tpl` with just the refs they can
   serve, or they are `home`-only. The dashboard has a height, so a
   hash-addressed block page is not a link it can build.
2. **A kind is assigned only when something proves the shape** — the
   registry's own template string matching it exactly, or a human watching the
   page render. Otherwise the entry is `home`.

`explorerUrl()` returns **null**, never a guess, for a ref with no template. A
caller that gets null must render plain text; falling back to the home page
would quietly send the reader somewhere that does not answer their question.

### Every row says how it is known

Each explorer carries a `verified` field, and nothing ships without one:

| Value | Meaning |
|---|---|
| `registry — …` | the registry asserted the shape (chainlist's `EIP3091`, or chain-registry's own page templates) |
| `browser 2026-08-17 — …` | a person opened the deep link and watched it render the value asked for |
| `home probed …` | a `home`-only entry whose home page answered — which is the entire claim it makes |
| `unverified — …` | curated from knowledge, with the reason it could not be checked (bot challenge, unreachable host) |

`unverified` rows still ship. A link a user wants, labelled honestly, beats no
link — but they are named on every generator run so the next person on a
network that can reach them can settle it. As of the last refresh, 22 of 210
are unverified, most behind Cloudflare bot management (Blockchair, Cardanoscan,
beaconcha.in, Tronscan, viewblock) which answers 403 to anything without a
real browser's TLS fingerprint.

### Chains with no explorer

35 spec indices have none, and each is a recorded decision in the overlay with
a reason — a permissioned network with no public explorer (Canton), an API
surface that is not a chain (Moralis, Subsquid Subgraph), a retired testnet, or
simply nothing verified. They are listed in
`apps/web/scripts/data/no-explorer.generated.json`, which CI gates like the
other catalogs, so a chain silently arriving without one fails the build rather
than passing unnoticed.

## Regenerating

```bash
git clone https://github.com/Magma-Devs/lava-specs /tmp/lava-specs
export LAVA_SPECS_DIR=/tmp/lava-specs

node apps/web/scripts/generate-chain-map.mjs           # names, families, icons
node apps/web/scripts/generate-chain-explorers.mjs     # explorers (committed snapshot)
node apps/web/scripts/generate-try-me-catalog.mjs      # method catalog
node apps/web/scripts/check-spec-sync.mjs              # must print ✓ for all five
```

The explorer generator reads a **committed snapshot** of the two registries
(`apps/web/scripts/data/explorer-registry.snapshot.json`), so a regeneration
depends only on lava-specs plus files in the tree — a third party editing an
explorer url can never fail an unrelated PR. Re-fetching the registries is a
deliberate act:

```bash
node apps/web/scripts/generate-chain-explorers.mjs --refresh   # ~450 registry reads
node apps/web/scripts/probe-explorers.mjs                      # are they all still up?
node apps/web/scripts/probe-explorers.mjs --deep               # + block routes
```

### Adding or correcting an explorer

Edit `apps/web/scripts/data/explorer-overlay.json` — it wins over both
registries — and regenerate. An entry is either explorers or a refusal:

```jsonc
"SOLANA": {
  "explorers": [{
    "name": "Solana Explorer",
    "url": "https://explorer.solana.com",     // no trailing slash, https
    "kind": "eip3091",                        // or "custom" with an explicit tpl
    "suffix": "?cluster=devnet",              // optional, applied to every url
    "verified": "browser 2026-08-17 — block page watched rendering the requested height",
    "source": "curated"
  }]
},
"CANTON": { "none": "Canton's network is permissioned — no public block explorer" }
```

Open the deep link before you write the kind down. `probe-explorers.mjs` will
tell you the host is up, and that a route exists; it cannot tell you the page
rendered the block you asked for, because most explorers are single-page apps
that answer 200 for any path under their router. If you cannot reach the site,
say so in `verified` — do not imply a check that did not happen.
