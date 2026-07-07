# Smart Router Dashboard

A Prometheus-driven observability dashboard for the [Magma Devs](https://magmadevs.com)
**Smart Router** — the process that sits in front of raw RPC endpoints and
multiplexes, retries, hedges, caches, and cross-validates across them.

A pnpm/TypeScript monorepo (Fastify API + Next.js 16 web + shared package),
built to the engineering standard of `~/projects/lava-connect`, with the web UI
built 1:1 against the `SR_Dashboard/` design prototype. Everything lives at the
repo root — `apps/`, `packages/`, `docker-compose*.yml`, `Makefile`.

> **lava-connect is the shape reference only.** We copy its *tooling, structure,
> and conventions* (strict TS, Node16 ESM `.js` suffixes, Fastify plugin/route/
> service layout, pnpm workspace, vitest, Docker patterns) — NOT its domain.
> This product has **no database, no billing, no users — and no auth**. There
> is no login page, no `/api/auth/*`, no `AUTH_*` env vars; every route is
> public. It reads live metrics from Prometheus and router topology from a
> mounted config file.

## Quick start

The compose stack is **self-contained**: bundled Prometheus + an optional
`router` profile that builds the Smart Router from a checkout.

```bash
make up      # SELF-CONTAINED stack: router + Prometheus + api + web (detached)
make ps      # what's running
make down    # stop everything
make dev     # hot-reload stack (api tsx watch · web next dev · shared tsc --watch)

# equivalently, without make:
docker compose --profile router up --build       # everything from nothing
docker compose up --build                        # dashboard + Prometheus only
                                                 # (a router already runs on the host's :7779)
```

UI → http://localhost:3000 · API → http://localhost:8000 ·
Prometheus → http://localhost:9090 · router ETH1 jsonrpc → http://localhost:3360

```bash
# Host dev (Node 22 + pnpm 10) — needs a Prometheus at PROMETHEUS_URL
pnpm install
pnpm --filter @sr/shared build      # api/web read shared's dist
pnpm dev                            # api :8000, web :3000

pnpm typecheck && pnpm test
```

The `router` profile builds from a smart-router checkout (`ROUTER_DIR`, default
`~/projects/smart-router` via make / `../../smart-router` via compose) because
the published release image ships only the binary — no bundled `specs/`. The
checkout image bundles specs + example configs, so it boots offline. Override
paths/ports via Makefile/compose vars (`ROUTER_DIR`, `SR_CONFIG_HOST`,
`SR_SPEC`, `WEB_PORT`, …).

## Architecture

```
┌──────────────┐  REST  ┌─────────────────────┐  PromQL  ┌────────────┐
│ apps/web      │───────▶│ apps/api            │─────────▶│ Prometheus │
│ Next.js 16    │        │ Fastify 5 (:8000)   │          │ (:9090,    │
│ (:3000)       │        │ stateless proxy     │          │  bundled)  │
│ SWR · @sr/*   │        │ no DB · no auth     │          └─────┬──────┘
└──────┬───────┘        └──────────┬──────────┘        scrapes :7779
       │ GET /api/config           │ reads               ┌─────┴──────┐
       │ (runtime api url)         └─ values file ──────▶│ smart-router│
       └─ browser POSTs to router :3360 (Live test)      │ (profile)  │
                                                          └────────────┘
```

**ONE values file drives both the router and the dashboard** (the v1 pattern):
`SR_CONFIG_HOST` (default `./dev-config/values.yml`) is mounted as the router's
config **and** as the api's helm-values, so the Endpoints/Providers pages always
reflect the running topology with no duplicated config.

## Monorepo layout

```
packages/shared/          @sr/shared — domain types, metric catalog, PromQL builders
  src/
    constants/metrics.ts   GROUND-TRUTH metric names + OPTIONAL_METRICS (see "Metrics")
    constants/chains.ts     buildChainMetaByIndex(spec) — keyed by Lava spec index
    constants/windows.ts    WINDOWS — 13-window catalog (5m..30d) → PromQL range + step
    promql/builders.ts      typed query builders shared by api (+ docs)
    types/domain.ts         OverviewData, DashboardData, HeroSummary, ChainSeries,
                            ProviderDetail, ErrorsReport, RouterTopology, …
apps/api/                 @sr/api — Fastify 5 (:8000)
  src/
    routes/             health · version · metrics · config
    plugins/            error-handler · swagger · prometheus (decorates services)
    services/           prometheus-client · metrics · metrics-detail ·
                        metrics-dashboard · configuration (values-file loader)
    config.ts           single source of truth for env defaults
apps/web/                 @sr/web — Next.js 16 App Router (:3000)
  src/
    app/(app)/          overview · dashboard · providers · endpoints · metrics ·
                        live-test · team · account (Shell layout)
    app/standalone/     chrome-less Metrics page (sharing/embedding)
    app/api/config/     runtime-config route (DASHBOARD_API_URL → browser)
    components/
      gateway/          Shell · Sidebar/Topbar · RouterHeader · FiltersProvider ·
                        WindowSelector · charts · SortTable · SideSheet · icons
      overview/         OverviewView (KPI strip + 2×2 chart grid)
      dashboard/        DashHeader · OverviewTab · MetricsTab · TroubleDetail · …
      metrics/          MetricsView (4 tabs) · HeroPanel · RouterOverview ·
                        ChainDetail · ErrorsBreakdown · TrafficUsage ·
                        CrossValidation · WebSocketPanel · provider/ (PM* deep-dive)
      providers/        ProvidersView · Add/Edit sheets · TestModal · catalog
      endpoints/        EndpointsView · detail/create sheets
      team/             InviteModal · ChangeRoleModal · bits
    hooks/use-api.ts    SWR wrapper (15s poll default)
    lib/api-client.ts   base URL resolved ONCE per session from /api/config
    styles/globals.css  design tokens + gw-* classes, 1:1 from the prototype
```

Fonts are self-hosted at build time via `next/font` (Inter + JetBrains Mono),
matching the prototype's two families — no runtime Google Fonts fetch.

## Metrics — ground truth vs. the design docs

⚠️ **The live router build emits `smartrouter_*` / `rpc_endpoint_*` / `rpc_optimizer_*`,
NOT `lava_rpcsmartrouter_*`** as the `../SR_Dashboard/*.md` docs claim. Always verify
against a live scrape (`docker exec smart-router-router-1 wget -qO- localhost:7779/metrics`).
The catalog lives in `packages/shared/src/constants/metrics.ts`. See
[`docs/METRICS-MAPPING.md`](docs/METRICS-MAPPING.md).

### The honesty contract

**The dashboard never invents data.** Every populated value maps to a real
Prometheus series; anything unbacked comes back as `null` / empty plus an
explicit **`emitted: false`** (or `families.*` / `classTotals.emitted.*`) flag,
and the UI renders the design's own empty states.

Absent-until-fired families (`OPTIONAL_METRICS`) are **probed for presence**
(`qPresence` = `count({__name__="…"})`) on every read — panels light up
automatically the first time the router registers a family. No code change,
no redeploy.

| Panel value | On this build |
|---|---|
| Requests / success / read totals, latency histogram, latest block, overall health, consistency, csm, total relays | **Real** (`smartrouter_*`) |
| Per-endpoint health/block/latency/in-flight/relays, per-provider p95 | **Real** (`rpc_endpoint_*`) |
| QoS / selection score (availability/latency/sync/stake/composite) | **Real** (`rpc_endpoint_selection_score`) — the design doc wrongly called this "no metric" |
| Errors (total, trend, per-chain/method/provider) | **Real, derived** — `clamp_min(total − success, 0)`; a single honest `unclassified` layer until labelled error counters exist |
| Cache, retries, hedge, cross-validation, error-code counters, write/batch, websocket | **Absent until the feature fires** → nulls + `emitted:false`. See `docs/METRICS-MAPPING.md` for the smart-router PRs that would add them. |
| Compute-unit quota, RPS cap, regions, team members | **Magma Cloud concepts** — not metered here; pinned `null` (UI shows "not tracked") |

Chains are keyed by **Lava spec index** (the `spec` label: `ETH1`, `BASE`, …),
not a human chain id — resolve display metadata via `buildChainMetaByIndex`.

## Config passing (values file — BOTH formats)

The router's own config yaml is bind-mounted into the api at
`/app/helm-values/core/values.yml:ro` (override the dir with `HELM_VALUES_DIR`).
`ConfigurationService` detects and parses **either** supported format into
`RouterTopology[]` (`GET /api/config/routers`):

1. **Helm-chart values** — `routers:[{id, network, nodes:[{name, is_backup,
   endpoints:[{url, interface, addons}]}], custom_url_prefix?, pathBased?}]`,
   with `pathBased` resolved per-router against the global
   `miscellaneous.gateway.pathBased.enabled` default (chart semantics).
   Only this format can mark **backup** nodes.
2. **Raw smart-router SR_CONFIG** — the YAML the router itself runs
   (`endpoints:` + `direct-rpc:`). Providers are grouped by chain-id into one
   router per chain; the `endpoints:` listen ports become **`localPorts`,
   keyed per api-interface** (one chain can expose several interfaces on
   different ports, e.g. LAVA rest:3360 + tendermintrpc:3361).

Detection is by key: `routers` ⇒ helm; `direct-rpc` ⇒ sr-config; anything else
yields an empty topology. **Node URLs are masked to scheme+host** — upstream
provider URLs routinely embed API keys in the path.

## Time windows

`packages/shared/src/constants/windows.ts` defines the **13-window catalog**
(`5m 15m 30m 1h 3h 6h 12h 1d 3d 7d 14d 21d 30d`), each with a PromQL range and
a step targeting ~150–200 range points (clamped to ≥15s, the scrape interval).
Every `window=` query param accepts those keys **plus the `24h` alias (= `1d`)**;
anything else falls back to the default `1d`. The page-level `<select>` shows
the design's 12 options (`WINDOW_OPTIONS` — everything except `1h`, which the
Dashboard page's chip row uses internally).

## API endpoints

All endpoints are **public** (no auth) and return `application/json`.

| Endpoint | Params | Returns |
|---|---|---|
| `GET /docs` · `GET /docs/json` | — | Swagger UI explorer + OpenAPI 3.1 spec. Registered outside production only. |
| `GET /health` | — | Liveness — `{ health: "ok" }` |
| `GET /health/ready` | — | Readiness — pings Prometheus; 503 + `components.prometheus:"ping_failed"` on failure |
| `GET /version` | — | Build provenance — `{ commit, version, env, startedAt, uptimeSec }` |
| `GET /api/metrics/specs` | — | `{ specs: string[] }` — distinct chains present on the requests counter |
| `GET /api/metrics/dashboard-summary` | `window` | `HeroSummary` — the six hero cards as `Kpi` `{value, prior}` pairs (`requestsServed`, `successRate`, `effectiveReadP95Ms`, `staleCaught`, `retriesRecovered`, `cacheOffloadPct`) + `providerCount` / `chainCount` / `health` + **`emitted: {retries, cache}`** |
| `GET /api/metrics/overview` | `window`, `spec?` | `OverviewData` — KPI pairs (requests, RPS, errors, success rate, p50/p95/p99), `errorRate`, `health`, throughput/errors series, `latencySeries` (p50/p95/p99 toggle), **`latencyDistribution`** (histogram buckets), **`perProviderSeries`**, **`errorLayers`** (single `unclassified` layer until labelled counters exist), `perChainLatency`, `activeRoutes`, `perChainSeries`; `computeUnits`/`rpsCap` always null |
| `GET /api/metrics/dashboard` | `window`, `spec?` | `DashboardData` — the Dashboard page (both tabs) in one round-trip: `kpis` (successRate, p95Ms, errors, rps, errorsHandled=null), `series` (throughput, errors, errorRate, successRate, latency p50/95/99, perChain, perChainSuccessRate, perChainLatency, providerMix, perProviderLatencyP95), `chains` (multiselect options — the series filter is client-side; `spec` accepted for symmetry). Unbacked families (`scu`, `regions`, `failoverRatio`, `internalAvailability`, `cacheHitRate`, `errorClasses`, `errorsHandledBreakdown`, `contribution`, `providerAvailability`, `scorecard`) are `null`, `trouble` is `[]` |
| `GET /api/metrics/chains` | `window` | `{ chains: ChainMetrics[] }` — per-chain rollup (requests, availability, errorRate, p95, composite QoS, health, latestBlock, providerCount) for the Routers table |
| `GET /api/metrics/providers` | `window`, `spec?` | `{ providers: ProviderMetrics[] }` — roster with requests, uptime, p95, **errorRate**, selection scores, health, latestBlock, **blockLag**, **role** (`primary`/`backup` from helm `is_backup`; null for SR_CONFIG), **apiInterface**, inFlight |
| `GET /api/metrics/rps` | `window`, `spec?` | `TimeSeries` — `{ label, points: {t, v}[] }` |
| `GET /api/metrics/traffic` | `window` | Traffic tab — aggregate `rpsNow` + series + per-chain rows (`rpsNow`, `requests`, `share`, `trend` sparkline) |
| `GET /api/metrics/methods` | `window`, `spec?` | `{ methods: MethodUsage[], classTotals: MethodClassTotals }` — per-method requests/class/errorRate (`p95Ms` null: the router histogram has no `method` label); classTotals: `read` real, `write`/`batch` null + `emitted` flags, `unclassified` remainder |
| `GET /api/metrics/chain-series` | **`spec`** (required), `window` | `ChainSeries` — the ChainDetail metric-switcher bundle: availability / p95 / errorRate / rps series + `qos` (optimizer-scope score, endpoint-scope fallback; null when never emitted) + `backupShare` (only when the config marks backups). 400 without `spec` |
| `GET /api/metrics/provider-detail` | **`endpointId`** (required), `window` | `ProviderDetail` — PMBody deep-dive: health, availability, requests, rpsNow, p50/95/99, errorRate, blockLag, inFlight, score gauges + per-score-type series, latency/volume/block-lag series (`volume.read` real; write/batch null); `errorsByCode`/`recentErrors` empty + `emitted` flags. 400 without `endpointId` |
| `GET /api/metrics/errors` | `window`, `spec?` | `ErrorsReport` — derived `total` + `trend`, (chain × provider) **hotspots** (trend sparklines for the top 5), chain/method **pivots**; `category`/`code`/`retryability` pivots stay `[]` until labelled error counters exist (**`families`** presence flags) |
| `GET /api/metrics/unavailable` | — | `{ unavailable: UnavailableChain[] }` — chains whose **every** backing endpoint reports down (`sinceSeconds` null for now) |
| `GET /api/metrics/cross-validation` | `window` | `CrossValidationReport` — `emitted:false` + nulls until `cross_validation_*` fires; **`consistency` (total/caught) is real either way** |
| `GET /api/metrics/websocket` | `window` | `WebSocketReport` — `emitted:false` + nulls until `ws_*` fires (first subscription) |
| `GET /api/metrics/query` | **`query`** (required) | Raw **instant** PromQL passthrough — `{ result }`. 400 without `query` |
| `GET /api/config/routers` | — | `{ routers: RouterTopology[] }` — live topology from the mounted values file (either format), node URLs masked to scheme+host |

## Environment variables

API (`apps/api/src/config.ts` is the source of truth):

| Variable | Default | Notes |
|---|---|---|
| `API_PORT` | `8000` | |
| `API_HOST` | `0.0.0.0` | |
| `PROMETHEUS_URL` | `http://localhost:9090` | compose sets `http://prometheus:9090` |
| `PROMETHEUS_TIMEOUT_MS` | `10000` | per-query abort |
| `CORS_ORIGINS` | all | comma list or JSON array |
| `RATE_LIMIT_MAX` | `300` | per IP per minute |
| `HELM_VALUES_DIR` | `/app/helm-values` | reads `<dir>/core/values.yml` (either format) |
| `LOG_LEVEL` | `info` | |
| `TENANT_ID` | `default` | parsed, reserved — not read by any route yet |
| `GIT_COMMIT` / `APP_VERSION` | `unknown` / `0.0.0` | surfaced by `/version` |
| `NODE_ENV` | `production` | non-prod enables `/docs` + pretty logs |

Web — build-time vs. **runtime**:

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | baked into the bundle at **build** time |
| `NEXT_PUBLIC_LOCAL_MODE` | `false` | build-time default for the `localMode` flag |
| `DASHBOARD_API_URL` | (unset) | **runtime** override — read from the container env per-request by `GET /api/config`, so one published image serves any host |
| `DASHBOARD_LOCAL_MODE` | (unset) | runtime override of `localMode`, same mechanism |
| `DASHBOARD_GRAFANA_URL` | `http://localhost:3001` | Grafana base URL the "View full logs" button links to — runtime override via `/api/config`, same mechanism (falls back to `NEXT_PUBLIC_GRAFANA_URL`) |

The browser resolves its api base **once per session** from `/api/config`
(`DASHBOARD_API_URL` → `NEXT_PUBLIC_API_URL` → `http://localhost:8000`),
falling back to the build-time value if the route is unreachable
(`lib/api-client.ts`).

Compose / Makefile knobs:

| Variable | Default | Notes |
|---|---|---|
| `SR_CONFIG_HOST` | `./dev-config/values.yml` | **the** values file — mounted into the router as its config AND into the api as helm-values |
| `ROUTER_DIR` | `~/projects/smart-router` (make) / `../../smart-router` (compose) | router-profile build context |
| `SR_SPEC` | `specs/` | `--use-static-spec` dir inside the router image |
| `SR_LOG_LEVEL` / `SR_LOG_FORMAT` | `info` / `json` | router logging |
| `BUILDER` / `API_IMAGE` / `WEB_IMAGE` / `API_PORT` / `WEB_PORT` / `API_URL` | see Makefile | `make build` image names + printed URLs |

## Docker / images / isolation

- **Self-contained compose**: `deploy/prometheus.yml` ships two static scrape
  jobs — the bundled `router:7779` and `host.docker.internal:7779` (an
  already-running host router); a down target is harmless since every query
  aggregates with `sum()`/`max()`. Distinct compose project names
  (`smart-router-dashboard` / `smart-router-dashboard-dev`) avoid collisions
  with a sibling agent's smart-router stack.
- The router profile boots with `--cors-headers "*"` (the browser Live-test
  panel preflights cross-origin POSTs) and `--skip-websocket-verification`
  (http-only upstreams boot cleanly).
- **GHCR publishing**: the `build-and-push` job in
  `.github/workflows/build-and-push.yml` publishes the api as
  `ghcr.io/magma-devs/smart-router-dashboard/backend` and the web as
  `…/frontend` (tags: `VERSION`, `major.minor`, `latest` on main; other
  branches get a `-<branch>` suffix). Those image names are the ones the
  smart-router helm chart consumes, so the build target (`apps/api` /
  `apps/web`) maps onto them in the workflow matrix. `make build` reproduces
  the same images locally on an isolated buildx builder (`srdash-builder`) —
  on a Docker daemon shared with sibling projects, BuildKit's shared cache can
  serve the wrong project's `apps/api/package.json`
  (`ERR_PNPM_OUTDATED_LOCKFILE` mentioning `@info/shared`), so the `make
  build*` targets always pass `--builder srdash-builder`.

## Gotchas

| Trap | Reality |
|---|---|
| ESM `.js` suffixes | `apps/api` + `packages/shared` use Node16 resolution — relative imports need `.js` suffixes even though source is `.ts`. `apps/web` uses bundler resolution (no suffixes). |
| shared `dist` | api/web read `@sr/shared` from `dist/` — run `pnpm --filter @sr/shared build` after editing it (the docker dev `builder` service does this on a `tsc --watch`). |
| Metric names | NOT `lava_rpcsmartrouter_*` — see Metrics above. The `../SR_Dashboard/` prototype is authoritative for **pixels**, not for metric names. |
| Window params | `24h` is a wire alias of `1d`; unknown values silently fall back to `1d` (never a 400). `1h` is in the catalog but not in the page-level select. |
| Provider `role` | Only the helm values format marks backups (`is_backup`); with a raw SR_CONFIG mount, `role` is null and backup-share panels stay empty — that's honest, not a bug. |
| BuildKit cache | `make build*` targets use the isolated `srdash-builder` (see Docker / images / isolation). Plain `docker compose up --build` is fine for the stack itself. |
