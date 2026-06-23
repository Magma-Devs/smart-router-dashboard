# Smart Router Dashboard (v2)

A Prometheus-driven observability dashboard for the [Magma Devs](https://magmadevs.com)
**Smart Router** — the process that sits in front of raw RPC endpoints and
multiplexes, retries, hedges, caches, and cross-validates across them.

This is the **v2 rebuild**: a pnpm/TypeScript monorepo (Fastify API + Next.js 16
web + shared package), built to the engineering standard of `~/projects/lava-connect`.
It **coexists** with the legacy Python/Next stack in the parent repo (`../backend`,
`../frontend`) — v2 lives entirely under `v2/`.

> **lava-connect is the shape reference only.** We copy its *tooling, structure,
> and conventions* (strict TS, Node16 ESM `.js` suffixes, Fastify plugin/route/
> service layout, pnpm workspace, vitest, Docker patterns) — NOT its domain.
> This product has **no database, no billing, no users table**. It reads live
> metrics from Prometheus and router topology from a mounted config file.

## Quick start

```bash
# Local dev (Node 22 + pnpm 10)
pnpm install
pnpm --filter @sr/shared build      # api/web read shared's dist
pnpm dev                            # api :8000, web :3000

pnpm typecheck && pnpm test
```

### Run the full stack against a real Smart Router

The dashboard is useless without a router emitting metrics. Bring one up from
`~/projects/smart-router` (router + Prometheus), then point this stack at it.

```bash
# 1. Router + Prometheus (offline specs so it never hits GitHub):
#    (run from ~/projects/smart-router — do NOT edit that repo)
SR_CONFIG=config/smartrouter_examples/smartrouter_eth.yml SR_SPEC=specs/ \
  docker compose -f docker/docker-compose.dashboard.yml up -d router prometheus

# 2. This dashboard (api+web), joining the router's network:
docker compose -f v2/docker-compose.yml up --build
#    UI → http://localhost:3000   API → http://localhost:8000
```

## Architecture

```
┌──────────────┐  REST  ┌─────────────────────┐  PromQL  ┌────────────┐
│ apps/web      │───────▶│ apps/api            │─────────▶│ Prometheus │
│ Next.js 16    │        │ Fastify 5 (:8000)   │          │ (:9090)    │
│ (:3000)       │        │ stateless proxy     │          └─────┬──────┘
│ SWR · @sr/*   │        │ no DB               │           scrapes
└──────────────┘        └─────────────────────┘           ┌─────┴──────┐
                                  │ reads                  │ smart-router│
                          helm-values/core/values.yml      │ :7779/metrics│
                          (the router's own config)        └────────────┘
```

## Monorepo layout

```
v2/
  packages/shared/        @sr/shared — domain types, metric catalog, PromQL builders
    src/
      constants/metrics.ts   GROUND-TRUTH metric names (see "Metrics" below)
      constants/chains.ts     buildChainMetaByIndex(spec) — keyed by Lava spec index
      constants/windows.ts    WINDOWS (5m..30d) → PromQL range + step
      promql/builders.ts      typed query builders shared by api (+ docs)
      types/domain.ts         ChainMetrics, ProviderMetrics, DashboardSummary, …
  apps/api/               @sr/api — Fastify 5 (:8000)
    src/
      routes/             health · version · auth · metrics · config
      plugins/            error-handler · prometheus (decorates services) · auth
      services/           prometheus-client · metrics · configuration (helm-values)
      config.ts           env defaults + cache TTLs
  apps/web/               @sr/web — Next.js 16 App Router (:3000)
    src/app/(app)/        overview · metrics · providers · endpoints · live-test
    src/app/login/        basic-auth sign-in (parity with v1)
    src/components/gateway Shell · Sidebar · Topbar · WindowSelector · Sparkline
    src/styles/globals.css design tokens ported from the SR Dashboard prototype
```

## Metrics — ground truth vs. the design docs

⚠️ **The live router build emits `smartrouter_*` / `rpc_endpoint_*` / `rpc_optimizer_*`,
NOT `lava_rpcsmartrouter_*`** as the `../SR Dashboard/*.md` docs claim. Always verify
against a live scrape (`docker exec smart-router-router-1 wget -qO- localhost:7779/metrics`).
The catalog lives in `packages/shared/src/constants/metrics.ts`. See
[`docs/METRICS-MAPPING.md`](docs/METRICS-MAPPING.md).

**The dashboard never invents data.** Any value with no backing metric is returned
as `null` by the API and rendered as `—` in the UI. Notably:

| Panel value | On this build |
|---|---|
| Requests / success / read totals, latency histogram, latest block, overall health, consistency, csm, total relays | **Real** (`smartrouter_*`) |
| Per-endpoint health/block/latency/in-flight/relays | **Real** (`rpc_endpoint_*`) |
| QoS / selection score (availability/latency/sync/stake/composite) | **Real** (`rpc_endpoint_selection_score`) — the design doc wrongly called this "no metric" |
| Cache, retries, hedge, cross-validation, errors, write/batch, websocket | **Absent until the feature fires** → UI shows `—`. See `docs/METRICS-MAPPING.md` for the smart-router PRs that would add them. |

Chains are keyed by **Lava spec index** (the `spec` label: `ETH1`, `BASE`, …),
not a human chain id — resolve display metadata via `buildChainMetaByIndex`.

## Config passing (helm-values)

Same mechanism as v1: the router's own `SR_CONFIG` yaml is bind-mounted into the
api at `/app/helm-values/core/values.yml:ro`. `ConfigurationService` reads it and
parses the native `endpoints:` + `direct-rpc:` shape into router rows
(`GET /api/config/routers`), so the Endpoints + Live-test pages reflect the running
topology with no duplicated config. Override the mount dir with `HELM_VALUES_DIR`.

## API endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` · `GET /health/ready` | public | Liveness / readiness (readiness pings Prometheus) |
| `GET /version` | public | Build provenance |
| `POST /api/auth/login` · `GET /api/auth/status` | public | Basic-auth sign-in (parity with v1) |
| `GET /api/metrics/specs` | * | Distinct chains emitting metrics |
| `GET /api/metrics/dashboard-summary?window=` | * | Overview hero cards |
| `GET /api/metrics/chains?window=` | * | Per-chain rollup (Routers table) |
| `GET /api/metrics/providers?window=&spec=` | * | Provider roster + selection scores |
| `GET /api/metrics/rps?window=&spec=` | * | RPS time-series |
| `GET /api/metrics/query?query=` | * | Raw instant PromQL passthrough |
| `GET /api/config/routers` | * | Live router topology from helm-values |

`*` = gated only when `AUTH_ENABLED=true` (basic auth). Disabled by default in dev.

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `API_PORT` | `8000` | API |
| `PROMETHEUS_URL` | `http://localhost:9090` | API |
| `CORS_ORIGINS` | all | API (comma list or JSON array) |
| `AUTH_ENABLED` | `false` | API — turn on the basic-auth gate |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | `admin` / `password` | API |
| `HELM_VALUES_DIR` | `/app/helm-values` | API — reads `<dir>/core/values.yml` |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Web — baked at build time |
| `NEXT_PUBLIC_LOCAL_MODE` | `false` | Web — live-test hits `localhost:<port>` directly |

## Docker / isolation

A sibling agent may run the smart-router stack on the same daemon. To avoid
collisions this project uses distinct names: images `sr-dashboard-{api,web}`,
compose project `smart-router-dashboard`, and a dedicated buildx builder
(`srdash-builder`) — a shared/contaminated BuildKit cache will serve the wrong
`apps/api/package.json`, so always build with `--builder srdash-builder`.

## Gotchas

| Trap | Reality |
|---|---|
| ESM `.js` suffixes | `apps/api` + `packages/shared` use Node16 resolution — relative imports need `.js` suffixes even though source is `.ts`. `apps/web` uses bundler resolution (no suffixes). |
| shared `dist` | api/web read `@sr/shared` from `dist/` — run `pnpm --filter @sr/shared build` after editing it (the dev `builder` service does this on a `tsc --watch`). |
| Metric names | NOT `lava_rpcsmartrouter_*` — see Metrics above. |
| BuildKit cache | Build images with the isolated `srdash-builder` (see Docker / isolation). |
```
