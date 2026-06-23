# Smart Router Dashboard — v2

A Prometheus-driven observability dashboard for the Magma Devs **Smart Router**,
rebuilt as a pnpm/TypeScript monorepo (Fastify API + Next.js 16 web + shared
package) to the engineering standard of `lava-connect`.

Coexists with the legacy Python/Next stack in the parent repo (`../backend`,
`../frontend`); v2 is self-contained under this directory.

```bash
pnpm install
pnpm --filter @sr/shared build
pnpm dev            # api :8000, web :3000
pnpm typecheck && pnpm test
```

To run against a real router, see **[CLAUDE.md](CLAUDE.md) → Quick start**.
For the metric catalog and gap analysis, see **[docs/METRICS-MAPPING.md](docs/METRICS-MAPPING.md)**.

## Pages
- **Overview** — hero cards (requests, success rate, p95, stale caught, status) + per-chain Routers table
- **Metrics** — RPS time-series + per-chain breakdown
- **Providers** — backing-endpoint roster with live selection scores (availability/latency/sync/stake/composite)
- **Endpoints** — live router topology from the mounted config
- **Live test** — send a request straight through the router; inspect status/latency/response
- **Login** — basic-auth sign-in (parity with v1)
