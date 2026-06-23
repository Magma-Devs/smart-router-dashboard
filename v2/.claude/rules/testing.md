# Testing

- Vitest 4 (workspace at `vitest.workspace.ts`). Tests colocated in `src/__tests__/`.
- Every exported util in `packages/shared` MUST have a test.
- Every API route needs at least a happy-path test via `app.inject()`; mock
  Prometheus by stubbing global `fetch` (never hit a real endpoint).
- Do NOT unit-test React components — rely on typecheck + manual UI verification.
- `pnpm test` runs everything; `pnpm --filter @sr/api test` for the API only.
