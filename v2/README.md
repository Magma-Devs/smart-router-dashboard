# Smart Router Dashboard — v2

A Prometheus-driven observability dashboard for the Magma Devs **Smart Router**,
rebuilt as a pnpm/TypeScript monorepo (Fastify API + Next.js 16 web + shared
packages) to the engineering standard of `lava-connect`, with the UI built 1:1
to the `../SR_Dashboard/` design prototype. Every value on screen maps to a
real Prometheus series or renders an honest empty state. Auth is **optional**:
`AUTH_MODE=disabled` (default) is the zero-dependency open dashboard;
`AUTH_MODE=enabled` adds Auth.js sign-in backed by Postgres — see
[docs/AUTH.md](docs/AUTH.md).

Coexists with the legacy Python/Next stack in the parent repo (`../backend`,
`../frontend`); v2 is self-contained under this directory.

## Two stacks: `make up` (prod-style) vs `make dev` (hot-reload)

There are two self-contained compose files, wrapped by the Makefile so you
never type the `-f` flag:

| | `make up` → `docker-compose.yml` | `make dev` → `docker-compose.dev.yml` |
| --- | --- | --- |
| **api / web** | built from their real Dockerfiles (production images) | one `Dockerfile.dev` image + `pnpm dev` |
| **your code** | baked into the image (rebuild to change) | **mounted from the host — hot reloads** |
| **use it for** | GHCR-parity / "does the real image work" | day-to-day development |

The **router** and **Prometheus** services are identical in both. The router
**pulls the published image** (`ghcr.io/magma-devs/smart-router:latest`) and
loads specs straight from the **lava-specs GitHub repo** — no smart-router
checkout, no volume mount.

Both stacks bind the same host ports (3000 / 8000 / 9090 / 3360-3367, plus
3100 / 3001 with the `logs` profile), so run **one at a time** — `make down` /
`make dev-down` before switching.

### Prod-style stack

```bash
make up      # router + Prometheus + api (:8000) + web (:3000), detached
make ps      # show what's running
make down    # stop everything

# equivalently, without make:
docker compose --profile router up --build   # everything from nothing
docker compose up --build                    # dashboard + Prometheus only
                                             # (a router already runs on the host's :7779)
```

### Hot-reload dev stack

```bash
make dev            # api tsx watch · web next dev · shared tsc --watch (foreground)
make dev-down       # stop it

# or on the host (Node 24 + pnpm 10, needs a Prometheus at PROMETHEUS_URL):
pnpm install
pnpm --filter @sr/shared build && pnpm --filter @sr/db build
pnpm dev            # api :8000, web :3000
pnpm -r typecheck && pnpm -r test
```

### With authentication

```bash
make dev-auth       # hot-reload stack + login (dev seed: admin@example.com / admin1234)

# prod-style (no dev defaults — bring your own secrets):
AUTH_SECRET=$(openssl rand -base64 32) ADMIN_EMAIL=you@example.com \
ADMIN_PASSWORD=change-me make up-auth
```

Email+password always; Google / GitHub / Discord buttons appear on the login
page automatically when their `*_CLIENT_ID`/`*_CLIENT_SECRET` pairs are set.
Full guide: [docs/AUTH.md](docs/AUTH.md).

### With logs (Loki + Grafana)

An opt-in `logs` profile adds **Loki + Promtail + Grafana** that capture the
stack's container logs (router / api / web / prometheus) and show them in a
pre-provisioned Grafana board — Promtail parses the router's zerolog JSON so
`level` is a queryable label. Nothing else changes; discovery is via Docker
labels.

```bash
make dev-logs   # hot-reload stack + logs (foreground)
make up-logs    # prod-style stack + logs (detached)

# equivalently, without make:
docker compose -f docker-compose.dev.yml --profile router --profile logs up --build
docker compose --profile router --profile logs up --build   # prod-style
```

Grafana → http://localhost:3001 (`admin` / `admin`), opens on **"Smart Router
Dashboard Logs"**. Loki API → http://localhost:3100. Grafana is on **:3001**
(not :3000) on purpose — the web UI owns :3000, so logs run alongside it. The
`logs` profile composes with `auth` too (`--profile auth --profile logs`).

UI → http://localhost:3000 · API → http://localhost:8000 ·
Prometheus → http://localhost:9090 · router → http://localhost:3360-3367
(3360 ETH1 · 3361 SOLANA · 3362 BTC · 3363 HYPERLIQUID · 3364-3366 COSMOSHUB
rest/tendermint/grpc · 3367 APT1)

**One values file drives both the router and the dashboard**: `SR_CONFIG_HOST`
(default `./dev-config/values.yml` — a multichain + cross-validation config)
is mounted as the router's config AND as the api's helm-values, so
Endpoints/Providers always reflect the running topology. It can be either
format the api understands — a raw smart-router SR_CONFIG or helm-chart values.

**Override the defaults** (each has a fallback in the compose file, so unset =
normal path):

```bash
SR_CONFIG_HOST=./dev-config/other.yml make dev   # different values file
SR_SPEC=./local-specs make dev                   # local spec dir instead of GitHub
SR_SPEC=https://github.com/OWNER/REPO/tree/BRANCH make up   # a different spec repo
SR_GITHUB_TOKEN=ghp_xxx make dev                 # PAT for GitHub spec fetch (see below)
```

`SR_GITHUB_TOKEN` is passed to the router's `--github-token`: it authenticates
the GitHub spec fetch (`SR_SPEC` GitHub URLs), lifting the API rate limit from
60 to 5,000 req/hour and unlocking private spec repos. **Empty by default** —
unset, the router fetches public specs unauthenticated; set it only if you hit
GitHub rate limits or point `SR_SPEC` at a private repo.

Prebuilt dashboard images are published to
`ghcr.io/magma-devs/smart-router-dashboard/{api,web}`; set `DASHBOARD_API_URL`
on the web container at runtime to point one published image at any api host.
Likewise `DASHBOARD_GRAFANA_URL` sets where the **"View full logs"** button
links — it defaults to the bundled `logs` profile's Grafana (`:3001`); point it
at your Grafana origin in a real deployment (read at runtime via `/api/config`,
so no rebuild needed).

See **[CLAUDE.md](CLAUDE.md)** for the endpoint reference, env vars, and gotchas.
For the metric catalog, per-endpoint PromQL, and gap analysis, see
**[docs/METRICS-MAPPING.md](docs/METRICS-MAPPING.md)**.

## Pages

In the default `AUTH_MODE=disabled` the app opens straight on Overview; with
auth enabled, `/login` gates everything.

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
