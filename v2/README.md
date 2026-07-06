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

Both stacks bind the same host ports (3000 / 8000 / 9090 / 3360-3367), so run
**one at a time** — `make down` / `make dev-down` before switching.

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
```

Prebuilt dashboard images are published to
`ghcr.io/magma-devs/smart-router-dashboard/{api,web}`; set `DASHBOARD_API_URL`
on the web container at runtime to point one published image at any api host.

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
