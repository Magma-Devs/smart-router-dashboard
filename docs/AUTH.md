# Authentication

The dashboard has two auth modes, selected by the `AUTH_MODE` env var
(same value on the api **and** the web):

| Mode | What it means |
|---|---|
| `disabled` *(default)* | Today's behaviour — no login, no database, every route open. The zero-dependency self-hosted posture. The api registers none of the account routes, and the web follows: no Team entry in the sidebar, `/team` redirects, and Account shows only the build details. |
| `enabled` | Auth.js v5 sign-in (email+password, plus OAuth), Postgres-backed users, HS256 JWT shared between web and api. `/api/*` requires a Bearer token. |

The implementation is a trimmed port of `lava-connect`'s auth stack — same
JWT codec, same plugin layout, same seed semantics.

> **Ticket coverage:** [`MAG-2729-REQUIREMENTS.md`](./MAG-2729-REQUIREMENTS.md)
> maps every line of MAG-2729 to what implements it, with what is outstanding and
> who owns it.

## How it works (enabled)

<img src="./assets/auth-session-flow.svg" alt="Two bands. Signing in: the browser posts to the web tier, whose authorize() callback is the only place that sees the browser and forwards the caller's IP and User-Agent to the api with an internal secret; the api verifies the password, inserts a sessions row, and returns its id, which the web signs into the token as the sid claim. Every later request: the api verifies the signature, requires a sid, requires the database, then makes one indexed read joining sessions to users, each check with its own refusal code — and two separate levers, sessions.revoked_at for one device and users.signed_out_all_at for every outstanding token, are what make that read refuse." width="100%">


```
Browser ── credentials ──▶ Next.js (Auth.js v5)
                             │  authorize(creds, request)
                             │    → POST api /auth/sign-in   (bcrypt verify)
                             │      + the browser's own IP / User-Agent
                             │  signIn() → POST api /auth/oauth/:p
                             │                                ← { user, sessionId }
                             ▼
                       HS256 session JWT  (jose, AUTH_SECRET,
                        sid = sessionId,
                        iss=smart-router-dashboard-web,
                        aud=smart-router-dashboard-api)
                             │
Browser ── Authorization: Bearer <same JWT> ──▶ Fastify api (@fastify/jwt)
                                                  ├─ verify signature + iss/aud
                                                  ├─ resolve sid → sessions ⨝ users
                                                  │    revoked? expired? status? cutoff?
                                                  └─ global gate: /api/* → 401 without it
```

- **Web** (`apps/web/src/auth.config.ts`) — Auth.js v5 with a custom JWT
  codec: plain HS256 signing via `jose` instead of Auth.js's default JWE,
  so the api can validate the same token with `@fastify/jwt`. The session
  exposes `accessToken`; `ApiTokenBridge` mirrors it into a module store
  and `lib/api-client.ts` attaches it to every fetch (and *waits* for the
  bridge on first load so nothing races a 401).
- **Edge gate** (`apps/web/src/proxy.ts`) — redirects unauthenticated
  page loads to `/login`; signed-in users hitting `/login` bounce to
  `/overview`. A no-op in disabled mode.
- **Api** (`apps/api/src/plugins/auth.ts`) — validates HS256 + iss/aud,
  then resolves the token's `sid` to a live session **and the live user
  row**, and puts both on `request.authUser`. 401s any non-public route
  without one. Public: `/health*`, `/version`, `/auth/*`, `/docs*`.
  `requireRole(request, reply, minimum)` gates by role, comparing the
  **row's** role rather than the token's.
- **Database** (`packages/db`) — Drizzle + Postgres: `users` and
  `sessions`. The api's db plugin connects **lazily with retries** (no
  compose `depends_on`), runs migrations, then seeds the admin. While it
  is settling, `/auth/*` **and** every authenticated route answer 503 —
  the gate fails closed, because a signature check alone cannot tell
  whether a session was revoked or an account removed.

## Deployment modes

`DEPLOYMENT_MODE` (`managed` | `onprem`, default **`onprem`**) forks every
credential-delivery path, because on-prem has no mail server and never
will. Defaulting to `onprem` is the safe way to be wrong: the failure mode
is "an admin copies a link", not "an invitation silently never arrives".

| | Managed | On-prem |
|---|---|---|
| First admin | a Magma operator runs the first-run page, then invites the customer's named admin | first-run page + the installer's setup token |
| Magma Devs account | the first-run account is ours, stays, and is labelled | never — the first-run account is the customer's own |
| Invite / reset delivery | emailed | link shown to an admin, handed over |
| Invite TTL | 7 days | 24 hours |
| Reset TTL | 1 hour | 24 hours |

The web needs this at **runtime**, not build time — `NEXT_PUBLIC_*` is baked
into the bundle and one published image has to serve both shapes — so it
comes through `GET /api/config` alongside `DASHBOARD_API_URL`.

## First run (on-prem)

A fresh install has no accounts, so there is nobody to sign in as. The
first-run page creates the first admin, and **nothing else opens until it
is done**.

Two properties matter more than the rest:

- **The gate is "no active users", never a flag.** A one-time marker is the
  obvious implementation and it is wrong: a deployment restored from a
  backup taken before its first account would carry the marker and refuse
  to open, permanently. Deriving the state from the table means the answer
  is always about the install in front of you. (`GET /auth/bootstrap`
  reports it; it never reveals the token.)
- **A setup token is required.** Without one, whoever reaches the URL first
  between `helm install` and the operator sitting down becomes the admin —
  and that gap can be overnight. The same protection covers the restored
  backup above, where the window reopens on a deployment that is already
  reachable.

```
api boot, AUTH_MODE=enabled, database up, no active users
  ├─ SETUP_TOKEN set, ≥ 16 chars?  → use it   (helm: value lives in a Secret)
  └─ else                          → generate 32 bytes, log once at warn,
                                     write to SETUP_TOKEN_FILE when set
```

This happens at **boot**, not on the first request, and that is the whole
point: an operator with no `SETUP_TOKEN` configured has nothing to type
until something has generated the value. It is gated on "no active users",
so a deployment that is already claimed never mints or logs a token.

Generating rather than disabling setup is deliberate: an operator who
forgot to configure a token should still be able to finish the install,
from a value only log or filesystem access reveals. A `SETUP_TOKEN` shorter
than 16 characters is refused the same way and a generated one used in its
place — `/auth/setup` is public, and 10 attempts a minute bounds guessing
without stopping it.

**The window reopens whenever there are no active accounts**, not only on a
fresh install: suspend or remove every member and the deployment is
claimable again by whoever holds the token. That is deliberate — it is what
makes a restored backup and a locked-out install recoverable — but it means
the token stays security-relevant for the life of the deployment, and it
sits in the pod log. Rotate `SETUP_TOKEN` if that log is widely readable.

<img src="./assets/first-run-setup.png" alt="The first-run page: a single card headed &quot;Set up this dashboard — create the first administrator&quot;, explaining that nothing else opens until this is done and that the setup token is printed by the installer. Fields for the setup token, an optional name, email, password and repeat password, with a note that any characters are accepted from 8 to 64, that the password is checked against known breached passwords, and that there are no other rules and it never expires." width="450">

`POST /auth/setup` re-checks the zero-user condition **inside the
transaction**, behind an advisory lock — the check outside it is only
advice, and two people opening the page at the same moment would otherwise
both become admin.

It does **not** open a session. The web signs the new admin in immediately
afterwards through the ordinary credentials path, so the operator is not
left staring at a login page holding a password they just set — but the
session that carries them there is that one, minted the same way as every
other. An api-side session would be a second row nobody ever presents.

### The Magma Devs account (managed only)

The page is not gated on the mode — something has to create the very first
account whoever hosts the deployment. On **managed** that first account is
therefore ours: a Magma operator runs the page, then invites the customer's
named admin, who sets their own password from the invitation link. Nobody at
Magma ever knows the customer's password, and the operator account **stays**
after handover.

The rule that governs it (MAG-2729, decided 26 Aug 2026) is *"no hidden Magma
account, and none the customer can't see in their member list"* — visibility,
not absence. So `POST /auth/setup` stamps `users.is_magma_account` when
`DEPLOYMENT_MODE=managed`, and:

- the member list shows the row with a **Magma Devs** tag, and
  `members.csv` carries a `magma_account` column;
- it is full admin, on by default;
- it is logged like any other account — nothing filters it out of the member
  list, the export or the audit log;
- **a customer admin removes it like any other member.** No guard, no special
  case. If you find yourself adding one, that is the requirement inverted;
- on-prem no account ever carries it, because nothing else writes the column.

An invitation never sets it, including one sent by the operator: the label
means *this account is Magma's*, not *Magma created it*. The distinction is
what keeps it useful after the customer's admin has invited their own team.

## Invitations

After first-run setup, the **only** way an account comes into existence. Two
properties carry the security of the flow:

- **The account is created with the invitation's address, never the submitted
  one.** That makes "redeemable only by the address it was sent to" structural
  rather than a check someone can forget to write. The Google path compares the
  verified claim to the invited address and refuses a mismatch by name, so an
  honest person who used the wrong account knows which one to use.
- **The raw token exists only inside the link.** The row stores its SHA-256, so
  a backup, a log line or a support screenshot can't be turned back into a
  working invitation.

Single-use is a conditional `UPDATE … WHERE redeemed_at IS NULL AND revoked_at
IS NULL AND expires_at > now()`, run in the same transaction as the account
insert. Zero rows affected means somebody else got there first and the whole
transaction unwinds — a race can't produce two accounts from one invite, and a
crash can't leave a redeemed invite with no account.

| | Managed | On-prem |
|---|---|---|
| Delivery | link returned to the admin, once, and handed over — email is MAG-2870 | link returned to the admin, once, and handed over |
| TTL | 7 days | 24 hours |

**Resending mints a new token and kills the old link**, so it replaces the
attack surface rather than widening it. **Expiry needs no sweeper**: the first
read that observes it stamps `expired_noted_at` conditionally, which is what
lets `invite.expired` fire exactly once.

Every dead-link reason — used, revoked, expired, never issued — returns the same
message **and the same 410**. The holder can't act on the difference, and
distinguishing them would tell a stranger which of those a guessed token hit; a
404 for "never issued" beside a 410 for the rest would have said it in the
status line while the message withheld it.

<img src="./assets/invite-redemption.png" alt="The invitation redemption page: a card headed &quot;Join this dashboard&quot;, with a panel restating the invitation — the address it was sent to, shown as fixed text rather than an editable field, the role Approver, and a line describing what that role can do. Below it, optional name, password and repeat-password fields, a note that any characters are accepted from 8 to 64 and checked against known breached passwords, and an Accept invitation button." width="440">

> **OAuth is link-only from here on.** `upsertOAuthUser` used to fall through to
> an insert, which was correct while accounts came only from a seed. With
> invitations that is a hole big enough to walk through: anyone with a Google
> account could reach `POST /auth/oauth/google` and provision themselves.
> Account creation now lives in exactly two places — first-run setup, and invite
> redemption.

### Redeeming with a social account

Because OAuth sign-in links and never creates, a bare `signIn(provider)` on an
invitation can only ever answer 403 — the account does not exist yet. The two
facts also arrive at different moments: the browser has the invitation token
from the start, and a verified identity exists only after the provider
redirects back.

**Every provider the deployment offers goes through this**, not just Google.
Redemption is the only way a social account comes to exist, so a provider the
invitation page fails to offer is one nobody can ever sign in with — the
sign-in and invitation screens share a single provider list
(`components/auth/oauth-providers.tsx`) so they cannot drift.

```
/invite/<token>  ──POST /api/invite/handoff──▶  sr_invite cookie (httpOnly, lax, 10 min)
       │
       └─ signIn("google") ──▶ Google ──▶ Auth.js `signIn` callback
                                              │ reads sr_invite
                                              ▼
                                    POST /auth/invite/accept
                                    { token, oauthProvider, oauthToken }
                                              │
                            201 { user, sessionId } ──▶ JWT `sid`
```

The token rides in a cookie rather than the OAuth `state`, which Auth.js owns
and signs for its own CSRF purposes. `httpOnly` keeps it away from page scripts;
`lax` is required, because `strict` drops the cookie on exactly the top-level
redirect back from Google that it exists to survive. It is burned the moment it
is spent, successfully or not, so a failed attempt can't be replayed.

A redemption that bounces because the person picked the wrong account (403)
returns them to `/invite/<token>?error=email_mismatch` with something they can
act on, rather than Auth.js's generic error screen.

A **dead** invitation falls through to an ordinary sign-in instead. The handoff
cookie outlives an abandoned attempt by up to its max-age, so a plain sign-in
started inside that window would otherwise be dragged through a redemption that
cannot succeed; falling through gives that person what they actually asked for.

**This is the one redemption path that opens a session server-side**, and the
asymmetry is deliberate: the OAuth caller holds a one-shot token and cannot
start the round-trip again, so the session has to come from the redemption. The password path lets the ordinary credentials sign-in mint it a
moment later, exactly as `/auth/setup` does.

## Password policy

Aligned to NIST 800-63B, which is what auditors reference and is mostly a
list of things *not* to do. Enforced by `services/password.ts` on **every**
path that writes a password — first-run setup, invite redemption, reset,
and change — because the weakest password on a deployment is usually the
first one anyone set.

- **8 to 64 characters**, counted in code points. Everything allowed,
  including spaces.
- **No composition rules.** No "must contain a symbol".
- **No forced expiry.** Scheduled rotation makes people choose worse
  passwords; rotate on evidence of compromise.
- **A 72-byte guard.** bcrypt truncates there and says nothing about it, so
  64 emoji would have a decorative tail. Refused rather than silently cut.
- **Checked against known-breached passwords** via HaveIBeenPwned's range
  API using k-anonymity: only the first five characters of the SHA-1 leave
  the process, and `Add-Padding` keeps response size from leaking the
  prefix's hit count.

The breach check **fails open**, with a logged reason, for a
reason a hosted product doesn't have: an on-prem deployment may have no
egress at all, and failing closed would make the first admin account
uncreatable — locking an operator out of their own install to enforce a
defence-in-depth check. `PASSWORD_BREACH_CHECK=off` disables it explicitly,
which is the honest thing for an air-gapped site to do rather than relying
on a silent timeout every time.

## Password reset

**An admin never chooses someone else's password.** They generate a *link*,
and the holder chooses the value. That makes a takeover *visible*, not
impossible: the admin holds the link and could use it themselves. What they
cannot do is set a password silently — `password_resets.created_by` records
who generated each link, and `password.reset_completed` names that admin when
their link is redeemed. (lava-connect's equivalent takes a password in the
body, which leaves nothing to see.)

| | Managed | On-prem |
|---|---|---|
| Started by | the holder — **not available**: see below | an admin |
| Endpoint | `POST /auth/password/forgot` | `POST /api/team/members/:id/reset-link` |
| Delivery | — | link returned once, handed over |
| TTL | 1 hour | 24 hours |
| `created_by` | null | the admin's id |

**Self-serve reset fails closed.** `POST /auth/password/forgot` answers `404`
on every deployment, for every address, and writes nothing, because there is
no way to deliver a link — email is MAG-2870. Issuing one would look delivered
while reaching nobody, and would invalidate any live link the member holds.

An admin starts one from the member's row on the Team page, which shows the
link once; it lands on `/reset/<token>`. A new link kills any earlier one.

`POST /auth/password/reset`, in **one transaction**, claims the token with a
conditional update, writes the hash, **revokes every session for the account**
— per-device rows *and* the `signed_out_all_at` cutoff — and **clears the
account's lockout**. A reset is what someone does when they think they are
compromised; the transaction is what stops a failure part-way from leaving an
attacker's session alive under the new password. Clearing the lockout lets the
owner use the new password at once; it does not stop anyone re-tripping it.

It does **not** sign anyone in. A reset link that logs you in is a reset link
worth stealing.

<img src="./assets/password-reset.png" alt="The password reset page: a card headed &quot;Choose a new password&quot;, with new-password and repeat-password fields and a note that setting it signs out every device on the account, that any characters are accepted from 8 to 64, and that the password is checked against known breached passwords." width="420">

**Changing your own password** (`POST /api/account/password`) requires the
current one and signs out your *other* devices, keeping the tab you are in.
Checking the current password is a credential guess, so it carries sign-in's
per-IP limit **and** spends from the account's budget below.

For an account with no password — one that signs in through a linked provider
— both this and the admin's reset link say which provider it uses.

## Sign-in lockout

Each address has a budget of **5 attempts per 15 minutes**, counted whether or
not an account exists, case-insensitively — so a lockout says nothing about
membership. Past it, sign-in and the current-password check both answer `423`
with `Retry-After`, and the login form says the account is locked rather than
that the password is wrong.

The attempt is **counted before the credential is checked**: the upsert hands
each request its own count, so a parallel burst gets exactly the budget, not
one guess per request that passed a read before any count moved. A correct
credential refunds the window.

The budget is per **identity**, which is why it holds where a per-IP limit does
not: with the api reachable directly and `TRUST_PROXY` at its default, a caller
chooses its own `X-Forwarded-For`, and the per-IP limit follows.

> **The trade-off.** Anyone who knows an address can keep that account locked
> by spending its budget every window, and the correct password is refused
> while it is. A reset clears the lock, but it can be re-tripped. The way back
> in for a locked admin is the database:
>
> ```sql
> DELETE FROM login_attempts WHERE email = lower('admin@example.com');
> ```

`signin.blocked` names the account (when there is one), the address and how
many attempts this window. Sign-in costs one bcrypt whether or not the address
has an account — a decoy hash stands in — so timing does not answer the
question the identical `401` refuses to.

Rows whose window has lapsed are **pruned on every attempt**, a bounded batch
over an index on `window_start`, so the table is sized by attempts per window
rather than attempts ever.

## Sign-in methods

- **Email + password** — always available in enabled mode. Verified
  api-side (`POST /auth/sign-in`, bcrypt cost 12, enumeration-proof
  responses), which also opens the session row and returns its id.
  Accounts come from first-run setup or an invitation — there is no
  self-serve sign-up.
- **Google / GitHub** — each provider's button appears on the
  login page **only when its `*_CLIENT_ID` + `*_CLIENT_SECRET` pair is
  set**. The web forwards the provider token to the api
  (`POST /auth/oauth/:provider`), which re-verifies it against the
  provider's own API (Google tokeninfo with `aud` pinning; GitHub
  `/user` + `/user/emails`) and resolves an
  existing account — by provider id, then by email, linking the provider.
  It never creates one; a new person redeems an invitation. Avatars are
  captured backfill-only — the first provider that supplies one wins.

  MAG-2729 puts social sign-in out of scope, on revocation grounds: a
  personal account outlives someone leaving the customer's company. Google
  and GitHub are offered by decision (2026-09-24) — removing a person from
  Team still ends every session they have, whatever they signed in with.
  Discord is not offered; its `discord_id` column is unwritten.

## Bootstrap admin seed — development only

With `ADMIN_EMAIL` + `ADMIN_PASSWORD` set **and `NODE_ENV` not
`production`**, `seedAdmin` runs at boot, idempotently: existing user with
that email → promoted to admin; empty users table → admin created;
populated table without that email → no-op.

**In production it is refused, and a warning names the variables.** It
predates first-run setup and fails three lines of the ticket at once — it
creates the first admin with no setup token, it sets a password for
somebody, and it leaves a standing admin account in a customer's
deployment for as long as the variables stay set. Both paths open on the
same condition, no active users, so leaving it enabled gives the room two
doors with a lock on one.

It stays for development because `make dev-auth` would otherwise need
somebody to walk through `/setup` after every `down -v`. `make accounts`
is the target that deliberately doesn't seed, and is the one to use for
exercising the real flow.

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AUTH_MODE` | api + web | `disabled` (default) / `enabled` — must match on both |
| `AUTH_SECRET` | api + web | HS256 signing secret, must match. `openssl rand -base64 32` |
| `DATABASE_URL` | api | Empty in both compose files. `make up-auth` / `make dev-auth` supply `postgres://sr:dev@postgres:5432/sr_dashboard`; only read when `AUTH_MODE=enabled` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | api | **development-only** admin seed; ignored (with a warning) when `NODE_ENV=production` |
| `INTERNAL_AUTH_SECRET` | api + web | Proves a caller is our own web tier, so forwarded browser IP / User-Agent are honoured. Unset ⇒ ignored, and sessions record what the api observes |
| `TRUST_PROXY` | api | How far to believe `X-Forwarded-For`. Hop count (default `1`), a comma list of proxy IPs/CIDRs, or `false` |
| `DEPLOYMENT_MODE` | api + web | `onprem` (default) / `managed` — forks invite and reset delivery |
| `SETUP_TOKEN` | api | First-run token. Unset ⇒ generated once at boot and logged |
| `SETUP_TOKEN_FILE` | api | Where to write a generated token (mode 0600) so an init container can surface it |
| `PASSWORD_BREACH_CHECK` | api | `hibp` (default) / `off` — turn the breach check off deliberately on an air-gapped site |
| `PUBLIC_WEB_ORIGIN` | api | Browser-facing origin of the web app; invitation and reset links are built from it. **No default in the api** — guessing a host would produce links that look right and go nowhere, so `POST /api/team/invites` answers 500 without it. The compose files default it to the web's `AUTH_URL`, which is the same origin by definition |
| `AUTH_URL` | web | Auth.js base URL (default `http://localhost:3000`) |
| `INTERNAL_API_BASE_URL` | web | server-side api URL for Auth.js callbacks (`http://api:8000` in compose) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | web (+ id on api) | unset = no Google button. The api needs the id to pin the token audience |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | web | unset = no GitHub button |

## Running it

```bash
# dev stack with auth — supplies the dev secret, database URL and seed admin:
make dev-auth
# sign in at http://localhost:3000/login as admin@example.com / admin1234
# (override any of them: ADMIN_EMAIL=you@example.com make dev-auth)

# prod-style — no seeded admin (the seed is refused under NODE_ENV=production):
AUTH_SECRET=$(openssl rand -base64 32) make up-auth
# open /login → it redirects to /setup; the setup token is in
# `docker compose logs api` (or set SETUP_TOKEN, 16+ characters)

# a fresh install with NO accounts, for exercising the account system:
make accounts          # on http://localhost:3000
make accounts-reset    # wipe the database and start from first-run again
```

`make accounts` is the stack for exercising the account system. It differs from
`make dev-auth` in the one way that matters: `dev-auth` seeds
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, so the deployment already has an account
and **the first-run page can never appear**. `make accounts` clears them,
supplies a setup token, and points invitation and reset links at
`localhost:3000`.

Dev credentials are deliberately guessable. The setup token is
`installer-printed-this-token`; in a real install it is printed by the
installer or read from `SETUP_TOKEN_FILE`.

### With auth off, the database is not merely unused

`AUTH_MODE=disabled` is the default in both compose files, and every auth
and database variable beside it is **empty** — no `DATABASE_URL`, no
`AUTH_SECRET`, no seed admin. That is deliberate rather than tidy:

- `migrate()` is reachable from exactly one place, `plugins/db.ts`, and that
  plugin is registered only inside the `authMode === "enabled"` branch of
  `app.ts`. No plugin, no connection, and **no migrations applied at all**.
- The `postgres` service sits behind the `auth` profile, so a default
  `docker compose up` does not create it.
- Nothing is left pointing at a database the stack is not using, and the
  dev stack no longer carries an administrator password for an account it
  is never going to create.

`apps/api/src/__tests__/auth.test.ts` pins this: with `AUTH_MODE=disabled`
and a `DATABASE_URL` deliberately set, the app has neither the `db` nor the
`dbReady` decorator. The values live in `make up-auth` / `make dev-auth`,
which is what turns the whole thing on.

## Trying the account system by hand

Roughly ten minutes end to end. Each step below is a thing the ticket
promises, in the order a real deployment meets them.

**1. First run.** Open <http://localhost:3000>. It redirects to `/login`,
which redirects to `/setup` — a deployment with no accounts has nobody to
sign in as. Create the first admin.

- Enter the wrong setup token first: refused. Without it, whoever reaches
  the URL between install and the operator sitting down becomes the admin.
- Try `correct horse battery staple` as the password: refused as breached
  (52,372,427 sightings). That is a live HaveIBeenPwned lookup, and the
  password never leaves the process — only the first five characters of
  its SHA-1 do. The check **fails open**, so on a machine with no egress
  it silently accepts everything; the honest setting there is
  `PASSWORD_BREACH_CHECK=off`, not a mystery timeout.
- Then a real one. You land signed in, on the dashboard.

**2. Invite someone.** Team → Invite. Pick a role; the description under
each says what it can do.

- On-prem has no mail server, so the link is shown **once** and you copy
  it. Open it in a private window: the invited address is fixed text, not
  a field — the account is created with the invitation's address, so there
  is nothing there that could disagree with it.
- Accept it. That person is now in the members table.
- Open the same link again: dead. Single-use.

**3. Change a role.** Team → Change role. It takes effect on whatever that
person has open *right now*, not at their next sign-in — the api reads the
role from the row on every request.

To watch that: sign in as them in a private window, leave the Team page
open, demote them to Read-only from your window, and have them act. The
admin-only controls stop working immediately.

**4. Remove someone.** Team → Remove. The dialog says what will happen,
because "remove" reads like a deletion and this deliberately is not one.
Their sessions die within one request, their name stays in the audit log,
and their address can be invited again as a new account — try it.

**5. Your own account.** Account → Change password signs out your *other*
devices and keeps the one you are using. Active sessions lists every
device with what it is and where from; sign one out and watch it go.

Sign in from a second browser to see two sessions, then use "Sign out
everywhere" — which signs out the tab you are in too, deliberately.

**6. Password reset, on-prem.** **An admin never sets someone else's
password** — they generate a link, and only the holder chooses the value.
Team → **Reset link** on a member's row. It asks first — a new link also
kills any the member already holds — then shows the link once, with a copy
button.

Twenty-four hours on-prem against a managed deployment's one, because the
link travels over a channel we don't control. Open it, set a password —
and note that it does **not** sign you in, and that it kills every session
that account had.

Two refusals worth seeing: a Google-only account answers 409 naming why
there is no password to reset, and a removed member answers 404.

**7. Lockout.** Five wrong passwords for the same address and the sixth
attempt is refused — `423`, even when that sixth one is right. The window
closes fifteen minutes after the **first** wrong password, not the fifth,
so hammering it doesn't extend the ban. A successful sign-in clears the
slate, or somebody who mistyped four times would spend the rest of the
window one slip from a lockout.

The count is keyed on the address whether or not an account exists, so a
lockout reveals nothing about who is a member — and a sign-in attempt
against an unknown address answers the same `401` a wrong password does.

**8. Export.** Team → Export CSV. This is the artifact an auditor asks for
first, and it is the whole member list, not the page you are looking at.
The two-factor column reads `—` in the table and is **blank** in the CSV,
rather than "No" — two-factor is MAG-2730 and has not shipped, so "No"
would be true today and wrong the day it does.

**9. The audit log.** Every step above wrote a row. There is no viewer yet
(MAG-2770), so read them directly:

```bash
docker exec smart-router-dashboard-dev-postgres-1 \
  psql -U sr -d sr_dashboard -c \
  "select occurred_at, action, actor_name, target_name, ip, client
     from audit_events order by occurred_at desc limit 20"
```

Note what is and isn't there: sign-ins carry an address and a device,
people-events don't — except `invite.redeemed`, which the ticket asks to
carry the address it was redeemed from — and no token, link or password
appears anywhere.

### What has no screen yet

One designed surface, named in `docs/ACCOUNTS-DESIGN.md` §6.3: the managed
reset "initiated by the user, from `/login`" has no "Forgot password?" link.
It is not missing UI alone — `POST /auth/password/forgot` answers 404 on
every deployment, because there is no way to deliver the link until email
exists (MAG-2870).

## Roles

Four cumulative roles, defined once in
`packages/shared/src/constants/roles.ts` and shared by the web and the api
so they can't drift into disagreeing about who may do what:

| Role | See dashboard and audit | Propose changes | Approve others' | Manage people |
|---|---|---|---|---|
| `read_only` | yes | no | no | no |
| `requester` | yes | yes | no | no |
| `approver` | yes | yes | yes | no |
| `admin` | yes | yes | yes | yes |

`roleAtLeast(role, minimum)` is the only comparison; an **unrecognised
role is unprivileged**, so a row written by a newer build during a rolling
deploy fails safe rather than open. The proposing/approving columns are
enforced by the config-change flow (MAG-2731) — this layer defines the
vocabulary and gates people-management.

The web uses the same helper to decide which controls to render. That is
**cosmetic only**: hiding a button is not a permission check, and the api
re-reads the live row on every request regardless.

## Members

The Team page lists everyone with access and exports it as CSV — the artifact
an access review asks for first. Every role can read it, because a review only
some people can see is not one; only an admin changes it.

- **A role change revokes nothing.** The gate reads the role from the row on
  every request, so a demotion lands on whatever the person has open. The Team
  page takes the caller's own admin controls from that row too (through the
  member list, polled every 30 seconds), not from the role in their token.
- **Removal is a state change, in one transaction.** Status becomes `removed`,
  the provider ids are cleared, `signed_out_all_at` is stamped, every live
  session is revoked, and any pending invitation to their address is revoked.
  The row stays, so the audit log keeps their name. The partial unique index on
  email and the cleared provider ids let the same person be invited back as a
  new account, Google login included. Each change writes its audit row in the
  same transaction, so a change the log can't record doesn't happen.
- **There is always an admin.** An admin can't demote or remove themselves.
  Each write locks the caller's and the target's rows and re-checks that the
  caller is still an admin, so two admins acting on each other at once can't
  both succeed. A sole admin sees a prompt to add a second one — a prompt,
  never a refusal, because admin has to stay transferable.
- **The export neutralises formula leads.** A field starting with `=`, `+`,
  `-`, `@`, a tab, CR or LF gets a leading apostrophe: display names are chosen
  by the people in the list, and the file opens in a spreadsheet. It starts
  with a UTF-8 byte-order mark, without which Excel reads it in the system code
  page, and line endings are CRLF (RFC 4180).
- **2FA shows an em dash, not "No",** until MAG-2730 ships.

<img src="./assets/team-members.png" alt="The Team page's Members tab: a table of five people with columns for member, role, 2FA, last active and joined. Two admins are listed first, then an approver, a requester and a read-only member, sorted by address within each role. The 2FA column shows an em dash for everyone; one member who has never signed in shows an em dash for last active. Every row except the signed-in admin's own has Change role, Reset password and Remove buttons. Under the table, a panel shows a password reset link for one member, with a note to hand it over, that it works once until a stated time, and that any earlier link no longer works." width="100%">

## JWT shape

```ts
{ sub: userId, email, role, sid, iat, exp }
```

HS256, 30-day TTL, `iss: smart-router-dashboard-web`,
`aud: smart-router-dashboard-api` (enforced on both sides so no other
HS256 token signed with the same secret can pose as a session).

`role` is **advisory** — it is what the role was at issue time, kept so
the web can render affordances without a round-trip. Authorisation always
reads the live row.

`sid` is the load-bearing claim: it names a row in `sessions`, and a token
without one is refused outright, since nothing about it could be checked
or revoked.

## Migrations: the two ways they silently do nothing

Drizzle decides what to apply from **one number**, and it is worth knowing
exactly which, because both failure modes report success.

`packages/db` migrations run on api boot. The migrator reads the single
highest `created_at` from `__drizzle_migrations` **once, before the loop**,
then applies every entry whose `when` is strictly greater. It writes a
`hash` column and never compares it.

Two consequences:

- **An edited migration is never re-applied.** The hash is recorded but
  unused, so changing an already-applied file is a no-op on any database
  that ran it. Fine while nothing is deployed; not a thing to rely on later.
- **A migration inserted *below* the high-water mark is skipped**, on any
  database that is already migrated. This is the one that bites, because
  parallel branches produce it naturally: two tickets each add a migration,
  and the one that ends up with the lower `when` is invisible to anybody
  who already ran the other.

The account and audit work met it on the way to main. The audit migration
is `0004_audit` (`when` 1787126400000), after main's
`0003_password_lifecycle` (1787040000000) and before `0005_magma_account`
(1788048000000). On the stack branches it was `0002_audit`, with the same
`when` as the invitations migration — so a database built from those
branches holds a history main's journal does not describe. Depending on how
far it got, `0004_audit` either re-runs there (`CREATE TYPE` against a type
that exists, and boot fails) or is silently skipped.

```bash
# The fix, and the only one — re-migrate from empty:
docker compose -f docker-compose.dev.yml --profile auth down -v
```

Only developer machines are affected: nothing deployed sets
`AUTH_MODE=enabled`, so no deployment has a `users` table, let alone a
migration history. CI is unaffected too — every suite builds its database
from empty, where the high-water mark does not exist and entries apply in
array order regardless of their timestamps.

> **Never change the `when` of a migration a database may already hold.** It
> is the obvious repair and it trades a silent skip for a hard failure: on a
> database that ran the migration, a raised stamp is *greater than the mark
> again*, so it **re-runs** — `CREATE TYPE` against a type that already
> exists, and boot fails. Tested, not reasoned: applying `0000`–`0002`,
> bumping the entry, and re-migrating throws.
>
> A stamp is safe to set only before anything outside a branch has run it —
> which is why the audit migration could be renumbered while it existed on
> the stack branches alone, and why, once a migration is on `main`, the
> answer is always a new migration and never a new timestamp.

**The general form, worth asking of anything before calling it verified:**
*what does this look like on a machine that already has state?* Every suite
here builds from empty, so a green run says nothing about an existing
database — and this is the third failure in this work that was invisible
exactly where it would be looked for. The audit log dropped rows for most
real browsers while every test passed, because a Mac Chrome User-Agent fits
in 128 characters and an iPhone's does not. The audit cursor's ordering
hazard passes every single-writer test because it needs two overlapping
transactions to appear. And this one passes every fresh-database migration.

## Sessions and revocation

Every authenticated request resolves `sid` to a session joined to its
account, and refuses the request if any of these hold:

| Condition, in the order checked | Response |
|---|---|
| No session row | `401` · `SESSION_INVALID` |
| Account `status` is `suspended` or `removed` | `403` · `ACCOUNT_INACTIVE` |
| `revoked_at` set, or past `expires_at` | `401` · `SESSION_INVALID` |
| Token `iat` at or before `users.signed_out_all_at` | `401` · `SESSION_INVALID` |
| Database not reachable yet | `503` · `AUTH_UNAVAILABLE` |

The account comes before the session because removal revokes every session:
the other way round, a removed person would only ever be told to sign in again.

The codes are machine-readable so the web can tell "sign in again" from
"you are not allowed" and stop rather than looping through the edge gate.
The web acts on exactly three of them — `401 SESSION_INVALID`, `401
AUTH_REQUIRED` on a request that carried a token, and `403 ACCOUNT_INACTIVE` —
by signing the browser out and going to `/login`, so a device revoked or
removed from somewhere else stops looking signed in. A route's own 401 (a wrong
current password), a role `403 FORBIDDEN`, and a `503` never sign anyone out.

**Two revocation mechanisms, both needed.** They do different jobs:

- `users.signed_out_all_at` — a cutoff compared to the token's `iat`.
  Kills every outstanding token in one write without enumerating
  anything. Stamped on password change, sign-out-everywhere, and removal.
  The comparison is `<=`, not `<`: both sides have one-second resolution,
  so a token minted in the same second as the revocation must lose, or an
  attacker racing the sign-out keeps a live session.
- `sessions.revoked_at` — kills one device. What makes the sessions list
  and "sign out this device" possible.

<img src="./assets/account-sessions.png" alt="The Account page: a Change password card with current, new and repeat fields and a note that other devices will be signed out while this one stays; an Active sessions card listing this device as Chrome on Linux, highlighted, and a second unrecognised device with its own Sign out button, plus a Sign out everywhere button; and a Delete account card whose notice says to ask an administrator to remove you, because removal is a state change and your name stays in the audit log." width="560">

Session rows are **never deleted on revoke** — a revoked session is
evidence, and the audit log's access events reference it. Expired rows
are pruned on a schedule.

There is deliberately **no cache** on the lookup. A cache is precisely
what would turn "revoked" into "revoked eventually", and the same request
already makes multi-second Prometheus round-trips, so one indexed join is
not the expensive part of anything.

## Client context (IP and device)

Session rows carry the IP, the raw User-Agent, and a parsed `client`
string ("Chrome 141 / macOS"). Getting these right needs care, because
**the api never sees the browser on the sign-in path**: Auth.js calls
`/auth/sign-in` from the web container, so `request.ip` there is the web
pod and the User-Agent is undici's.

So `authorize(credentials, request)` reads the browser's own address and
User-Agent from *its* request and forwards them — and the api believes
them **only** when the caller also presents `INTERNAL_AUTH_SECRET`. The
route is public, so without that check anyone could pin any address to
their own sign-in attempts and write a false trail. Unset ⇒ forwarded
context is always ignored and the api records what it observes.

Routes the browser calls **directly** never accept forwarded context;
they read `request.ip` themselves. The rule is that whichever party
terminated the browser's connection is the one that reports it.

Related: `TRUST_PROXY` decides how far `X-Forwarded-For` is believed when
deriving `request.ip`. It defaults to `1` (the immediate peer). It used to
be unconditionally "trust every hop", which on a publicly reachable api
lets any caller claim any address — and so walk straight past the per-IP
rate limit.

## Testing

`@sr/db/testing` exposes `createTestDb()`: a real Postgres (pglite, WASM,
in-process) with every migration applied, no Docker and no service
container. Used by the DB-backed api tests.

This matters because the behaviour the schema leans on hardest is exactly
what a hand-rolled fake cannot reproduce — the partial unique index on
`lower(email)`, conditional single-use updates whose correctness depends
on a real rowcount, and cascade-on-delete.

> **Where pglite is not enough.** It is a real Postgres, but it is reached
> through a different driver, and the drivers do not agree about parameter
> serialisation. A bare JS `Date` interpolated into a `sql` template works
> under pglite and throws under postgres-js
> (`ERR_INVALID_ARG_TYPE: Received an instance of Date`) — so a green test
> suite is not proof the production driver is happy.
>
> Prefer computing values **in SQL** (`now()`, `make_interval(...)`) over
> interpolating JS values into raw templates: it sidesteps the divergence, and
> for anything time-based it is more correct anyway, since the app and the
> database can disagree about the clock.
