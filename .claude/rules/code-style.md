# Code Style

## TypeScript
- Strict mode + `noUncheckedIndexedAccess`. No `any` without justification.
- Prefer `interface` for object shapes; prefer early returns.
- **ESM `.js` suffixes** on relative imports in `apps/api` + `packages/shared`
  (Node16 resolution) — even though source is `.ts`. `apps/web` uses bundler
  resolution (no suffixes; `@/` alias for `src/`).

## API (Fastify)
- One file per resource under `routes/`; cross-cutting concerns are `plugins/`
  (registered via `fastify-plugin`); domain logic in `services/`.
- Never throw on Prometheus "no data" — an empty result set is a valid answer.
  Surface unbacked values as `null`; the web renders `—`. **Never invent data.**
- Env defaults live only in `config.ts`.

## Web (Next.js 16 / React 19)
- `"use client"` on interactive pages; all hooks before any early return.
- Design tokens are CSS variables in `styles/globals.css` (brand `#FF3900`),
  used via the `.gw-*` classes ported from the SR Dashboard prototype.
- Page-level window selector + chain selector at the top; card titles inside cards.

## Metrics
- Metric names are GROUND TRUTH from a live scrape (`smartrouter_*`/`rpc_endpoint_*`),
  catalogued in `packages/shared/src/constants/metrics.ts`. Don't trust the design docs.
- Chains are keyed by Lava spec index (`spec` label) via `buildChainMetaByIndex`.
