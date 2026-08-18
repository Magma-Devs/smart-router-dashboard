# Chain catalogs — what the dashboard knows about a chain

The dashboard only ever knows a chain by its **Lava spec index** — the `spec`
Prometheus label, the values-file `chain-id`: `ETH1`, `COSMOSHUB`,
`HYPERLIQUID`. Everything a human sees about that chain is resolved from
generated catalogs keyed by that index.

| Catalog | File | Accessor |
|---|---|---|
| Name, family, icon, interfaces, mainnet flag | `packages/shared/src/constants/chain-map.generated.json` | `buildChainMetaByIndex(spec)` |
| Block explorers | `packages/shared/src/constants/chain-explorers.generated.json` | `explorersFor(spec)`, `explorerBlockUrl(spec, height)`, `explorerHome(spec)` |
| Try-it method catalog | `apps/web/src/components/try-me/chain-methods.generated.json` | the Try-it drawer |

All are generated from [Magma-Devs/lava-specs](https://github.com/Magma-Devs/lava-specs)
and gated in CI by `apps/web/scripts/check-spec-sync.mjs`. Never hand-edit
them. The procedure for regenerating lives in
[`.claude/rules/chain-resync.md`](../.claude/rules/chain-resync.md).

## Explorers

Every number the dashboard renders for a chain — a latest block, a tip lag — is
a claim about a public chain. The explorer map is what lets a reader check that
claim at the source, which is the difference between a dashboard you believe
and one you verify.

**The catalog links one thing: a block HEIGHT.** That is the only value the
dashboard holds which a public chain can confirm. There is no transaction hash
and no chain address anywhere in its domain model — `provider_address` is an
upstream's name, not an on-chain address — so a transaction or address template
would address a value that does not exist. The catalog carried 321 of them
once, and 18 chains carried nothing else: covered in the file, unlinkable in
the UI.

### The join key

Each spec declares a `chain-id` **verification** — `ETH1` → `0x1`,
`COSMOSHUB` → `cosmoshub-4`. That is the key into two public registries, so
most of the catalog is derived rather than hand-written:

| Source | Chains | How |
|---|---|---|
| [`ethereum-lists/chains`](https://chainid.network/chains.json) | 79 | hex chain-id → decimal → the row's `explorers[]`, with `standard: EIP3091` carrying the link shape |
| [`cosmos/chain-registry`](https://github.com/cosmos/chain-registry) | 38 | string chain-id matched against every `chain.json`; the registry supplies `block_page` / `tx_page` / `account_page` templates outright |
| `apps/web/scripts/data/explorer-overlay.json` | 83 | curated by hand — bitcoin, solana, move, substrate, ledger-sequence and everything else neither registry covers, plus overrides |

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

### Link shapes are a table, not 200 strings

An entry stores a **kind** — a key in
`packages/shared/src/constants/explorer-kinds.json` — rather than its own copy
of a URL template. `{base}` is the entry's own url:

```json
"block":  { "block": "{base}/block/{block}" }
"blocks": { "block": "{base}/blocks/{block}" }
```

Eight kinds cover 204 chains, and each is auditable in a single read. Three
rules keep them honest:

1. **A block template takes a HEIGHT.** Explorers whose block page is addressed
   by hash (NearBlocks, MultiversX, cspr.live) are `home`-only. The dashboard
   has a height, so a hash-addressed block page is not a link it can build.
2. **A shape is watched, or it is not claimed.** "The home page answered" is
   not evidence about the block page — 24 entries were home-only for exactly
   that reason, and twelve of them turned out to have a working block page
   nobody had opened. Check the block page itself, with a real browser: a
   Cloudflare challenge answers 403 to `fetch` while a scripted Chromium with a
   real user-agent gets through, so a 403 is often the tool's problem, not the
   site's.
3. **A kind never contributes a shape.** It is shorthand for a shape already
   established — the registry's own `block_page` string matching it exactly, or
   a human watching the page render. An earlier version matched a kind on the
   transaction and address templates and let it add its own block shape on top;
   that shipped 31 block links nobody had seen work, 23 of them the primary.
   On Lava's STAVR explorer the invented `/block/<height>` renders an empty
   shell.
4. **A shape may be inherited only from the same host.** `cosmos/chain-registry`
   spells out Mintscan's `/blocks/<height>` on COSMOSHUB and leaves it null on
   the twelve other Mintscan deployments; those twelve are the same explorer on
   the same host, so the proven shape carries across and the row says
   `inherited`. Hosts that proved nothing anywhere stay `home`-only.

`explorerBlockUrl()` returns **null**, never a guess, when no shape is proven —
45 of 204 primaries are home-only, so null is a common outcome, not an edge
case. A caller that gets null must render the height as plain text; falling
back to the home page would quietly send the reader somewhere that does not
answer their question. It also refuses anything that is not digits, so a hash
passed by mistake cannot become a link.

### Every row says how it is known

Each explorer carries a `verified` field, and nothing ships without one:

| Value | Meaning |
|---|---|
| `registry — …` | the registry asserted the shape (chainlist's `EIP3091`, or chain-registry's own `block_page`) |
| `inherited — …` | the same host's block shape, proven by the registry on another chain |
| `browser 2026-08-17 — …` | a person opened the deep link and watched it render the value asked for |
| `home probed …` | a `home`-only entry whose home page answered — which is the entire claim it makes |
| `unverified — …` | curated from knowledge, with the reason it could not be checked (bot challenge, unreachable host) |

`unverified` rows still ship. A link a user wants, labelled honestly, beats no
link — but they are named on every generator run so the next person on a
network that can reach them can settle it. As of the last refresh, 9 of 204
are unverified, most behind Cloudflare bot management (Blockchair, Cardanoscan,
beaconcha.in, Tronscan, viewblock) which answers 403 to anything without a
real browser's TLS fingerprint.

### Explorers rot, so sweep them

A registry row is a claim someone made once. Hosts die, deployments are retired
and domains change hands, and none of that updates the registry. A sweep of all
213 primary explorers in August 2026 found 141 working and a long tail that had
gone stale — `ftmscan.com` no longer resolving after Fantom's Sonic rebrand,
`agoric.explorers.guru` emptied out the same way Lava's was, Cronos and Flow on
new domains, and one link, Celo Alfajores, redirecting to a **different Celo
testnet** so that anyone checking a height was reading the wrong chain.

Two lessons are baked into the process now:

* **Test with a plausible height, not with block 1.** The first sweep flagged 15
  Mintscan entries as broken because neither block 1 nor block 1000 renders
  there; Osmosis at height 30,000,000 renders fine. Mintscan does not serve low
  heights, and the test was wrong rather than the catalog.
* **"Moved off-host" is the signal that matters.** A dead explorer rarely 404s.
  It redirects to its operator's front page, which answers 200 and looks
  healthy — which is exactly how `agoric.explorers.guru` and `bloks.io` survived
  earlier checks.

### Lava

The project's own chain does not come from either registry, and the reason is
worth knowing before someone reports it as a bug.

`cosmos/chain-registry` lists eleven Lava explorers, all validator-run, and the
first two — all the registry order gave us — are broken: `explorer.finteh.org/lava`
is unreachable, and `lava.explorers.guru` redirects to `explorers.guru`, whose
catalog lists 10 mainnets and 5 testnets with Lava among none of them. Mintscan
has no Lava deployment at all.

The entries are curated from
[docs.lavanet.xyz/block-explorer](https://docs.lavanet.xyz/block-explorer/)
instead — with the caveat that **the explorer that page calls "official" is the
dead `lava.explorers.guru`**, which is worth fixing in the docs. Its MELLIFERA
links are live and redirect to a Lava-dedicated explorer:

| | |
|---|---|
| `LAVA` | [lavacenter.xyz/lava](https://lavacenter.xyz/lava) |
| `LAV1` | [lavatest.mellifera.network/lava](https://lavatest.mellifera.network/lava) |

Both were watched rendering a requested height, so Lava links blocks like any
other chain.

### Chains with no explorer

41 spec indices have none, and each is a recorded decision in the overlay with
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
    "kind": "block",                          // or "custom" with an explicit tpl
    "suffix": "?cluster=devnet",              // optional, applied to every url
    "verified": "browser 2026-08-17 — block page watched rendering the requested height",
    "source": "curated"
  }]
},
"CANTON": { "none": "Canton's network is permissioned — no public block explorer" }
```

**Look for the chain's own documentation first.** A registry lists whoever
registered; the chain's docs name who it considers official, and the two
disagree often enough to matter — `cosmos/chain-registry` lists eleven
validator-run Lava explorers, and the working one came from
[docs.lavanet.xyz/block-explorer](https://docs.lavanet.xyz/block-explorer/)
rather than from any of them. Search for a `docs.<chain>` page named "block
explorer", "explorers" or "tools". Treat it as a lead rather than as truth: that
same page still designates a retired explorer as the official one.

Open the block link before you write the kind down, and check the page shows
the height you asked for. `probe-explorers.mjs` will tell you the host is up
and that a route exists; it cannot tell you the page rendered anything, because
most explorers are single-page apps that answer 200 for any path under their
router — Lava's STAVR and AstroStake both serve a 200 and an empty page for a
block route that does not exist. If you cannot reach the site, say so in
`verified` rather than implying a check that did not happen.
