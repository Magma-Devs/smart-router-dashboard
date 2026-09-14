# Browser tests

Playwright, against a running api and web. Five surfaces from MAG-2730 — the
ones where the thing under test is what a person sees:

| Spec | What only a browser can show |
|---|---|
| `sign-in.spec.ts` | the code field appears after the password and not before; a wrong code costs the whole sign-in; one message for both steps |
| `enrolment.spec.ts` | the QR is painted, not just delivered; the dashboard is shut behind the enrolment screen; the block lifts by re-reading the account, without a navigation |
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
have to match that stack; the defaults already match the compose ones.

**It truncates the accounts tables on the first test.** Every spec starts from a
deployment with nobody in it, because first-run setup is where the grace period
comes from. Do not point it at anything you want to keep.

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
