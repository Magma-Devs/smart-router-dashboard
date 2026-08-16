# Changelog

All notable changes to this project are documented in this file. Versioning is
driven by the root [`VERSION`](./VERSION) file (see README → Releases & images).

## [Unreleased]

## [0.9.1]

### Fixed

- **The gRPC dial address the Try-it snippets print had no port on a
  Kubernetes deployment.** A published gateway hostname sits on the scheme's
  default port, so `publicUrls` carries no `:port` suffix — and grpcurl
  refuses a bare host (`missing port in address`), so every copied command
  from a deployed gRPC endpoint failed. The scheme's default is appended when
  the address carries none (`sui-testnet-grpc.<domain>:443`), an explicit port
  is left alone, and a path is dropped — a gRPC dial address has no room for
  one. Shipped in 0.9.0 the address was already scheme-stripped; this is the
  half of the same fix that only shows up against a Gateway, not a local
  listen port.

## [0.9.0]

Try-it console. Its Command dropdown named ~20 curated methods per interface
and printed raw ids for everything else, REST resolved no names at all, and a
gRPC-only endpoint had no console to open. This release makes the console read
the same on every interface, tier and transport.

### Added

- **A derived display name for every method.** Curated names still win; the
  rest are read out of the method id itself — namespace dropped, camelCase and
  snake_case split, acronyms kept whole, and a vocabulary segmenter for the
  run-together ids bitcoin-family and Tron use (`getblockcount` → "Get Block
  Count"). Covers 89% of the catalog's 1174 JSON-RPC ids, 97% of its gRPC ids
  and 91% of its 2817 REST paths. It fails closed: an id it can't read
  renders exactly as it did before, because a wrong name is worse than none.
- **Curated names for the debug and trace tiers** (11 + 16 entries), which
  were the only tiers with none — so those tiers now open on the methods
  worth trying instead of listing geth's full 75-method debug surface.
- **A HTTP / WebSocket toggle in the drawer.** A ws-capable endpoint is one
  endpoint with two transports (the router serves the upgrade on the base
  interface's address, path-scoped), and the console now drives both:
  the dial address, the request envelope and the subscription methods follow
  the toggle. The Endpoints page previously reached only HTTP and the
  Upstreams page only ws.
- **A real WebSocket reachability check.** On the ws transport the drawer's
  status tag is this browser's own handshake against the exact URL Send will
  use — not the chain's Prometheus health, which says nothing about whether
  the upgrade is served. Click it to re-check.
- **A console for gRPC endpoints with no method catalog.** Only 28 spec
  indices declare a gRPC collection; a deployment can publish a GRPCRoute for
  any chain (Tron's native API is gRPC). Those endpoints now open on server-
  reflection discovery — no borrowed methods from another chain's catalog.

### Fixed

- **REST commands were keyed by their HTTP verb.** A REST command's `method`
  is `GET`/`POST` and its path lives in the label, so every curated lookup
  asked for "GET" and missed: no REST name ever resolved, the curated subset
  was always empty (so the dropdown listed all 213 Cosmos paths at once
  behind a "Show all" button that did nothing), and the line under the
  dropdown showed a bare verb. Keys are now the path, and the request line
  reads `POST /wallet/getnowblock`.
- **gRPC snippets dialed a URL.** grpcurl, grpcio and grpc-go take
  `host:port`; they were handed the endpoint row's `http://host:port`, which
  grpcurl reads as part of the hostname. They also defaulted to TLS against
  plain-HTTP listen ports — all three now switch on the endpoint's scheme.

## [0.8.0]

Kubernetes endpoint addresses. With a helm-values mount the Endpoints,
Upstreams and Try-me surfaces printed `—` and offered no request console: they
resolved an endpoint's address from `localPorts`, which only a raw SR_CONFIG
mount fills in. A Kubernetes deployment has no listen ports — it has Gateway
hostnames — so the dashboard now derives them from the same values file.

### Added

- **`RouterTopology.publicUrls`** (api-interface → URL) on the helm-values
  path, mirroring the HTTPRoute / GRPCRoute hostname scheme those values
  describe: `<custom_url_prefix | id-lowered>` joined to the interface by `.`
  (the default) or `-` (`hostStructure: chain-interface`), on `base_domain`,
  over the Gateway's TLS listener — its HTTP listener when there is no TLS
  one, keeping non-default ports. Verified against a real 27-router values
  file.
- **Router id on the Endpoints card header** when several routers serve one
  chain (a staging + production pair on the same `network`), which is the only
  case where the chain name alone doesn't identify the card.

### Changed

- **Endpoint addresses resolve public URL → local port → nothing.** Endpoints
  rows/detail, the Upstreams try-URLs and the connection test all follow that
  order, so a Kubernetes deployment shows the hostname a user can actually dial and
  an SR_CONFIG mount is unchanged. Websocket URLs ride the same address,
  path-scoped (`/ws`, `/websocket`). Where neither format publishes an address
  the UI still renders `—` and the console stays hidden — nothing fabricated.

- **Router scope — `?router=` on every `/api/metrics/*` route**, so the
  numbers split per router deployment instead of only per chain. The router
  labels its series with the chain, so two routers serving one chain summed
  together; what separates them is the collector's per-target label
  (`service` under the Prometheus Operator = the router's Service name),
  named by the new `ROUTER_SCOPE_LABEL` env (default `service`).
  - **`GET /api/metrics/routers`** lists the values actually present, so the
    UI can offer exactly the routers this Prometheus can tell apart — `[]`
    meaning "can't split", never "no routers".
  - A **`<RouterSelect>`** in the topbar applies the scope to every panel
    (persisted as `sr:router`). It hides itself below two routers, and a
    selection that disappears resets to "All routers" rather than silently
    filtering every panel to nothing.
  - The matcher is injected into the finished PromQL by `applyScope`
    (`packages/shared/src/promql/scope.ts`) rather than threaded through ~40
    builders. It's a PromQL walker, not a regex: the naive version corrupts
    metric names quoted inside the `{__name__="…"}` presence probes. An
    absent or malformed `router` value reads cluster-wide rather than
    becoming a different query. `cache_*` stays cluster-wide by design — the
    relay cache is a shared sidecar carrying no router's label.

## [0.7.0]

Chain-coverage sync. The **Chain map ↔ lava-specs drift** gate went red again
when lava-specs added 23 chains; regenerating surfaced four more classification
bugs, all fixed in the generators rather than patched into the output.

### Added

- **23 chains** from lava-specs — Concordium, EOS, Hydration, Ice Open Network,
  Oasis, VeChain, X Layer, Zcash, Bitcoin Signet/Testnet4, Berachain Bepolia,
  Solana Devnet, Aptos Testnet, Ethereum Hoodi and Tron Nile (+ testnets). The
  chain map goes 215 → 238 entries and the try-me catalog with it, so each
  arrives with its real per-spec methods.
- **Eight chain icons** — `concordium`, `eos`, `hydration`, `ion`, `oasis`,
  `vechain`, `x-layer`, `zcash` — taking the map from 19 `default.svg` entries
  down to 2 (RACE and its testnet, unchanged). Same provenance rule as before:
  glyph from [@web3icons](https://github.com/0xa3k5/web3icons) (MIT), circle
  colour read from that icon's own backdrop.
- **Three chain-type families** — `concordium`, `eos`, `vechain`.
- **Curated try-me methods** for the surfaces that had none: EOS's nodeos chain
  API, VeChain Thor's REST, Concordium's `concordium.v2.Queries` gRPC and node
  REST, and the TON HTTP API — which also gives **TON itself** its first hints
  (its curated paths predated the toncenter `/v2` + tonindex `/v3` split, so
  they matched nothing). Four more substrate hints reach every polkadot-SDK
  chain, Hydration included.

### Fixed

- **Concordium classified as cosmos.** Serving gRPC counted as cosmos evidence;
  Concordium serves its own `concordium.v2.Queries` service over it. The cosmos
  test is now the cosmos-SDK surface itself (`/cosmos/…` paths, `cosmos.*`
  services) or a cosmos import.
- **Ice Open Network classified as EVM.** REST-only, no `eth_*` anywhere: it hit
  the generator's blanket `evm` fallback. It is a TON fork serving the identical
  `/v2` + `/v3` paths, and is now grouped with TON.
- **Native L1s labelled by their EVM compatibility layer.** EOS, VeChain and
  Tron Nile serve `eth_*` alongside a full native API (nodeos chain API, Thor
  REST, `/wallet/*`); the native identity is now the family — the same call the
  cosmos branch already made for Sei/Kava/Canto. Chains whose base surface is
  EVM (Oasis, X Layer, Berachain, Hydration) stay `evm`.
- **Bitcoin's Signet and Testnet4 flagged as mainnet.** "Signet" names no
  network the testnet regex knew, and `\btestnet\b` cannot match "Testnet4".
  Enjin's test network — branded "Canary Matrixchain" — is caught too, by
  pairing a `<mainnet-index>T` index with its parent.
- **BTC's genesis hash offered on its test networks.** `getblockheader`'s
  example param was scoped by index *prefix*, so BTCT/BTCS/BTCT4 all inherited a
  block hash their chain has never seen. Hints carrying single-network data are
  now scoped to an exact index.
- **Aptos descriptions on other chains' paths.** `/accounts/{address}` also
  belongs to VeChain, and `/` to Arweave and Stellar; the Aptos hints are now
  scoped, and VeChain has its own.
- **Differently-branded testnets missing their mainnet's icon.** Icon
  inheritance paired testnets by a trailing `T` only, so Berachain's Bepolia
  (`BERAB` ← `BERA`) fell to `default.svg`. It now walks index prefixes.
- **Arbitrum Sepolia rendered Arbitrum Nova's logo** — the v1 overlay had it on
  `arbitrum-nova.svg`. It is a testnet of Arbitrum One and now shows that icon.

## [0.6.0]

Chain-coverage refresh. The **Chain map ↔ lava-specs drift** gate had been red
on `main` since lava-specs added 89 chains; regenerating it surfaced three
correctness bugs in the generator that this release also fixes.

### Added

- **89 chains** from lava-specs — 0G, Akash, Aleo, Algorand, Arweave, Babylon,
  Bittensor, Cronos, dYdX, Ethereum Classic, Flare, Flow, Kava, Kusama, Linea,
  Mina, Monero, Moonbeam, Neutron, Plasma, Plume, Polkadot, Sei, Stacks, Story,
  THORChain, Unichain, XDC and more (+ testnets). The chain map goes 134 → 215
  entries and the try-me method catalog 126 → 215, so every new chain arrives
  with its real per-spec methods rather than a family fallback.
- **41 chain icons**. The 89 new chains would otherwise have arrived with 93
  entries on the `default.svg` fallback; 2 remain (RACE and its testnet, which
  publish only a wordmark — illegible at icon size). Glyphs
  come from [@web3icons](https://github.com/0xa3k5/web3icons) (MIT),
  [cosmos/chain-registry](https://github.com/cosmos/chain-registry) (Apache-2.0)
  and each project's own published asset; circle colours are read from the
  icon's own backdrop rather than chosen by hand. `public/chains/README.md` now
  documents the house style, provenance and how to add one.
- **Eight chain-type families** — `substrate`, `monero`, `aleo`, `algorand`,
  `arweave`, `mina`, `multiversx`, `stacks` — so chains that had no correct
  value in `ChainFamily` stop borrowing one.

### Fixed

- **Chains labelled EVM that answer no `eth_*` method.** `deriveFamily` ended in
  a blanket `return "evm"` with a hardcoded index-prefix list as its only
  non-EVM detection, so 26 map entries were wrong — Monero, Stacks, Algorand,
  Aleo, Arweave, Mina, MultiversX, Enjin, Polymesh, Dash, Kusama and Koii among
  them. Classification now follows `imports` transitively (Dash inherits from
  BTC, Koii from SOLANA) and reads the RPC surface actually served. Chains that
  serve `eth_*` *and* substrate RPC — Astar, Moonbeam, Moonriver, Bittensor —
  stay `evm`, since that is the surface the gateway offers. This also stopped
  the Try-it drawer offering `eth_blockNumber` for Monero in the window before
  the generated catalog chunk lands.
- **Lowercase display names.** lava-specs is inconsistent about casing —
  `"Ethereum Mainnet"` next to `"akash mainnet"` — and the raw name was passed
  through, so 50 chains rendered lowercase. Normalised per word, leaving
  deliberate casing intact (`zkSync Era`, `MultiversX`, `BSC`, `Cosmos SDK v50`).
- **Abstract base specs listed as chains.** `IBC`, `TENDERMINT`, `ETHERMINT`,
  `COSMOSWASM` and the four `COSMOSSDK*` specs are `enabled: false` upstream and
  exist only to be imported, but were emitted into `KNOWN_CHAINS`, which backs
  lists and pickers.
- **Testnets that are branded differently from their mainnet** — Astar's
  Shibuya, Polkadot's and Kusama's Westend — no longer fall back to the default
  icon; icon inheritance now pairs them by spec index.

## [0.5.0]

Metrics-correctness overhaul, verified against the live router with a
controlled ground-truth experiment (exact known load + idle fingerprint).

### Fixed

- **Client-scoped request counts.** "Requests served", per-chain/per-method
  requests and every RPS figure now read the end-to-end latency histogram
  `_count` — the only counter that increments once per client request.
  `smartrouter_requests_total` counts *relays* (cross-validation fan-out,
  cache hits as `provider_address="Cached"`, router tracker probes) and stays
  only behind per-upstream/relay lenses.
- **"Stale responses caught" semantics.** Now reads
  `consistency_failed_total` (checks that FAILED). It previously displayed
  `consistency_success_total` — checks that *passed* — so every healthy read
  counted as a caught stale response.
- **Cross-validation panel never lit up.** The catalog probed a
  `smartrouter_cross_validation_total` family that does not exist; the real
  families are `…cross_validation_{requests,success,failed,failures}_total`
  (+ per-provider agreements/disagreements).
- **Whole-number counts.** `round()` on every count query — request/error/
  retry counts no longer render as `increase()` extrapolation fractions
  ("12.2 retries", "111.7 requests").
- **WebSocket URLs.** The router serves ws only under `/ws` (jsonrpc) /
  `/websocket` (tendermint); Try-now and the endpoint sheets no longer emit
  bare `ws://host:port` URLs that 405.
- **Try-now examples that could never succeed** — placeholder tx hashes,
  a pruned Solana slot, pruned Cosmos heights, an estimateGas call that
  always reverted, `<blockhash>` literals. Subscribe methods are hidden on
  non-ws interfaces. 28/28 curated examples pass against the live stack.
- **Charts.** Availability y-axis can no longer exceed 100%; sub-1 RPS axis
  ticks keep decimals instead of rendering "0"; hotspot error trends use the
  real window timestamps (previously hardcoded −24h labels) and rounded
  buckets; method-table columns no longer collapse under long REST paths.
- **Config.** `dev-config/values.yml`: archive reads corroborate across
  tenderly + mevblocker (publicnode's archive claim removed — token-gated at
  relay despite passing the startup probe); broken cross-validation policies
  removed/corrected (REST method names are path patterns); comments slimmed.

### Added

- **Error-class breakdown** — real code / category / retryability pivots from
  the classified `smartrouter_errors_total{chain_id, error_category,
  error_name, retryable}` family (node/protocol/transport class split as the
  fallback), per-hotspot node-errors-by-method, and a node-vs-transport split
  (+ per-method list and cross-validation agree/disagree rate) in the
  upstream deep-dive.
- **Per-method P95** — the router histogram's method label is named
  `function`; the "no method label" design-doc gap was wrong.
- **Try-now relay badges** — `Lava-Retries` retry indicator and a
  cross-validated badge (agreeing/disagreeing providers from the CORS-exposed
  headers).
- **Upstream availability sub-windows** (fixed 1h/24h/7d) in the deep-dive.
- **WebSocket panel**: lifetime totals (windowed `increase()` misses a young
  counter's first increment), per-chain live connection counts, ws
  subscription examples in the Try-now catalog.
- **Sortable method-level breakdown table.**
- **Verified backup tier** in `dev-config/values.yml` for ETH1 (flashbots),
  HYPERLIQUID (purroofgroup) and COSMOSHUB rest (ecostake), alongside the
  existing tendermint backup — every entry passes router startup
  verification. No keyless distinct-vendor backup exists today for
  SOLANA / BTC / APT1 / COSMOSHUB grpc.
- **Docs**: `docs/METRICS-MAPPING.md` "Counter semantics — ground truth"
  section (relay- vs client-scoped counters, transport-success semantics,
  consistency counter meanings) + refreshed mapping tables.

### Changed

- Success-rate tiles/tooltips now state the transport semantics explicitly:
  an upstream answering with a JSON-RPC error object counts as a successful
  relay (it increments `node_errors_total`, not the failure rate).

## [0.4.1]

### Added

- **Optional relay cache.** An opt-in `cache` profile in both compose files runs
  the smart-router RAM relay cache sidecar (`:20100`, metrics `:5555`), mirroring
  `smart-router/docker/docker-compose.cache.yml`. The router connects via
  `cache-be: "cache:20100"` (commented out by default). Adds a `make up-cache`
  target and a Prometheus `smart-router-cache` scrape job.
- **Linting & formatting.** A root ESLint flat config (`typescript-eslint` +
  `eslint-plugin-react-hooks` + `@next/eslint-plugin-next`) and Prettier, wired
  as `pnpm lint` / `pnpm format`. The Quality Gate now runs `pnpm lint` before
  typecheck + tests. React-Compiler-strictness rules are surfaced as warnings so
  existing patterns are visible without blocking CI.
- **Contributor scaffolding.** `.env.example` (every runtime knob, from
  `config.ts`), `.nvmrc` (Node 24), `.editorconfig`, and an issue-template
  `config.yml` routing security reports and questions off the public tracker.
- README: a **Testing & CI** section, a pointer to the api's `/docs` OpenAPI
  explorer, and `.env.example` / `.nvmrc` references.

### Fixed

- **Router crash-loop.** `dev-config/values.yml` over-declared ETH1 addons
  (`debug`/`trace` on publicnode, which doesn't serve those namespaces); the
  router excluded the provider on startup, dropped ETH1 below the
  cross-validation `min-groups: 2` bar, and crash-looped — leaving the dashboard
  blank. Now advertises only what the upstream serves (`archive` + websocket).
- **Impossible metric values.** The UI showed a 103% success rate and a −2.40%
  error rate. `increase()`/`rate()` extrapolation pushed the success/total ratio
  above 1 on young counters — every availability ratio is now `clamp_max(…, 1)`.
  Also, `deploy/prometheus.yml` scraped the same router twice (`router:7779`
  **and** `host.docker.internal:7779`), so `sum()` double-counted every series;
  collapsed to a single target.
- **Web healthcheck.** Next standalone binds `HOSTNAME=localhost` (IPv6) while
  the Docker healthcheck probes IPv4 `127.0.0.1` → the container reported
  `unhealthy` while serving fine. Set `ENV HOSTNAME=0.0.0.0`.
- **Dependabot alerts.** Pinned transitive `esbuild` (≥0.25.0) and `postcss`
  (≥8.5.10) forward via `pnpm.overrides` to clear two medium build-time
  advisories.
- Root `package.json` `engines.node` was `>=22` while the Dockerfiles, CI, and
  README all target Node 24 — aligned to `>=24`.
- Removed a dead `next lint` script (no ESLint was installed for it), dead
  imports in `metrics-detail.ts` / `OverviewView.tsx`, and a mis-placed
  `eslint-disable` directive in `icons.tsx`; tidied two flagged issues in
  `json-display.tsx`.

## [0.4.0]

### Changed

- **The TypeScript monorepo is now the whole repo.** The `v2/` directory was
  promoted to the repo root — `apps/`, `packages/`, `dev-config/`, the compose
  files, and `Makefile` all live at the top level. The build publishes the api
  as `…/backend` and the web as `…/frontend`, the image names the smart-router
  helm chart already consumes, so no deployment change is needed.

### Removed

- **The legacy v1 stack** (`backend/` Python/FastAPI + `frontend/` Next.js) and
  its root `docker-compose*.yml` / `dev-config/`. The Quality Gate's v1
  `frontend`/`backend` jobs and the separate v2 build job are gone — a single
  build-and-push job remains. `REFACTOR-PLAN.md` (the completed rebuild plan)
  was removed.

### Added

- **Optional authentication** (`AUTH_MODE=enabled`): Auth.js v5 sign-in
  (email+password + conditional Google/GitHub/Discord), Postgres-backed users
  (new `@sr/db` package), HS256 JWT shared between web and api, idempotent
  `ADMIN_EMAIL`/`ADMIN_PASSWORD` bootstrap seed, `postgres:18` compose service
  under the `auth` profile. Default stays `disabled` (open dashboard).
  See `docs/AUTH.md`.
- **Live test: full lava-specs method catalog** — generator reads the
  [lava-specs](https://github.com/Magma-Devs/lava-specs) repo and emits
  126 chain indices across jsonrpc/rest/tendermint/grpc with real
  archive/debug/trace tiers (10,600+ methods).
- Repo standard: dual license (PolyForm Noncommercial + Enterprise),
  CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CODEOWNERS, PR/issue templates,
  dependabot, banner, CI quality-gate job.

### Changed (rebuild)

- Router service pulls `ghcr.io/magma-devs/smart-router:latest` and loads
  specs straight from the lava-specs GitHub repo (no local checkout, no
  spec volume mounts).
- Default dev config is multichain (8 endpoints across 6 chains) with
  cross-validation policies enabled.
- All packages bumped to latest stable; runtime images on `node:24-alpine`.
- Branding: Magma Devs only (Lava marks removed); new banner in the
  smart-router visual family.

## [0.3.1]

Last v1-era tag — Python/FastAPI backend + Next.js frontend with HTTP basic
auth, plus the initial v2 rebuild (Fastify + Next.js 16 monorepo).
