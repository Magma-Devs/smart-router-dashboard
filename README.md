<div align="center">

<a href="https://github.com/Magma-Devs/smart-router-dashboard" target="_blank" rel="noopener noreferrer">
  <img
    src="./docs/assets/banner.svg"
    alt="Smart Router Dashboard — Prometheus-driven observability for the Smart Router"
    width="100%"
    style="cursor: pointer;"
  >
</a>

# Smart Router Dashboard

[![Quality Gate](https://github.com/Magma-Devs/smart-router-dashboard/actions/workflows/quality-gate.yml/badge.svg?branch=main)](https://github.com/Magma-Devs/smart-router-dashboard/actions/workflows/quality-gate.yml)
[![Release](https://img.shields.io/badge/release-v0.4.1-brightgreen)](https://github.com/Magma-Devs/smart-router-dashboard/releases/latest)
[![Node](https://img.shields.io/badge/node-24%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-source--available-orange.svg)](LICENSE.md)

</div>

The observability dashboard for the [Smart Router](https://github.com/Magma-Devs/smart-router) — every value on screen maps to a real Prometheus series or renders an honest empty state. No invented numbers, ever.

<div align="center">

[Quick Start](#quick-start) · [How it works](#how-it-works) · [Pages](#pages) · [Authentication](#authentication) · [Development](#development) · [Releases](#releases--images) · [License](#license) · [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

</div>

---

## What is Smart Router Dashboard

- **Live metrics, honestly sourced** — KPIs, RPS, latency, error breakdowns, provider selection scores: all straight from the router's `smartrouter_*` / `rpc_endpoint_*` Prometheus families. Metric families the router hasn't emitted yet render the design's own empty states and light up automatically when they appear.
- **Topology-aware** — one values file drives both the router and the dashboard, so the Endpoints/Providers pages always reflect the running configuration.
- **Live test console** — fire requests at any chain × interface the router serves, straight from the browser, with a full method catalog generated from the [lava-specs](https://github.com/Magma-Devs/lava-specs) repo (126 chains, jsonrpc/rest/tendermint/grpc, archive/debug/trace tiers).
- **Self-contained** — `make up` gives you router + Prometheus + api + web from nothing. No accounts, no cloud, optional auth.
- **Optional authentication** — `AUTH_MODE=enabled` adds Auth.js sign-in (email+password + Google/GitHub/Discord) backed by Postgres. Default is open (`disabled`) for private deployments.

> **Repo layout:** a pnpm/TypeScript monorepo — `apps/api` (Fastify 5 Prometheus proxy) + `apps/web` (Next.js 16) + `packages/shared` + `packages/db`. Everything runs from the repo root.

## Quick Start

```bash
make up        # router + Prometheus + api (:8000) + web (:3000) + logs (Grafana :3001), detached
make up-cache  # ...plus the smart-router cache sidecar (:20100, metrics :5555)
make ps        # show what's running
make down      # stop everything
```

UI → http://localhost:3000 · API → http://localhost:8000 · Prometheus → http://localhost:9090 ·
router → http://localhost:3360-3367 (ETH1 · SOLANA · BTC · HYPERLIQUID · COSMOSHUB rest/tendermint/grpc · APT1)

The router pulls the published image (`ghcr.io/magma-devs/smart-router:latest`) and loads chain specs straight from the [lava-specs](https://github.com/Magma-Devs/lava-specs) GitHub repo — no checkout, no volume mounts. The default config is multichain with cross-validation policies enabled; see [`dev-config/values.yml`](./dev-config/values.yml).

With a router already running on the host's `:7779`:

```bash
docker compose up --build     # dashboard + Prometheus only
```

### Relay cache (optional)

The stack can run the smart-router's RAM relay **cache** sidecar (mirrors
`smart-router/docker/docker-compose.cache.yml`). It's opt-in behind the `cache`
profile and off by default:

```bash
make up-cache
# or: SR_CACHE_BE=cache:20100 docker compose --profile router --profile cache up --build
```

`make up-cache` wires the router to the cache via the `--cache-be` flag
(`SR_CACHE_BE=cache:20100`) — no `values.yml` edit needed. The cache listens on
`:20100` and exposes its own Prometheus metrics on `:5555` (scraped as the
`smart-router-cache` job). With the profile off, `SR_CACHE_BE` is empty and the
router uses its in-process cache.

## How it works

```
┌─────────────────┐        ┌──────────────────────┐        ┌──────────────┐
│   apps/web      │  REST  │      apps/api        │ PromQL │  Prometheus  │
│   Next.js 16    │───────▶│  Fastify 5 (:8000)   │───────▶│   (:9090)    │
│   (:3000)       │        │  stateless proxy —   │        └──────┬───────┘
│                 │        │  every endpoint maps │               │ scrape
│  SWR-style      │        │  to real PromQL      │        ┌──────┴───────┐
│  hooks + charts │        └──────────┬───────────┘        │ Smart Router │
└─────────────────┘                   │ reads              │  (:7779)     │
                                      ▼                    └──────────────┘
                            mounted values.yml
                       (same file drives the router)
```

- The api is a **stateless Prometheus proxy** — no database on the metrics path, per-route caching, unbacked values returned as `null` (never invented).
- The web is **runtime-configurable** — one published image points at any api host via `DASHBOARD_API_URL`.
- `AUTH_MODE=enabled` adds a Postgres users store + HS256 JWT gate on `/api/*` — see [Authentication](#authentication).

## Pages

- **Overview** — KPI strip (requests, RPS, errors, success rate, latency) + chart grid, all live
- **Dashboard** — ops surface, 1h/3h/24h/7d/custom windows, client-side chain multiselect
- **Providers** — provider cards from the mounted config joined with live per-endpoint stats
- **Endpoints** — chain-grouped endpoint cards from the values file
- **Metrics** — four tabs: Overview, Providers deep-dive, Errors breakdown, Traffic
- **Live test** — POST straight to the router's listen ports from the browser; full per-chain method catalog with archive/debug/trace tiers
- **/standalone** — the Metrics page without the shell, for sharing or embedding

## Authentication

Two modes via `AUTH_MODE` (full guide: [`docs/AUTH.md`](./docs/AUTH.md)):

- **`disabled`** (default) — no login, no database. The dashboard opens straight on Overview. For private/self-hosted deployments.
- **`enabled`** — Auth.js v5 sign-in backed by Postgres (Drizzle), bcrypt credentials + optional Google/GitHub/Discord (each button appears only when its client id/secret pair is set), HS256 JWT shared between web and api, idempotent `ADMIN_EMAIL`/`ADMIN_PASSWORD` bootstrap seed.

```bash
AUTH_MODE=enabled AUTH_SECRET=$(openssl rand -base64 32) \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me \
  docker compose --profile router --profile auth up -d --build
# sign in at :3000/login with ADMIN_EMAIL / ADMIN_PASSWORD
# (the dev compose ships working defaults — see docs/AUTH.md)
```

## Development

```bash
make dev            # hot-reload docker stack (api tsx watch · web next dev · shared tsc --watch)

# or on the host (Node 24 + pnpm 10, needs a Prometheus at PROMETHEUS_URL):
cp .env.example .env   # optional — every var has a compose default
pnpm install
pnpm --filter @sr/shared build && pnpm --filter @sr/db build
pnpm dev            # api :8000, web :3000
pnpm -r typecheck && pnpm -r test
```

The repo pins Node via [`.nvmrc`](./.nvmrc) (`nvm use`) and ships an
[`.env.example`](./.env.example) documenting every runtime knob — copy it to
`.env` for host dev, or read it as the reference for self-hosting one published
image against your own router.

Project structure:

```
apps/
  api/            Fastify 5 REST api — Prometheus proxy + optional auth
  web/            Next.js 16 App Router frontend
packages/
  shared/         Domain types, PromQL builders, constants
  db/             Drizzle schema + Postgres client (AUTH_MODE=enabled only)
dev-config/       values.yml driving both router and dashboard
docs/             AUTH.md · METRICS-MAPPING.md
docker-compose.yml / docker-compose.dev.yml / Makefile
```

See [`CLAUDE.md`](./CLAUDE.md) for the endpoint reference, env vars, and gotchas.

## Testing & CI

```bash
pnpm lint            # eslint (flat config) across the whole monorepo
pnpm -r typecheck    # strict TS across every package
pnpm -r test         # vitest — api routes, PromQL builders, config parser, auth, chain catalog
pnpm format          # prettier --write (format:check to verify only)
```

Every push and PR to `main` runs the [Quality Gate](.github/workflows/quality-gate.yml):
lint + typecheck + the full vitest suite, plus a **chain-map drift check** that
regenerates the chain catalog from the live [lava-specs](https://github.com/Magma-Devs/lava-specs)
repo and fails if the committed map is stale. Renovate-style dependency bumps
arrive via [Dependabot](.github/dependabot.yml) (npm + GitHub Actions, weekly).

When `NODE_ENV` isn't `production`, the api also serves an interactive
**OpenAPI 3.1 explorer at [`/docs`](http://localhost:8000/docs)** (raw spec at
`/docs/json`) covering every api route — see [`CLAUDE.md`](./CLAUDE.md) for the
full endpoint reference.

## Releases & images

Changes are tracked in [CHANGELOG.md](./CHANGELOG.md). Versioning is driven by the root [`VERSION`](./VERSION) file: pushes to `main` run the
[Build and Push Images](.github/workflows/build-and-push.yml) workflow, which tags and publishes

- `ghcr.io/magma-devs/smart-router-dashboard/backend` — the Fastify api (`apps/api`)
- `ghcr.io/magma-devs/smart-router-dashboard/frontend` — the Next.js web (`apps/web`)

Set `DASHBOARD_API_URL` on the web container at runtime to point one published image at any api host.

```bash
docker pull ghcr.io/magma-devs/smart-router-dashboard/backend:latest
docker pull ghcr.io/magma-devs/smart-router-dashboard/frontend:latest
```

## Security

See [SECURITY.md](./SECURITY.md). Do not open public issues for vulnerabilities — email <security@magmadevs.com>.

## License

Dual-licensed: **noncommercial use** is free under the [PolyForm Noncommercial License 1.0.0](./LICENSE.md); **commercial use** requires a separate [Magma Devs Enterprise License](./LICENSING.md) — contact <sales@magmadevs.com>.

## Community

- [Issues](https://github.com/Magma-Devs/smart-router-dashboard/issues) — bugs and feature requests
- [Smart Router](https://github.com/Magma-Devs/smart-router) — the router this dashboard observes
