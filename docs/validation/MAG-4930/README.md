# MAG-4930 history and run correctness validation

This slice stacks on [PR #389](https://github.com/Magma-Devs/smart-router-dashboard/pull/389).
The code adds PostgreSQL persistence and run primitives; no model/MCP provider
is invoked and default submission remains disabled until budget admission lands.

## Actual HTTP/PostgreSQL checks

17 integration checks passed on 16 November 2026, against local PostgreSQL with
independent postgres-js pools and three actual Fastify HTTP listeners. These are
network `fetch` calls, not `app.inject`, PGlite or a mocked database. A fresh API
instance verifies server-state persistence independently of the first instance.
All people, sessions, questions and answers in this suite are synthetic fixtures.

The final run used a fresh `ask_test_runs_final` database, including migration
application. All workspace type checks and the API build passed. The normal
workspace suite passed 3,626 tests (the 17 opt-in PostgreSQL tests are skipped
there and passed separately). Lint passed with zero errors and 14 existing
warnings; the new code passes targeted lint without warnings.

Verified:

- Two customers/two people: personal read/search, run lookup, submission, cancel
  and preferences do not expose another scope's data.
- Twelve concurrent submissions across API replicas admit one active question
  for the person; a second person proceeds independently.
- Concurrent same-key retries return one run and one user message. A changed
  request conflicts; admission rejection leaves no partial turn/active lock.
- Cancelling one customer's queued run leaves the other customer's run open.
- Competing workers claim one run once. Running cancellation blocks a late
  success; a cancelled/failed run has no successful assistant message.
- Lost leases recover without replay; old workers cannot heartbeat or complete,
  and the person can ask a new question.
- **Lock-wait regression:** a completion initially passed after its lease expired
  while waiting on a PostgreSQL row lock. The corrected implementation locks,
  then evaluates current time again in a separate statement. Both completion and
  heartbeat tests now pass this adversarial timing case.
- A validated answer is committed once with ordered messages. Provider failures
  retain an error without producing an assistant success message.
- Preferences/history survive a fresh API instance. Paging/search cursors bind
  their customer/person/filter; message paging returns all 52 fixture messages
  without gaps/duplicates.
- Database constraints independently reject a second active run and mismatched
  message ownership, even when bypassing the API.
- Session revocation immediately blocks the next HTTP request and recovery ends
  its queued run. Expired content stays hidden, including idempotent retry.
- Caller-selected tenant fields and external return URLs are rejected.
- Without budget admission, the production route refuses submission and reports
  `acceptingQuestions:false`.

The suite is opt-in through `ASK_TEST_DATABASE_URL`. It refuses to run against a
database whose name is not `ask_test_*` or whose host is not an approved local
test host. It truncates only the Ask test tables. CI provisions its own pinned
PostgreSQL container in the Quality Gate job.

```sh
ASK_TEST_DATABASE_URL=postgres://ask_test:test-only@127.0.0.1:5432/ask_test_runs \
  pnpm --filter @sr/api exec vitest run src/__tests__/ask-postgres.test.ts
```

## Limits and pending integration

Admission uses an injected non-spending test policy to exercise transaction
rollback; it does not prove real budget accounting. Workers are exercised through
the SQL lifecycle primitives, not a production provider execution loop. Recovery
scheduling, cost reconciliation, actual deletion, provider/tool orchestration,
browser UX, deployed runtime configuration and the pilot remain later slices.

The earlier live provider access limits in MAG-4929 still apply. No production
customer database, cloud resource, real user credential or feature flag changed.
