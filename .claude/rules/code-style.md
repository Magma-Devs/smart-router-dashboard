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

## Chart colors
- Chart/series colors come ONLY from the theme tokens in `styles/globals.css`
  (`--series-1..8`, `--series-other`, `--ord-1..3`) via the `lib/colors.ts`
  helpers: `upstreamSlot` for upstream identity (stable per name, never cycled,
  9th+ folds to "Other"), `PCTL_CLR` for p50/p95/p99, status vars only when the
  series MEANS good/bad. Never hard-code a hex in a chart.
- Tokens are validated (colorblind separation + surface contrast) with the
  dataviz skill's `validate_palette.js` against the real surfaces (dark
  `#131317`, light `#ffffff`) — re-run it if you change one. Never a dual-axis
  chart; never repaint a series by its value (flag state in the legend with an
  icon + label instead).

## Metrics
- Metric names are GROUND TRUTH from a live scrape (`smartrouter_*`/`rpc_endpoint_*`),
  catalogued in `packages/shared/src/constants/metrics.ts`. Don't trust the design docs.
- Chains are keyed by Lava spec index (`spec` label) via `buildChainMetaByIndex`.
