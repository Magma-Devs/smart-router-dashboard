# MAG-2730 — requirement coverage

Every line of [MAG-2730](https://magmadevs.atlassian.net/browse/MAG-2730)
("Dashboard v2 (3/4) — Two-factor login (TOTP)") against what is on the branch,
so the ticket can be checked off rather than taken on trust.

| | |
|---|---|
| As of | `feat/MAG-2730-two-factor` (#172), the top of the 2FA stack (#174 → #172), rebased onto `main` after #147 and #173 merged |
| Parent epic | [MAG-2686](https://magmadevs.atlassian.net/browse/MAG-2686) — Dashboard v2, config change + SOC 2 |
| Depends on | [MAG-2729](https://magmadevs.atlassian.net/browse/MAG-2729) (accounts) · [MAG-2770](https://magmadevs.atlassian.net/browse/MAG-2770) (the audit log this emits into) |
| Reference | [`TWO-FACTOR.md`](./TWO-FACTOR.md) |
| Tests | `pnpm -r test` green on this branch — the numbers are in the PR |
| Acceptance | **11/11** against a live deployment — [§2](#2-the-acceptance-checks) |
| Version | `0.26.0`, cut once at the end of the stack (the last commit of #172), over `main`'s `0.25.0` |

## Verdict

Everything the ticket asks for is implemented and nothing is open for decision, with one partial row: somebody whose 2FA an admin resets finds out at their next sign-in rather than by email, because that email is MAG-2869's.

**Nothing was taken from lava-connect.** It was checked first, since it is this
repo's shape reference and carries a mature account system: it has **no TOTP
anywhere** — no column in `0000_init.sql`, no path in `services/auth.ts`, three
grep hits and all of them in Stripe skill documentation. What it does have
(Auth.js v5 credentials, bcrypt, sessions, per-account lockout, HIBP, single-use
link tokens) was already harvested by MAG-2729 and deliberately re-implemented on
Postgres rather than copied, because lava-connect's versions fail open without
Redis (design §2.3). The one piece worth reusing was therefore already in this
repo — `services/lockout.ts`, at five failures per fifteen minutes, the exact
numbers this ticket wants for codes — and reuse here means **the same counter**,
not a second one.

**MAG-2770 had already written this ticket's vocabulary.** `2fa.enrolled`,
`2fa.reset` and `host.recovery` were in the audit catalog with full descriptions
and `origin: "MAG-2730"`, the groups `2fa` and `recovery` existed, `MemberRow`
carried `twoFactorEnabled` pinned to `null`, and `AuditActor` already had a
`host` kind with a **mandatory** label so an anonymous recovery row cannot be
written. No catalog change was needed.

Two defects were found while building and are fixed on the branch —
[§4](#4-defects-found-while-building).

---

## 1. Coverage

### Who has to set it up

| Requirement | Status | Where |
|---|---|---|
| Everyone sets up an authenticator and enters a code at sign-in | ✅ | `plugins/auth.ts` gate · `routes/auth.ts` two-step |
| First admin on a fresh install may defer, on a countdown | ✅ | `two-factor.ts` `twoFactorStatus` · `users.created_by_setup` |
| Anyone joining by invite cannot defer | ✅ | same — `created_by_setup` is false for them |
| Grace ends when they invite someone | ✅ | `routes/team.ts` `requireEnrolledToInvite` (create **and** resend) |
| Grace ends 30 days from first sign-in | ✅ | `users.first_signin_at`, stamped once by `recordSignIn` |
| A countdown in the header, not a dismissible banner | ✅ | `TwoFactorCountdown` in `Shell.tsx` |
| Same rule for managed and self-hosted | ✅ | no mode fork anywhere in the gate |
| Google Authenticator | ✅ | HMAC-SHA1 / 30s / 6 digits, RFC 6238 vectors in `totp.test.ts` |

### Setting it up

| Requirement | Status | Where |
|---|---|---|
| QR code | ✅ | rendered server-side as SVG, `beginEnrolment` |
| The same secret as text, for desktop password managers | ✅ | returned beside the QR, shown in `EnrolPanel` |
| The user types the current code back to confirm | ✅ | `POST /api/account/2fa/confirm` |
| Logs `2fa.enrolled` | ✅ | `routes/account.ts` |

### Signing in

| Requirement | Status | Where |
|---|---|---|
| The code is asked for on a second screen after the password | ✅ | `LoginForm` stage machine · `/auth/2fa/verify` |
| …and after Google or GitHub, which stay as ways in (decided 24 Sep) | ✅ | `/auth/oauth/:provider` answers an enrolled account with a challenge; the `sr_2fa` handoff cookie carries it to the code screen |
| A wrong code gives a generic error with no hint which factor failed | ✅ | one message for wrong code, dead challenge and unknown challenge alike |
| Five failed codes lock the account for fifteen minutes | ✅ | the **same** `login_attempts` row as passwords |
| A used code cannot be reused, even within its 30-second window | ✅ | `users.totp_last_step`, advanced in the accepting UPDATE's WHERE |
| Accept the previous and next window | ✅ | `TOTP_WINDOW_STEPS = 1` |

### Lost phone

| Requirement | Status | Where |
|---|---|---|
| An admin resets that user's 2FA | ✅ | `POST /api/team/members/:id/2fa/reset` · `ResetTwoFactorModal` |
| The old secret is destroyed | ✅ | `clearEnrolment` nulls all three columns |
| The user sets it up again on their next sign-in | ✅ | the gate does this — no separate flow |
| The admin never sees or sets the user's code | ✅ | no endpoint returns or accepts one for another account |
| The user is told it happened | ◐ | At their next sign-in, on both deployments: their sessions just ended and the enrolment screen says an administrator reset it. An email is MAG-2869's — MAG-2870's transport sends only the invitation and the password reset |
| Logs `2fa.reset`, naming both people | ✅ | actor + target on the row |

### When nobody can get in

| Requirement | Status | Where |
|---|---|---|
| `reset-2fa --email` | ✅ | `apps/api/src/recover.ts` |
| `reset-password --email` — prints a link, does not set a password | ✅ | reuses `createPasswordReset` |
| `promote-admin --email` | ✅ | reactivates as well as promotes |
| Each writes a `host.recovery` row naming the command and who ran it | ✅ | `host` actor, mandatory label |
| On managed, marked as performed by Magma | ✅ | `Magma Devs (name)`, derived from `DEPLOYMENT_MODE` |

### Visibility and security

| Requirement | Status | Where |
|---|---|---|
| The members list shows, per person, whether 2FA is set up | ✅ | `twoFactorEnabled` is a real boolean; red and bold on "No" |
| The TOTP secret is encrypted at rest | ✅ | AES-256-GCM, `TOTP_ENCRYPTION_KEY` |
| Never logged, never returned by any API after setup | ✅ | asserted across `/me`, the member list and the CSV in `sanity-two-factor.mjs` |
| Rate limit the code check per account and per IP | ✅ | per-account `login_attempts` · per-IP `STRICT_AUTH_RATE_LIMIT` (10/min) |
| The setup QR URL is generated server-side, never in a log or address bar | ✅ | SVG in a response body; the `otpauth://` URI never leaves the process |

---

## 2. The acceptance checks

**11/11 pass**, run against a live on-prem deployment
(`make accounts-reset && make accounts`, then the runner) — not asserted in unit
tests. Three things only a real deployment could show, and all three were found
that way:

- **The api would not have booted.** `TOTP_ENCRYPTION_KEY` was in no compose
  file, and the boot check added in slice 3 does exactly what it says.
- **The lockout trips inside the per-IP limit.** Five failures in a window
  lock the account, and the sixth attempt is refused with `423` — well under
  the 10/min per-IP limit, which the runner sleeps off when it does answer
  first. Check 7 asserts both: the shared counter on `login_attempts`, then the
  sixth attempt, with the right password, refused.
- **The ±1 window and the replay guard are two rules, and they collide.** After
  a sign-in at step *S* a code from *S−1* is refused — not because the window is
  wrong but because that step is spent. Check 8 now asks each question
  separately: it clears the counter to test the window, then replays the same
  code to test the guard. Left conflated, that is a pair somebody eventually
  "fixes" in the wrong direction.

`node scripts/sanity-two-factor.mjs`, against a live deployment. Two items
cannot be checked in wall-clock time and say so rather than being quietly
skipped:

- **the thirtieth day** — asserted by moving `first_signin_at` back 31 days,
  reading the api's own answer, and putting it back;
- **the lockout window expiring** — the wall going up is checked; the fifteen
  minutes lapsing is not waited for.

`scripts/sanity-accounts.mjs` (MAG-2729's eleven) was updated rather than
exempted: its admin enrols before inviting and its invited member enrols before
the dashboard opens, which is what those flows now are. Turning enforcement off
for that run would have tested a deployment nobody ships.

**It still passes 10/10 on-prem** — the same result MAG-2729 reported before
two-factor existed, now with it enforced. That is the check that the two tickets
compose rather than merely coexist, and three of its flows needed real changes
to keep passing:

| | |
|---|---|
| Redemption | `/auth/invite/accept` opens no session by design, so the runner signs in with the password just chosen and enrols from *that* token |
| Sign-in | every member sign-in is now two calls, through a `signInFully` helper that spends the **current** step — reaching one ahead works right after enrolling and then refuses the next sign-in inside the same 30 seconds as a replay |
| Rate limit | two-factor roughly doubles the `/auth/*` calls a sign-in costs, so the run now crosses the 10/min per-IP limit where it used to sit under it. Slept off, not raised — raising it for the run would stop exercising what ships |

---

## 3. What this ticket deliberately does not do

| | Why |
|---|---|
| Make enforcement un-bypassable on a self-hosted deployment | The ticket's own line: the customer owns the code and can switch any of this off. Enforcement here is a **default**, not a security boundary — what matters is what the shipped default does |
| Ask for a code when SSO arrives | Their identity system already enforces a second factor; asking twice is friction that buys nothing. No SSO exists yet |
| Offer recovery codes | Not in the ticket. The stated route back from a lost phone is an admin reset, and a second self-service route that names nobody is what §Lost phone exists to prevent |
| Let a user turn 2FA off | Same reason. Whoever held a stolen session could take it |

---

## 4. Defects found while building

**1 · `completeSetup` never wrote `created_by_setup`.** Every grace-period unit
test passed, because they set the column on a fixture by hand — while the
deployment's actual first admin would have been refused the dashboard on their
first sign-in, the exact person the grace period exists for. Caught by adding a
test that drives `/auth/setup` and `/auth/sign-in` for real rather than the
policy function in isolation.

**2 · A correct password cleared the failure counter.** Correct while the
password was the only factor, and a hole with two: an attacker holding a correct
password reset the counter on every attempt, so five wrong codes could never
accumulate and the per-account lockout never tripped for the one person it most
needs to stop. `clearFailures` moved into `completeSignIn`, which runs only when
both factors have passed.

Both are pinned by tests that fail without the fix.

---

## 5. New environment

| Variable | Default | Notes |
|---|---|---|
| `TOTP_ENCRYPTION_KEY` | — | **Required** under `AUTH_MODE=enabled`. The api refuses to boot without it: the gate shuts the dashboard to anyone unenrolled, enrolment is the only way through, and enrolment needs this key — so missing it locks out every account with no route back in |
| `TOTP_ISSUER` | `Smart Router` | What the authenticator app shows |
