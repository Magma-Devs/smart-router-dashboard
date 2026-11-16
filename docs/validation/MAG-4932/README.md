# MAG-4932 budget, records and retention verification

This slice stacks on [PR #393](https://github.com/Magma-Devs/smart-router-dashboard/pull/393).
The preceding three PRs passed Quality Gate and existing Browser CI. No customer
flag, cloud policy, deployment, model price or secret has been changed.

## Observed local evidence

The opt-in HTTP/PostgreSQL suite now includes 22 checks. In addition to the prior
ownership/lifecycle coverage, actual independent connections prove:

- Twelve people/replicas competing for one customer/month pool admit only the two
  bounded reservations that fit; Ask/Investigate use the same row.
- Exhausted HTTP admission rolls back run/message persistence.
- Duplicate late usage receipts after cancellation settle once while a second
  customer's question remains open.
- Physical retention deletes content while dispatched uncertainty survives; an
  authoritative late receipt still settles the original financial reservation.
- Credential-shaped text is redacted before HTTP submission reaches PostgreSQL.

PGlite service tests cover price snapshots/cache categories, uncertainty, known
zero usage, failed/never-dispatched steps, crash recovery without replay, UTC
rollover, current leases, privacy retention and retryable cleanup failure.
Runtime wiring tests cover API admission through a worker, free counter, durable
step receipt, answer/message persistence and scheduled retention; mocked provider
responses make these deterministic, not live provider evidence. Staff route tests
use the actual MCP identity verification code with mocked SDK responses and prove
customer-admin denial, current grant checks, export and customer scoping.

The free counter adapter is tested for both exact Converse input and the supported
Anthropic Mantle text/tool mapping; denial/invalid counts cannot trigger a paid
fallback. Pricing tests use explicitly synthetic rates, never an invented current
production price. Model usage callbacks run before output validation, and dispatch
callbacks are now mandatory. The operator smoke uses normal metered API submission.

## Remaining acceptance limits

These tests prove enforced database and policy behavior. They do not prove the
current provider model/counter/pricing/permission combination, arbitrary secret
classification or semantic correctness for every model answer. The previously
observed Bedrock HTTP 403 and expired/insufficient AWS access still block current
live verification. Proper access, verified production rates and a supported token
counter must be established before enabling paid questions.

Internal staff OAuth and retention must also be observed in the actual managed
runtime. Provider-side invocation logging/retention and infrastructure delivery
remain rollout checks. Browser UX and controlled GK8 enable/disable/pilot are the
next slices. Uncertain usage requires authoritative provider evidence; no current
customer reservation was created or manually cleared during this work.

## Commands

Use the repository's pinned Node/pnpm versions. Build shared/db, then run normal
workspace typecheck, tests, lint and API build. Run the opt-in file separately with
`ASK_TEST_DATABASE_URL` pointing only to an isolated local `ask_test_*` database:
`pnpm --filter @sr/api exec vitest run src/__tests__/ask-postgres.test.ts`.
The same PostgreSQL check remains required in Quality Gate.

## Final results

- Fresh isolated PostgreSQL database: all 22 HTTP/concurrency checks passed with
  the final accounting migration applied once from the committed migration chain.
- All 3,691 normal workspace tests passed. The real PostgreSQL checks run
  separately, not counted as passing when skipped in the normal suite.
- Workspace type checks, API build and lint passed (zero errors, 14 existing
  warnings). New code has no lint warnings. `git diff --check` passed.
- Cleanup retry uses PostgreSQL time for both failed and successful attempts;
  the zero-delay boundary is inclusive and tested without sleeps.
