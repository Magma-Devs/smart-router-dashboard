# Smart Router Dashboard — v2

A Prometheus-driven observability dashboard for the Magma Devs **Smart Router**,
rebuilt as a pnpm/TypeScript monorepo (Fastify API + Next.js 16 web + shared
package) to the engineering standard of `lava-connect`.

Coexists with the legacy Python/Next stack in the parent repo (`../backend`,
`../frontend`); v2 is self-contained under this directory.

## Run the full stack — one command

```bash
make up      # router + Prometheus + api (:8000) + web (:3000)
make ps      # show what's running
make down    # stop the dashboard (leaves the router up)
```

`make up` brings up the router + Prometheus (from `~/projects/smart-router`),
builds the images **on an isolated BuildKit builder**, and starts the api + web.

> Why not plain `docker compose up --build`? On a Docker daemon shared with
> other projects (common in this workspace), BuildKit's shared cache can serve
> the wrong project's `package.json` (`ERR_PNPM_OUTDATED_LOCKFILE` mentioning
> `@info/shared`). `make up` uses a dedicated builder (`srdash-builder`) with a
> clean cache, so the build is deterministic. Use `make` here.

## Develop (host, hot reload)

```bash
pnpm install
pnpm --filter @sr/shared build
pnpm dev            # api :8000, web :3000  (needs Node 22+)
pnpm typecheck && pnpm test
```

See **[CLAUDE.md](CLAUDE.md) → Quick start** for details.
For the metric catalog and gap analysis, see **[docs/METRICS-MAPPING.md](docs/METRICS-MAPPING.md)**.

## Pages
- **Overview** — hero cards (requests, success rate, p95, stale caught, status) + per-chain Routers table
- **Metrics** — RPS time-series + per-chain breakdown
- **Providers** — backing-endpoint roster with live selection scores (availability/latency/sync/stake/composite)
- **Endpoints** — live router topology from the mounted config
- **Live test** — send a request straight through the router; inspect status/latency/response
- **Login** — basic-auth sign-in (parity with v1)
