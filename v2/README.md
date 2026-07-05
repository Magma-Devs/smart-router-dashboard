# Smart Router Dashboard — v2

A Prometheus-driven observability dashboard for the Magma Devs **Smart Router**,
rebuilt as a pnpm/TypeScript monorepo (Fastify API + Next.js 16 web + shared
package) to the engineering standard of `lava-connect`, with the UI built 1:1
to the `../SR_Dashboard/` design prototype. No database, **no auth** — every
value on screen maps to a real Prometheus series or renders an honest empty
state.

Coexists with the legacy Python/Next stack in the parent repo (`../backend`,
`../frontend`); v2 is self-contained under this directory.

## Run the full stack — one command

The compose file is **self-contained**: bundled Prometheus + a `router`
profile that builds the Smart Router from a checkout (`ROUTER_DIR`, default
`~/projects/smart-router`).

```bash
make up      # router + Prometheus + api (:8000) + web (:3000), detached
make ps      # show what's running
make down    # stop everything

# equivalently, without make:
docker compose --profile router up --build   # everything from nothing
docker compose up --build                    # dashboard + Prometheus only
                                             # (a router already runs on the host's :7779)
```

UI → http://localhost:3000 · API → http://localhost:8000 ·
Prometheus → http://localhost:9090 · router ETH1 → http://localhost:3360

**One values file drives both the router and the dashboard**: `SR_CONFIG_HOST`
(default `./dev-config/values.yml`) is mounted as the router's config AND as
the api's helm-values, so Endpoints/Providers always reflect the running
topology. It can be either format the api understands — a raw smart-router
SR_CONFIG or helm-chart values.

Prebuilt images are published to
`ghcr.io/magma-devs/smart-router-dashboard/{api,web}`; set `DASHBOARD_API_URL`
on the web container at runtime to point one published image at any api host.

## Develop

```bash
make dev            # hot-reload docker stack (api tsx watch · web next dev · shared tsc --watch)

# or on the host (Node 22 + pnpm 10, needs a Prometheus at PROMETHEUS_URL):
pnpm install
pnpm --filter @sr/shared build
pnpm dev            # api :8000, web :3000
pnpm typecheck && pnpm test
```

See **[CLAUDE.md](CLAUDE.md)** for the endpoint reference, env vars, and gotchas.
For the metric catalog, per-endpoint PromQL, and gap analysis, see
**[docs/METRICS-MAPPING.md](docs/METRICS-MAPPING.md)**.

## Pages

No sign-in — the app opens straight on Overview.

- **Overview** — KPI strip (requests, RPS, errors, success rate, latency) + 2×2 chart grid, all live
- **Dashboard** — ops surface with two tabs (Overview / Metrics) fed by one `/api/metrics/dashboard` round-trip; 1h/3h/24h/7d/custom chips, client-side chain multiselect
- **Providers** — provider cards from the mounted config joined with live per-endpoint stats (selection scores, block lag, error rate)
- **Endpoints** — chain-grouped endpoint cards (one per router × interface) from the mounted values file
- **Metrics** — four tabs: **Overview** (hero cards + currently-unavailable strip + per-chain Routers table with expandable series), **Providers** (roster + per-provider deep-dive), **Errors breakdown** (hotspots + pivots), **Traffic** (usage, cross-validation, WebSocket, method breakdown)
- **Live test** — POST a request straight to the router's local listen port from the browser; inspect status/latency/response
- **Team / Account** — design chrome with honest self-hosted states; Account shows real `/version` build provenance
- **/standalone** — the Metrics page without the sidebar/topbar shell, for sharing or embedding

Panels backed by metric families the router hasn't emitted yet (cache, retries,
cross-validation, WebSocket, labelled error codes, write/batch) render the
design's own empty states and light up automatically once the family appears.
