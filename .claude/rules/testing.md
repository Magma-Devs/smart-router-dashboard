# Testing

- Vitest 4 (workspace at `vitest.workspace.ts`). Tests colocated in `src/__tests__/`.
- Every exported util in `packages/shared` MUST have a test.
- Every API route needs at least a happy-path test via `app.inject()`; mock
  Prometheus by stubbing global `fetch` (never hit a real endpoint).
- Do NOT unit-test React components — rely on typecheck + manual UI verification.
- **Browser flows that gate access are the exception**, and they are tested in
  `e2e/` (Playwright, against a live api + web): the two-step sign-in, the
  enrolment block, the grace-period countdown, the admin's 2FA reset. That is
  not a loosening of the rule above — it covers the gap the rule names. A change
  that decides *whether somebody gets in* gets a spec there; component internals
  still do not. `pnpm e2e` runs it, and it boots its own api and web unless
  `E2E_WEB_URL` / `E2E_API_URL` point at a stack you already have up.
- `pnpm test` runs everything; `pnpm --filter @sr/api test` for the API only.
  `pnpm test` does NOT run `e2e/` — it needs a database and two servers, so it
  is its own CI job.
