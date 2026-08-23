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
> This product has **no billing and no users table by default**. It reads live
> metrics from Prometheus and router topology from a mounted config file.
> **Auth is optional**: `AUTH_MODE=disabled` (the default) leaves every route
> public with no database; `AUTH_MODE=enabled` adds an Auth.js login, a JWT gate
> on `/api/*`, `/auth/*` routes, and a Postgres `users` table (`packages/db`).
> See [`docs/AUTH.md`](docs/AUTH.md).

## Quick start

The compose stack is **self-contained**: bundled Prometheus + an optional
`router` profile that builds the Smart Router from a checkout.

```bash
make up      # SELF-CONTAINED stack: router + Prometheus + api + web + logs (Grafana :3001), detached
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
│ SWR · @sr/*   │        │ optional auth/DB    │          └─────┬──────┘
└──────┬───────┘        └──────────┬──────────┘        scrapes :7779
       │ GET /api/config           │ reads               ┌─────┴──────┐
       │ (runtime api url)         └─ values file ──────▶│ smart-router│
       └─ browser POSTs to router :3360 (Live test)      │ (profile)  │
                                                          └─────┬──────┘
                        POST /api/upstreams/relay               │
       api ─────────────────────────────────────────────▶ upstream RPC
       (Try-me "Direct to upstream" — router left out)     (vendor endpoint)
```

The api's one **outbound** path besides Prometheus is that relay: the Try-me
drawer's "Direct to upstream" mode. The browser can't make that call itself —
node urls are masked to scheme+host before they leave the api, because that is
where API keys live — so the api dials the upstream and hands back only the
answer. See [`docs/UPSTREAM-DIRECT-TEST.md`](docs/UPSTREAM-DIRECT-TEST.md).

**ONE values file drives both the router and the dashboard** (the v1 pattern):
`SR_CONFIG_HOST` (default `./dev-config/values.yml`) is mounted as the router's
config **and** as the api's helm-values, so the Upstreams page always
reflects the running topology with no duplicated config.

## Monorepo layout

```
packages/shared/          @sr/shared — domain types, metric catalog, PromQL builders
  src/
    constants/metrics.ts   GROUND-TRUTH metric names + OPTIONAL_METRICS (see "Metrics")
    constants/chains.ts     buildChainMetaByIndex(spec) — keyed by Lava spec index
    constants/explorers.ts  explorersFor / explorerUrl — the chain's block
                            explorer + deep links (docs/CHAINS.md)
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
    app/(app)/          overview · dashboard · upstreams · metrics ·
                        team · account (Shell layout)
    app/standalone/     chrome-less Metrics page (sharing/embedding)
    app/api/config/     runtime-config route (DASHBOARD_API_URL → browser)
    components/
      gateway/          Shell · Sidebar/Topbar · RouterHeader · FiltersProvider ·
                        WindowSelect · ChainSelect · RouterFilterSelect ·
                        HealthTag · charts · SortTable · SideSheet · icons
      overview/         OverviewView (KPI strip + 2×2 chart grid)
      dashboard/        DashHeader · OverviewTab · MetricsTab · TroubleDetail · …
      metrics/          MetricsView (4 tabs) · HeroPanel · RouterOverview ·
                        ChainDetail · ErrorsBreakdown ·
                        CrossValidation · WebSocketPanel · provider/ (PM* deep-dive)
      upstreams/        UpstreamsView (3 groupings) · RouterGroups ·
                        Add/Edit sheets · TestModal · catalog
      endpoints/        endpoint row model + IfaceTag + detail sheet — the
                        bits the "By router" grouping renders
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
| Errors (total, trend, per-chain/method/provider) | **Real, derived** — `round(clamp_min(total − success, 0))` = transport/routing failures (an upstream's JSON-RPC error reply counts as transport SUCCESS); node/protocol classes from `smartrouter_{node,protocol}_errors_total` once they fire |
| Cache, retries, hedge, cross-validation, node/protocol error counters, write/batch, websocket | **Absent until the feature fires** → nulls + `emitted:false`, then real. Cross-validation reads `…cross_validation_{requests,success,failed,failures}_total` (no bare `…_total` exists); ws totals are lifetime (counter-birth). See `docs/METRICS-MAPPING.md` → "Counter semantics" for relay-vs-client scoping (requests are CLIENT-scoped via the latency-histogram `_count`). |
| Compute-unit quota, RPS cap, regions, team members | **Magma Cloud concepts** — not metered here; pinned `null` (UI shows "not tracked") |

Chains are keyed by **Lava spec index** (the `spec` label: `ETH1`, `BASE`, …),
not a human chain id — resolve display metadata via `buildChainMetaByIndex`.

### Resyncing chains with lava-specs

Three committed files are generated from the lava-specs repo — the chain map,
the Try-it method catalog, and the roll-call of surfaces with no runnable
default (`apps/web/scripts/data/no-runnable-defaults.generated.json`). CI's
**Chain catalogs ↔ lava-specs drift** job regenerates all three and fails when
any is stale, so a resync means running both generators and committing the
result, never hand-editing.

The part that needs judgement is what happens after: the Try-it drawer opens
only on commands that can be sent AS-IS, so a chain family nobody has curated
hints for arrives with an empty default list. **Read
[`.claude/rules/chain-resync.md`](.claude/rules/chain-resync.md) before doing a
resync** — it covers the procedure, when hints are needed, and the rule that a
curated example must be fired against a real endpoint before it ships.

## Config passing (values file — BOTH formats)

The router's own config yaml is bind-mounted into the api at
`/app/helm-values/core/values.yml:ro` (override the dir with `HELM_VALUES_DIR`).
`ConfigurationService` detects and parses **either** supported format into
`RouterTopology[]` (`GET /api/config/routers`):

1. **Helm-chart values** — `routers:[{id, network, nodes:[{name, is_backup,
   endpoints:[{url, interface, addons}]}], custom_url_prefix?, pathBased?}]`,
   with `pathBased` resolved per-router against the global
   `miscellaneous.gateway.pathBased.enabled` default (chart semantics).
   Only this format can mark **backup** nodes, and only it yields
   **`publicUrls`** (below).
2. **Raw smart-router SR_CONFIG** — the YAML the router itself runs
   (`endpoints:` + `direct-rpc:`). Providers are grouped by chain-id into one
   router per chain; the `endpoints:` listen ports become **`localPorts`,
   keyed per api-interface** (one chain can expose several interfaces on
   different ports, e.g. LAVA rest:3360 + tendermintrpc:3361).

Detection is by key: `routers` ⇒ helm; `direct-rpc` ⇒ sr-config; anything else
yields an empty topology. **Node URLs are masked to scheme+host** — upstream
provider URLs routinely embed API keys in the path.

### Endpoint addresses (`publicUrls` vs. `localPorts`)

An endpoint's dialable address depends on which format is mounted, and the
Upstreams / Try-me surfaces resolve it in this order — **public
gateway URL → local listen port → nothing** (`"—"`, never a fabricated host):

- **Helm values** describe a k8s deployment with no listen ports at all, so
  `localPorts` is empty and **`publicUrls`** (api-interface → URL) carries the
  address. It mirrors the HTTPRoute / GRPCRoute hostname scheme those values
  describe, exactly:
  `<custom_url_prefix | id-lowered>` + `.<iface>.` (the default) or
  `-<iface>.` (`miscellaneous.gateway.hostStructure: chain-interface`) +
  `<base_domain>`, on the scheme/port of the Gateway's TLS listener (HTTP
  listener when there is no TLS one; non-default ports kept in the URL).
  Empty when the values publish nothing routable — `gateway.enabled: false`,
  no `base_domain`, or a listener list with nothing HTTP(S) on it.
- **SR_CONFIG** describes listen ports but nothing about ingress, so
  `publicUrls` is empty and `localPorts` carries `http://localhost:<port>`.

Websockets ride the **same** address as the base interface, path-scoped
(`/ws` for jsonrpc, `/websocket` for tendermintrpc) — a bare host handshake is
rejected 405. The values set no `appProtocol` on non-grpc ports, so the gateway
serves the HTTP/1.1 upgrade on the interface's own hostname.

**Several routers may serve one chain** (a staging + production pair on the
same `network`, distinguished by `id` / `custom_url_prefix`). Topology handles
that natively — separate cards, separate hostnames, and the router-grouped
card header appends the router id whenever a spec is duplicated. Metrics need the
router scope below, because the router labels its series with the chain, not
with itself.

### Two router axes (`?router=` vs. `?routerId=`)

"Router" means two things here, and the UI has one control for both:

| | `?router=` (scope) | `?routerId=` (config) |
|---|---|---|
| Identity | a value of `ROUTER_SCOPE_LABEL` — the collector's per-target label | an `id` from `GET /api/config/routers` |
| Comes from | Prometheus target labels | the mounted values file |
| Narrows | the PromQL, so **chain-level** series split per router | **rows** — which upstreams a response lists |
| Available | only when the collector labels targets per router (often not) | always, whenever a values file is mounted |
| Read by | every `/api/metrics/*` route | `/api/metrics/{upstreams,errors,block-heights}` |

Anything keyed per UPSTREAM can be attributed, because the config says which
router declares a node: the roster (`routerIds` on `UpstreamMetrics` — a LIST,
since two routers declaring one node name share one series, which the UI marks
rather than splitting) and the error hotspots (`?routerId=` on
`/api/metrics/errors`, which filters the (chain × upstream) pairs and leaves the
pivots alone) and the upstream tips on `/api/metrics/block-heights`. Anything
that aggregates BY CHAIN can't be: no series says which router served a request
— `smartrouter_latest_block` included, which is why that endpoint's `routers`
rows can only ever be split by the scope axis. So a router selection also sets the chain — a config
router serves exactly one — which narrows those panels as far as the data
honestly allows, and the UI states that a second router on the same chain is
counted in with it.

Web side, `useRouterFilter()` (`hooks/use-router-options.ts`) is the only place
a router selection is made: it sets the config id and, when that router maps to
a scrape target the collector actually reports, the scope too. The list is
narrowed by the chain filter, and `useChainFilter()` clears a router the new
chain excludes — the pair stays consistent without an effect watching for it.
`<RouterFilterSelect>` renders it next to `<ChainSelect>`, and hides itself only
when the deployment has fewer than two routers at all.

#### The scope label

`smartrouter_*` carries `spec` (the chain) and no router identity, so two
routers on one chain sum into a single set of numbers. What *does* separate
them is the collector: each router is its own scrape target, so Prometheus
attaches a per-target label — `service` under the Prometheus Operator, whose
value is the router's Service name (`<router-id-lowered>-router`).
`ROUTER_SCOPE_LABEL` names that label
(default `service`; use `job` for a scrape config that names jobs per router).

- **`GET /api/metrics/routers`** → `{ label, routers[] }` — the distinct
  values actually present. Empty means the collector attaches no such label
  (one static target, or a mislabelled `ROUTER_SCOPE_LABEL`): "can't split",
  never "no routers" — the config still knows the routers, which is why the
  filter is built on the config list and treats a scrape value as a bonus.
- **Every `/api/metrics/*` route takes `?router=<value>`**, including the raw
  `/query` passthrough. An absent or malformed value reads cluster-wide
  rather than silently becoming a different query.
- The scope is injected into the finished PromQL by `applyScope`
  (`packages/shared/src/promql/scope.ts`) rather than threaded through ~40
  builders: every vector selector gains the matcher. It is a small PromQL
  walker, not a regex — the naive version corrupts metric names quoted inside
  `{__name__="…"}` (the presence probes) and selectors that already carry
  labels. `cache_*` is deliberately left cluster-wide: the relay cache is a
  separate sidecar shared by every router, so it carries no router's label
  and scoping it would report a zeroed cache rather than an unattributable
  one.
- Web side: the scope lives in `FiltersProvider` next to the chain and the time
  window, in two lifetimes — **the window persists** (`sr:window`, a viewing
  preference), **the chain and the router belong to the page** that set them
  (in-memory, stamped with the pathname, gone when you navigate — a narrowing
  that outlives its screen is a trap). Every metrics URL appends `scopeQ` /
  `withScope(url)`. A selection that disappears from the list resets to "All
  routers" instead of silently filtering every panel to nothing.

### Shared filters and the health vocabulary

Two things every chain- or health-aware surface must go through, so the same
state can't be worded or sourced two ways:

- **`useChainOptions()`** (`hooks/use-chain-options.ts`) is the chain picker's
  only list: the UNION of the chains the mounted config declares and the chains
  the metrics report traffic for, each row flagged `inConfig` / `hasTraffic`. A
  page dims what it can't populate via `withMutedRows` (Metrics greys "no
  traffic yet", Upstreams greys "not in config") rather than hiding it, which
  would read as "not configured". The selection itself is `chain` on
  `FiltersProvider`, never page state.
- **`useRouterFilter()`** (`hooks/use-router-options.ts`) is the router
  filter's only entry point — one selection, both router axes (see "Two router
  axes"), chain-narrowed list, `routerId` on `FiltersProvider` (`sr:routerId`).
- **`lib/health.ts`** owns the words and colours for `HealthState`
  (`operational | unhealthy | unknown`) — **Operational / Unhealthy / —** — and
  `<HealthTag>` / `<HealthDot>` are how they reach the screen. `unknown` means
  "no metrics in this window", never "down", so it renders neutral. Nothing
  invents its own health vocabulary: four surfaces used to (the roster said
  "healthy / degraded", the deep-dive "Live · up", the drawer the raw wire
  word), and one upstream read three different ways depending on the panel.

### Deploying to Kubernetes

A Kubernetes deployment runs the api as the `…/backend` image and the web as
`…/frontend`. The contract it has to configure:

| | Value |
|---|---|
| Backend liveness / readiness | `/health` · `/health/ready` (**not** `/api/health` — that's the retired v1 path). Readiness pings Prometheus, so give it a timeout ≥3s and a failureThreshold >1, or a Prometheus blip evicts the only replica |
| Backend env | `PROMETHEUS_URL`, `CORS_ORIGINS` (comma list **or** JSON array), `HELM_VALUES_DIR` (default `/app/helm-values`, matching the values mount), `LOG_LEVEL`, `TENANT_ID`, `RATE_LIMIT_MAX`. No basic auth: `AUTH_USERNAME` / `AUTH_PASSWORD` / `DEBUG` / `CORS_ALLOW_CREDENTIALS` / `AUTH_GATEWAY_*` are v1-only and unread here |
| Frontend runtime env | `DASHBOARD_API_URL` (browser-facing api origin) and `DASHBOARD_GRAFANA_URL`, both read per-request by `GET /api/config` so one image serves any host. `NEXT_PUBLIC_*` are build-time and can't vary per deployment |
| Frontend liveness / readiness | `/api/config` (`/` also answers — it 307s to `/metrics`) |
| Values mount | `<HELM_VALUES_DIR>/core/values.yml`, the rendered values. Drives `publicUrls` above, so the pod must roll when they change |

## Time windows

`packages/shared/src/constants/windows.ts` defines the **13-window catalog**
(`5m 15m 30m 1h 3h 6h 12h 1d 3d 7d 14d 21d 30d`), each with a PromQL range and
a step targeting ~150–200 range points (clamped to ≥15s, the scrape interval).
Every `window=` query param accepts those keys **plus the `24h` alias (= `1d`)**;
anything else falls back to the default `30m`. The page-level `<select>` shows
the design's 12 options (`WINDOW_OPTIONS` — everything except `1h`, which the
Dashboard page's chip row uses internally).

## API endpoints

All endpoints return `application/json`. With `AUTH_MODE=disabled` (default)
every route is public; with `AUTH_MODE=enabled` the `/api/*` routes require a
valid Bearer JWT (health/version and `/auth/*` stay public). See [`docs/AUTH.md`](docs/AUTH.md).

Every `/api/metrics/*` route also accepts **`router?`** — the router scope
(see "Router scope" above); omitted = cluster-wide.

| Endpoint | Params | Returns |
|---|---|---|
| `GET /docs` · `GET /docs/json` | — | Swagger UI explorer + OpenAPI 3.1 spec. Registered outside production only. |
| `GET /health` | — | Liveness — `{ health: "ok" }` |
| `GET /health/ready` | — | Readiness — runs `vector(1)` against the store (not `-/ready`, which Mimir and a query-only proxy don't serve) with the configured credential; 503 + `components.prometheus:"ping_failed"` on failure, including a 401 |
| `GET /version` | — | Build provenance — `{ commit, version, env, startedAt, uptimeSec }` |
| `GET /api/metrics/routers` | — | `{ label, routers: string[] }` — router deployments the metrics can be scoped to (distinct values of `ROUTER_SCOPE_LABEL`). `[]` when the collector can't tell routers apart. See "Router scope" |
| `GET /api/metrics/specs` | `router?` | `{ specs: string[] }` — distinct chains present on the requests counter |
| `GET /api/metrics/dashboard-summary` | `window` | `HeroSummary` — the six hero cards as `Kpi` `{value, prior}` pairs (`requestsServed`, `successRate`, `effectiveReadP95Ms`, `staleCaught`, `retriesRecovered`, `cacheOffloadPct`) + `providerCount` / `chainCount` / `health` + **`emitted: {retries, cache}`** |
| `GET /api/metrics/overview` | `window`, `spec?` | `OverviewData` — KPI pairs (requests, RPS, errors, success rate, p50/p95/p99), `errorRate`, `health`, throughput/errors series, `latencySeries` (p50/p95/p99 toggle), **`latencyDistribution`** (histogram buckets), **`perProviderSeries`**, **`errorLayers`** (single `unclassified` layer until labelled counters exist), `perChainLatency`, `activeRoutes`, `perChainSeries`; `computeUnits`/`rpsCap` always null |
| `GET /api/metrics/dashboard` | `window`, `spec?` | `DashboardData` — the Dashboard page (both tabs) in one round-trip: `kpis` (successRate, p95Ms, errors, rps, errorsHandled=null), `series` (throughput, errors, errorRate, successRate, latency p50/95/99, perChain, perChainSuccessRate, perChainLatency, providerMix, perProviderLatencyP95), `chains` (multiselect options — the series filter is client-side; `spec` accepted for symmetry). Unbacked families (`scu`, `regions`, `failoverRatio`, `internalAvailability`, `cacheHitRate`, `errorClasses`, `errorsHandledBreakdown`, `contribution`, `providerAvailability`, `scorecard`) are `null`, `trouble` is `[]` |
| `GET /api/metrics/routers-rollup` | `window` | `{ routers: RouterMetrics[] }` — **the Routers table: one row per CONFIG router**, not per chain. `ChainMetrics` plus `routerId`, `upstreamCount` (from the values file, so always the router's own) and `attribution`: `own` when the collector reports a target label for it (the chain-level numbers were re-read through that label) or when it is alone on its chain, `shared` otherwise — in which case `sharedWith` names the siblings reading the same series, and the rows deliberately carry identical figures. Falls back to one row per chain when no values file is mounted |
| `GET /api/metrics/chains` | `window` | `{ chains: ChainMetrics[] }` — per-chain rollup (requests, availability, errorRate, p95, composite QoS, health, latestBlock, providerCount) for the Routers table |
| `GET /api/metrics/upstreams` | `window`, `spec?`, **`routerId?`** | `{ upstreams: UpstreamMetrics[] }` — roster with requests, uptime, p95, **errorRate**, selection scores, health, latestBlock, **blockLag**, **`behindSec`** (that lag ÷ the chain's block rate — the comparable form) + **`stale`** (tip frozen 15m while the chain produced blocks), **role** (`primary`/`backup` from helm `is_backup`; null for SR_CONFIG), **apiInterface**, inFlight, **`routerIds`** (the config routers declaring the upstream — several when they share a node name). `routerId` keeps only one router's rows; it filters against the values file and does NOT narrow the PromQL (that's `router` — see "Two router axes") |
| `GET /api/metrics/block-heights` | `spec?`, `router?`, **`routerId?`** | `BlockHeights` — `{ routerLabel, chains: ChainTips[] }`. Per chain: `blocksPerSec` (from `deriv` on the endpoint gauge), `bestBlock` (highest upstream tip — the reference), `routers[]` (`smartrouter_latest_block` per scope value × api interface, each with `behindBlocks` / `behindSec` / **`refreshSec`**) and `upstreams[]` (`rpc_endpoint_latest_block` per endpoint × interface, with `stale`). **Instant only** — gauges, so no `window`. Lags are given in seconds as well as blocks because a block count isn't comparable across chains. ⚠ The router gauge advances on accepted tip observations, not every poll, so it trails by ~one `refreshSec` however healthy the router is; judge it against that cadence, never a wall-clock threshold |
| `GET /api/metrics/rps` | `window`, `spec?` | `TimeSeries` — `{ label, points: {t, v}[] }` |
| `GET /api/metrics/traffic` | `window` | Aggregate `rpsNow` + series + per-chain rows (`rpsNow`, `requests`, `share`, `trend` sparkline). **No web consumer** — the Traffic tab's RPS card was removed in MAG-2448; kept as a documented read surface |
| `GET /api/metrics/methods` | `window`, `spec?` | `{ methods: MethodUsage[], classTotals: MethodClassTotals }` — per-method CLIENT requests/class/errorRate + **real `p95Ms`** (the histogram's method label is named `function`); classTotals: `read` real, `write`/`batch` null + `emitted` flags, `unclassified` remainder |
| `GET /api/metrics/chain-series` | **`spec`** (required), `window` | `ChainSeries` — the ChainDetail metric-switcher bundle: availability / p95 / errorRate / rps series + `qos` (optimizer-scope score, endpoint-scope fallback; null when never emitted) + `backupShare` (only when the config marks backups **and** the selector actually matched — an unmatched selector is `null`, never a 0% series; the UI states it as **primary** share). 400 without `spec` |
| `GET /api/metrics/provider-detail` | **`endpointId`** (required), `window` | `ProviderDetail` — PMBody deep-dive: health, availability, requests, rpsNow, p50/95/99, errorRate, blockLag, inFlight, score gauges + per-score-type series, latency/volume/block-lag series (`volume.read` real; write/batch null); `errorsByCode`/`recentErrors` empty + `emitted` flags. 400 without `endpointId` |
| `GET /api/metrics/errors` | `window`, `spec?` | `ErrorsReport` — derived `total` + `trend`, (chain × provider) **hotspots** (trend sparklines for the top 5), chain/method **pivots**; `category`/`code`/`retryability` pivots stay `[]` until labelled error counters exist (**`families`** presence flags) |
| `GET /api/metrics/unavailable` | — | `{ unavailable: UnavailableChain[] }` — chains whose **every** backing endpoint reports down (`sinceSeconds` null for now) |
| `GET /api/metrics/cross-validation` | `window` | `CrossValidationReport` — `emitted:false` + nulls until `cross_validation_*` fires; **`consistency` (total/caught) is real either way**, but **no web consumer** since MAG-2527 removed the strip that rendered it (consistency checks are head-freshness verification, not cross-validation). `caught` still surfaces as the hero's `staleCaught` |
| `GET /api/metrics/websocket` | `window` | `WebSocketReport` — `emitted:false` + nulls until `ws_*` fires (first subscription) |
| `GET /api/metrics/query` | **`query`** (required) | Raw **instant** PromQL passthrough — `{ result }`. 400 without `query` |
| `GET /api/config/routers` | — | `{ routers: RouterTopology[] }` — live topology from the mounted values file (either format), node URLs masked to scheme+host. Each endpoint also carries `index` (the handle the relay below resolves) + `directable` |
| `POST /api/upstreams/relay` | body: `{routerId, node, endpointIndex, transport?, httpMethod?, path?, body?}` | Fires ONE request straight at a configured upstream, router excluded — `{httpStatus, latencyMs, body, truncated, transport}`. The target is resolved from the values file, never taken from the caller; the resolved url is never returned and is scrubbed out of the upstream's own body. Upstream 4xx/5xx come back **200** with their status inside; 502/504 mean our hop failed. Off with `UPSTREAM_RELAY_ENABLED=false`. See [`docs/UPSTREAM-DIRECT-TEST.md`](docs/UPSTREAM-DIRECT-TEST.md) |

## Environment variables

API (`apps/api/src/config.ts` is the source of truth):

| Variable | Default | Notes |
|---|---|---|
| `API_PORT` | `8000` | |
| `API_HOST` | `0.0.0.0` | |
| `PROMETHEUS_URL` | `http://localhost:9090` | compose sets `http://prometheus:9090` |
| `PROMETHEUS_TIMEOUT_MS` | `10000` | per-query abort |
| `PROMETHEUS_USERNAME` / `PROMETHEUS_PASSWORD` | unset | Basic auth on every Prometheus call — for a per-tenant read proxy or Mimir behind an auth gateway. Both or neither: one half alone sends no header |
| `PROMETHEUS_ORG_ID` | unset | Sent as `X-Scope-OrgID`, for a multi-tenant store that takes the org from the client. The fleet's read proxy pins the org from the credential and ignores this |
| `ROUTER_SCOPE_LABEL` | `service` | Target label carrying the router identity for `?router=` (Prometheus Operator's `service`; `job` for a per-router scrape config). Parsed at import — a change needs a restart |
| `CORS_ORIGINS` | all | comma list or JSON array |
| `RATE_LIMIT_MAX` | `300` | per IP per minute |
| `HELM_VALUES_DIR` | `/app/helm-values` | reads `<dir>/core/values.yml` (either format) |
| `UPSTREAM_RELAY_ENABLED` | `true` | `false` 404s `POST /api/upstreams/relay`. With `AUTH_MODE=disabled` anyone who can reach the api can spend the operator's upstream quota through it, using credentials only the api holds — turn it off where that isn't acceptable |
| `UPSTREAM_RELAY_TIMEOUT_MS` | `10000` | deadline on the api→upstream call |
| `UPSTREAM_RELAY_MAX_BODY_BYTES` | `262144` | upstream responses past this come back `truncated: true` |
| `UPSTREAM_RELAY_RATE_LIMIT_MAX` | `20` | per IP per minute, tighter than `RATE_LIMIT_MAX` |
| `LOG_LEVEL` | `info` | |
| `TENANT_ID` | `default` | parsed, reserved — not read by any route yet |
| `GIT_COMMIT` / `APP_VERSION` | `unknown` / `0.0.0` | surfaced by `/version` |
| `NODE_ENV` | `production` | non-prod enables `/docs` + pretty logs |

Auth (only read when `AUTH_MODE=enabled`; the metrics path never touches the DB):

| Variable | Default | Notes |
|---|---|---|
| `AUTH_MODE` | `disabled` | `enabled` turns on the JWT gate + `/auth/*` + Postgres |
| `AUTH_SECRET` | (unset) | HS256 signing secret shared with the web (must match) |
| `DATABASE_URL` | (unset) | Postgres connection string for the `users` table |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | (unset) | idempotent bootstrap-admin seed on first boot |
| `GOOGLE_CLIENT_ID` | (unset) | validates the `aud` claim of Google ID tokens server-side |

Web — build-time vs. **runtime**:

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | baked into the bundle at **build** time |
| `NEXT_PUBLIC_LOCAL_MODE` | `false` | build-time default for the `localMode` flag |
| `DASHBOARD_API_URL` | (unset) | **runtime** override — read from the container env per-request by `GET /api/config`, so one published image serves any host |
| `DASHBOARD_LOCAL_MODE` | (unset) | runtime override of `localMode`, same mechanism |
| `DASHBOARD_GRAFANA_URL` | `http://localhost:3001` | Grafana base URL the "View full logs" button links to — runtime override via `/api/config`, same mechanism (falls back to `NEXT_PUBLIC_GRAFANA_URL`) |
| `AUTH_MODE` / `AUTH_SECRET` | `disabled` / (unset) | must match the api; `enabled` renders the login page + edge gate |
| `INTERNAL_API_BASE_URL` | (falls back to api url) | server-side api URL for Auth.js callbacks (compose sets `http://api:8000`) |
| `{GOOGLE,GITHUB,DISCORD}_CLIENT_{ID,SECRET}` | (unset) | each provider's button appears only when its id+secret pair is set |

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
| Window params | `24h` is a wire alias of `1d`; unknown values silently fall back to `DEFAULT_WINDOW` = `30m` (never a 400). The web opens on the same constant, and a window the user picks persists to `localStorage` under `sr:window` — so a changed default only reaches someone who has never picked one. `1h` is in the catalog but not in the page-level select. |
| Provider `role` | Only the helm values format marks backups (`is_backup`); with a raw SR_CONFIG mount, `role` is null and backup-share panels stay empty — that's honest, not a bug. |
| Endpoint URLs | `localhost:<port>` comes from SR_CONFIG's listen ports, gateway hostnames from helm values' `publicUrls` — a mount never has both. Anything that renders or dials an endpoint address must resolve public → local → `—` (`epHttpUrl` / `epWsUrl` in `components/endpoints/bits.tsx`), never hardcode `localhost`. |
| Health words | `HealthState` has exactly three states and exactly one wording — `lib/health.ts` / `<HealthTag>`. A panel that maps health to its own labels/colours is a bug, even when the words look nicer locally: the same upstream is read across panels. |
| BuildKit cache | `make build*` targets use the isolated `srdash-builder` (see Docker / images / isolation). Plain `docker compose up --build` is fine for the stack itself. |
