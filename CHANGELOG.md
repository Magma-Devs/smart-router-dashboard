# Changelog

All notable changes to this project are documented in this file. Versioning is
driven by the root [`VERSION`](./VERSION) file (see README → Releases & images).

## [Unreleased]

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
