# Two-factor login (TOTP)

Everyone who uses the dashboard sets up an authenticator app and enters a
six-digit code when they sign in. The one softening is a grace period for the
very first admin on a fresh install, and it ends the moment they invite somebody
or after 30 days, whichever comes first.

Ticket: [MAG-2730](https://magmadevs.atlassian.net/browse/MAG-2730). Built on
the accounts system in [`ACCOUNTS-DESIGN.md`](./ACCOUNTS-DESIGN.md); the audit
vocabulary is MAG-2770's.

We build against **Google Authenticator** — the standard TOTP scheme, so
1Password, Authy and the rest work too, but Google Authenticator is what is
documented and tested.

---

## The shape of a sign-in

```
POST /auth/sign-in     { email, password }
  ├─ not enrolled  →  { user, sessionId }            ← signed in
  └─ enrolled      →  { twoFactorRequired: true, challenge, expiresAt }
                                                      ← NO session

POST /auth/2fa/verify  { challenge, code }
                     →  { user, sessionId }           ← signed in
```

**A verified password opens no session.** That is the load-bearing decision, not
an implementation detail. `plugins/auth.ts` refuses any token whose `sid`
resolves to nothing, so a half-authenticated caller has no shape it can take.
The alternative — opening the session at the password step and hanging a
`pending` flag off it — would make every route's correctness depend on
remembering to read that flag, and the one route that forgot would be the bug.

Two consequences worth keeping straight:

- **The challenge is spent before the code is checked.** A challenge that
  survived a wrong code would let somebody try code after code against a single
  password verification, which is the exact thing the second factor exists to
  stop. A wrong code costs a fresh sign-in, and the login form goes back to the
  first screen because there is genuinely nothing left to retry against.
- **Auth.js never sees the first step.** It has no notion of a partial sign-in,
  so `authorize()` is handed the finished thing: the web calls `/auth/sign-in`
  itself, and `signIn("credentials", …)` runs once, on the second step, against
  a response that already carries a session id.

### Failed codes count into the password's lockout

`login_attempts` is one row per address, at five failures per fifteen minutes —
the same row and the same numbers whether the failure was a password or a code.
A second counter would quietly hand an attacker five password attempts *and*
five code attempts.

The corollary is that **`clearFailures` runs when a sign-in completes, not when
a password is accepted**. While the password was the only factor those were the
same moment; with two factors they are not, and clearing on a correct password
means an attacker holding one resets the counter on every attempt — so five
wrong codes never accumulate, against exactly the person the wall is for.

### Replay

`users.totp_last_step` holds the TOTP counter (`unix seconds / 30`) of the last
code the account spent, and `verifyTotp` takes it as an argument so a call site
cannot forget it. Without it the ±1-step tolerance — which is what lets a phone
with a 20-second-wrong clock sign in — **is** a 90-second window in which an
observed code can be spent twice.

`consumeCode` advances it in the `WHERE` clause of the update that accepts the
code, so two tabs submitting the same code both read the old step and only one
of them wins.

---

## Who has to set it up, and when

| Who | When | Can they defer? |
|---|---|---|
| The first admin on a fresh install | Offered on first sign-in | **Yes**, on a countdown |
| Anyone joining by invite | Before the dashboard opens | No |

The grace period ends at whichever comes first:

1. **They invite someone.** `POST /api/team/invites` (and resend) refuses while
   the caller is unenrolled. There is no flag to write — the countdown "ending"
   *is* that refusal, and a stored "grace revoked" bit would be a second source
   of truth for a question the account row already answers.
2. **30 days from their first sign-in.** `users.first_signin_at`, stamped once
   by `recordSignIn` with `coalesce` in SQL so it survives every later sign-in.

**Why both, not just the invite.** A one-person deployment never invites anyone,
so an invite-only trigger leaves the highest-privilege account in the system
running forever with no second factor. That is the account AWS chose to enforce
first — MFA mandatory for root users, 35 days from first console sign-in.

**Why a grace period at all.** The product is open source. Somebody who pulled
the repo to look around should not be handed an authenticator app before they
have seen a single screen. It also lets a security questionnaire be answered
with *"enforced, with a 30-day grace period"* rather than *"optional"*.

### The two columns it keys on, and the three that do not work

`users.created_by_setup` (written only by `completeSetup`, unconditionally) and
`users.first_signin_at`. Each near-miss is worth naming because all three look
plausible:

| | Why not |
|---|---|
| `last_sign_in_at` | Overwritten every sign-in. Answers "when did they last sign in", never "when did the clock start" |
| `is_magma_account` | Only ever written under `DEPLOYMENT_MODE=managed`, so on-prem — the mode the grace period is for — it is false for the very account it would identify |
| the `setup.completed` audit row | Would work, and must not be used. A permission-adjacent check reading the audit log makes the log load-bearing for access decisions, which is not what it is for |

---

## The gate

`plugins/auth.ts`'s `onRequest` hook, not per route — a gate that has to be
added route by route is a gate somebody forgets on the route that matters. An
unenrolled session reaches exactly three paths:

```
POST /api/account/2fa/begin
POST /api/account/2fa/confirm
GET  /api/account/me
```

Everything else answers **403 `TWO_FACTOR_REQUIRED`**. That is its own code
rather than `FORBIDDEN` because the web has somewhere to send this person;
bouncing them to the login page would be a dead end, since their password is
fine and signing in again changes nothing.

Web side, `TwoFactorGate` wraps the app rather than redirecting: the gate's
answer changes the moment enrolment lands, and a route-based version would have
to poll for that or bounce somebody who has just finished.

---

## Storage

`users.totp_secret` holds an **AES-256-GCM envelope** — `base64(iv | tag |
ciphertext)`. The tag means a tampered row fails to open rather than decrypting
to garbage that then gets HMAC'd.

```bash
openssl rand -base64 32        # → TOTP_ENCRYPTION_KEY
```

**Not derived from `AUTH_SECRET`.** That key signs sessions and rotating it is a
routine operation; if it also unlocked the authenticator secrets, one rotation
would invalidate every enrolled phone in the deployment at once. Two very
different blast radii, so two keys.

**`AUTH_MODE=enabled` refuses to boot without it.** The gate shuts the dashboard
to anyone without an authenticator, enrolment is the only way through, and
enrolment needs this key — so a missing key locks out every account at once with
no route back in. Failing at boot turns "the dashboard stopped working for
everybody overnight" into a startup error naming the variable.

The secret leaves the server exactly once, in the body of the response that
created it. Never in a URL, never in a log line, never returned by any read
surface afterwards — not `/api/account/me`, not the member list, not the CSV
export.

---

## Lost phone

An admin resets it: `POST /api/team/members/:id/2fa/reset`, or the **Reset 2FA**
button on `/team`. Three writes, each load-bearing:

1. the secret is **destroyed**, not disabled — nothing left to restore, and
   nothing an admin could read back;
2. any challenge in flight is retired, so a second step against the old secret
   cannot still be completed;
3. their sessions end, because this is done precisely when nobody is sure who is
   holding them.

The admin never sees or sets the replacement. The member enrols again at their
next sign-in, from a secret only they will ever hold — the same rule as
passwords, and for the same reason: an admin who could set someone's second
factor could sign in as them.

Logged as `2fa.reset`, naming both people. The member is told: an email on
managed, and on-prem the enrolment screen they meet at their next sign-in.

**Self re-enrolment is refused** (409). The ticket gives exactly one route back
from a lost phone, and a self-service one would be a second that names nobody:
whoever held a stolen session could move the second factor onto their own phone,
and the log would show a `2fa.enrolled` the owner would assume was theirs.

---

## When nobody can get in

Three commands on the machine the dashboard runs on:

```bash
make recover CMD="reset-2fa       --email x@y.com"   # clear their authenticator
make recover CMD="reset-password  --email x@y.com"   # print a one-time link
make recover CMD="promote-admin   --email x@y.com"   # no admin is left at all

# or directly, inside the api container
node dist/recover.js reset-2fa --email x@y.com --by victoria    # published image
pnpm --filter @sr/api exec tsx src/recover.ts reset-2fa --email x@y.com   # dev stack
```

> The dev stack runs `tsx watch src/main.ts`, so it has no `dist/`. `make
> recover` uses the `tsx` form; a real deployment runs the published image and
> uses the first.

**Shell access on the host is the authorisation.** Somebody with root there
already controls the deployment — they can read the database, change the image,
or replace `recover.ts` — so these hand out nothing new. What they do is make
the ordinary recovery paths reachable without a back door in the api, which
would be reachable by everyone.

**Each writes a `host.recovery` row**, and that is why they exist rather than
being a `psql` one-liner in a runbook. Somebody with a database prompt can
already do all of this; what they cannot do, once these are the documented path,
is do it quietly. On managed the row is marked as performed by Magma Devs —
there the host is ours, so shell access is Magma's by definition.

`reset-password` **prints a link and never sets a password**: the account holder
still chooses the value. `promote-admin` reactivates as well as promotes,
because the commonest way to reach "no admin is left" is the last one being
suspended.

> The operator's name is `SUDO_USER`, then the shell user, then `--by`, and
> **none of them authenticates anybody**. The row says so: it reads *reported
> by*, not *performed by*. Recording an unproven name still beats an anonymous
> row — "somebody with root did this at 03:12" is materially less useful than a
> name, even one nothing checked.

---

## Environment

| Variable | Default | Notes |
|---|---|---|
| `TOTP_ENCRYPTION_KEY` | — | 32 bytes, base64 or hex. **Required** when `AUTH_MODE=enabled`; the api refuses to boot without it |
| `TOTP_ISSUER` | `Smart Router` | What the authenticator app shows as the issuer. Override it so somebody administering two dashboards can tell the entries apart |

---

## Checking it by hand

```bash
make accounts-reset && make accounts     # a genuinely fresh install
node scripts/sanity-two-factor.mjs       # MAG-2730's eleven done-whens
node scripts/sanity-accounts.mjs         # MAG-2729's, which now enrol too
```

Two items in that list cannot be checked in wall-clock time and say so rather
than being quietly skipped: the thirtieth day (asserted by moving
`first_signin_at`, then putting it back) and the lockout window expiring.

---

## Related

- [`ACCOUNTS-DESIGN.md`](./ACCOUNTS-DESIGN.md) — the accounts system this sits on
- [`AUTH.md`](./AUTH.md) — the operator guide for `AUTH_MODE=enabled`
- [`MAG-2730-REQUIREMENTS.md`](./MAG-2730-REQUIREMENTS.md) — the ticket, line by line
- `packages/shared/src/constants/audit-events.ts` — `2fa.enrolled`, `2fa.reset`, `host.recovery`
