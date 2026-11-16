# Browser tests

Playwright, against a running api and web. The account flows where the thing
under test is what a person sees:

| Spec | What only a browser can show |
|---|---|
| `sign-in.spec.ts` | the code field appears after the password and not before; a wrong code costs the whole sign-in; one message for both steps |
| `enrolment.spec.ts` | the QR is painted, not just delivered; the dashboard is shut behind the enrolment screen; the block lifts by re-reading the account, without a navigation |
| `invitation.spec.ts` | redeeming an invitation on screen: a short password is refused under its field before the api is asked; the button spins and the fields hold from the click until the next page, through the gap between the api's answer and the sign-in |
| `password-reset.spec.ts` | a reset link on screen: the success state, a used link reading the same as any dead one, and a link spent while its form is open landing on that page |
| `countdown.spec.ts` | the grace period is counted down in the header, and reads as a deadline in its last week |
| `team-reset.spec.ts` | the reset is offered only where there is something to clear, names the person before it acts, and updates the row |

Everything else about two-factor is asserted where it is cheaper:
`apps/api/src/__tests__` for the rules, and `scripts/sanity-two-factor.mjs` for
the ticket's acceptance list against a live deployment.

## Running it

```bash
pnpm --filter @sr/e2e exec playwright install chromium   # once
docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
  --profile auth up -d postgres                          # a database, nothing else
pnpm e2e
```

The suite starts the api and the web itself. Point it at a stack you already
have (`make accounts`) with `E2E_WEB_URL` and `E2E_API_URL` — set both, and it
starts nothing. Then `E2E_AUTH_SECRET`, `E2E_SETUP_TOKEN` and `E2E_DATABASE_URL`
have to match that stack; the defaults already match what `make accounts`
passes.

**It truncates every table in the database on the first test.** Every spec
starts from a deployment with nobody in it, because first-run setup is where the
grace period comes from. It refuses a database that is not on localhost, and it
refuses to start when something already listens on :3000 or :8000 — stop that
stack, or point the suite at it with the two variables above.

## Things that cost an afternoon

- **`localhost`, never `127.0.0.1`.** Next's dev server serves its client chunks
  only to origins it recognises. An unrecognised one gets a warning in the
  server log and no error in the browser: the page arrives, never hydrates, and
  every form submits natively to `/login?`.
- **One worker, serially.** `/auth/*` allows ten requests a minute per address,
  the enrolment gate is a property of an account, and both are global to the
  deployment the suite shares. Browser calls carry a distinct `X-Forwarded-For`
  per test to spread the first of those; the calls the Next server makes on the
  browser's behalf all arrive from one address and cannot.
- **Wait for a step boundary, don't reach past it.** A code is accepted from the
  step either side of now, and separately refused if its step has already been
  spent. Generating twice inside thirty seconds therefore fails as "wrong code".
  `Authenticator.next()` waits instead; that is what the person with the phone
  does.


## Ask your data

`pnpm --filter @sr/e2e exec playwright test -c ask.playwright.config.ts` starts the
managed Ask fixture. Auth, HTTP, the API worker, budget and PostgreSQL are real.
Only the MCP/Bedrock boundary is replaced by `support/ask-provider-fixture.mjs`,
loaded explicitly by the test command. It refuses production and non-fixture
customer/model settings; product code imports no sample provider or answers.

The Ask suite covers panel/full/draft continuity, minimize, real persistence,
search/paging, copy/evidence/plain-text HTML, mobile focus/scroll, another browser
context with no local storage, cross-tab processing/Stop, failed answers after
reload, read-only members and personal history denial. The accounts suite also
checks that disabled/self-hosted chat has no entry, requests or usable direct page.
CI runs both suites on separate PostgreSQL services/runners.

To let the suite own separate ports while another checkout is running, set
`E2E_OWN_SERVERS=true`, `E2E_WEB_URL=http://localhost:<web-port>` and
`E2E_API_URL=http://localhost:<api-port>`. Supply a dedicated local
`E2E_DATABASE_URL`. With the two URLs and without `E2E_OWN_SERVERS`, the suite
continues to reuse an intentionally supplied stack. Never run the destructive
fixture reset against a database containing real data. Ask artifacts live under
`.playwright/ask-results`; the accounts suite uses `.playwright/results`.
