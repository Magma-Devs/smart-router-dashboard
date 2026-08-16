# Authentication

The dashboard has two auth modes, selected by the `AUTH_MODE` env var
(same value on the api **and** the web):

| Mode | What it means |
|---|---|
| `disabled` *(default)* | Today's behaviour — no login, no database, every route open. The zero-dependency self-hosted posture. |
| `enabled` | Auth.js v5 sign-in (email+password, plus OAuth), Postgres-backed users, HS256 JWT shared between web and api. `/api/*` requires a Bearer token. |

The implementation is a trimmed port of `lava-connect`'s auth stack — same
JWT codec, same plugin layout, same seed semantics.

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
| First admin | we create it, email a join link | first-run page + the installer's setup token |
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
api boot, AUTH_MODE=enabled, no active users
  ├─ SETUP_TOKEN set?  → use it            (helm: value lives in a Secret)
  └─ else              → generate 32 bytes, log once at warn,
                         write to SETUP_TOKEN_FILE when set
```

Generating rather than disabling setup is deliberate: an operator who
forgot to configure a token should still be able to finish the install,
from a value only log or filesystem access reveals.

<img src="./assets/first-run-setup.png" alt="The first-run page: a single card headed &quot;Set up this dashboard — create the first administrator&quot;, explaining that nothing else opens until this is done and that the setup token is printed by the installer. Fields for the setup token, an optional name, email, password and repeat password, with a note that any characters are accepted from 8 to 64, that the password is checked against known breached passwords, and that there are no other rules and it never expires." width="450">

`POST /auth/setup` re-checks the zero-user condition **inside the
transaction**, behind an advisory lock — the check outside it is only
advice, and two people opening the page at the same moment would otherwise
both become admin. It then opens a session like any other sign-in, so the
operator is not left staring at a login page holding a password they just
set.

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
| Delivery | emailed | link returned to the admin, once, and handed over |
| TTL | 7 days | 24 hours |

**Resending mints a new token and kills the old link**, so it replaces the
attack surface rather than widening it. **Expiry needs no sweeper**: the first
read that observes it stamps `expired_noted_at` conditionally, which is what
lets `invite.expired` fire exactly once.

Every dead-link reason — used, revoked, expired, never issued — returns the same
message. The holder can't act on the difference, and distinguishing them would
tell a stranger which of those a guessed token hit.

<img src="./assets/invite-redemption.png" alt="The invitation redemption page: a card headed &quot;Join this dashboard&quot;, with a panel restating the invitation — the address it was sent to, shown as fixed text rather than an editable field, the role Approver, and a line describing what that role can do. Below it, optional name, password and repeat-password fields, a note that any characters are accepted from 8 to 64 and checked against known breached passwords, and an Accept invitation button." width="440">

> **OAuth is link-only from here on.** `upsertOAuthUser` used to fall through to
> an insert, which was correct while accounts came only from a seed. With
> invitations that is a hole big enough to walk through: anyone with a Google
> account could reach `POST /auth/oauth/google` and provision themselves.
> Account creation now lives in exactly two places — first-run setup, and invite
> redemption.

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

The shape is the same in both modes; only who starts it and how it travels
differ. What is identical, and is the point:

> **Nobody ever sets somebody else's password.** An admin on-prem generates a
> *link*; the account holder chooses the value. lava-connect's equivalent
> endpoint takes a password in the body, and that is precisely the design this
> rejects — it lets an admin take an account over and sign in as them, which is
> the takeover the audit log exists to make visible.

| | Managed | On-prem |
|---|---|---|
| Started by | the holder, from `/login` → "Forgot password" | an admin, from the members table |
| Endpoint | `POST /auth/password/forgot` | `POST /api/team/members/:id/reset-link` |
| Delivery | emailed | link returned once, handed over |
| TTL | 1 hour | 24 hours |
| `password_resets.created_by` | null | the admin's id — the column an auditor reads |

Both converge on `POST /auth/password/reset`, which claims the token with a
conditional update, writes the hash, and **revokes every session for the
account** — per-device rows *and* the `signed_out_all_at` cutoff. A reset is
what someone does when they think they are compromised; leaving the attacker's
session alive would defeat the entire exercise.

It does **not** sign anyone in. A reset link that logs you in is a reset link
worth stealing.

`/auth/password/forgot` always answers `202`, whether or not the address exists
and whether or not the account has a password at all — anything else turns it
into a way to ask "is this person a member?". On-prem it answers `404` with a
reason, because there is genuinely nowhere to send anything.

**Changing your own password** (`POST /api/account/password`) requires the
current one and signs out your *other* devices, keeping the tab you are in.
Being logged out of the window you just changed your password in is hostile;
logging out the other devices is the security value.

## Sign-in lockout

Per-IP limiting is not the control that matters — a distributed attacker
rotating addresses walks straight past it. `login_attempts` counts failures
against the **identity being targeted**: 5 in 15 minutes and the account is
locked for the rest of the window, answering `423` and emitting
`signin.blocked`.

Counted on the submitted address whether or not an account exists, and
case-insensitively. If only real addresses locked, the lockout itself would
answer the question sign-in refuses to answer.

## Sign-in methods

- **Email + password** — always available in enabled mode. Verified
  api-side (`POST /auth/sign-in`, bcrypt cost 12, enumeration-proof
  responses), which also opens the session row and returns its id.
  Accounts come from the admin seed or OAuth — there is no self-serve
  sign-up (invitations land in slice 3).
- **Google / GitHub / Discord** — each provider's button appears on the
  login page **only when its `*_CLIENT_ID` + `*_CLIENT_SECRET` pair is
  set**. The web forwards the provider token to the api
  (`POST /auth/oauth/:provider`), which re-verifies it against the
  provider's own API (Google tokeninfo with `aud` pinning; GitHub
  `/user` + `/user/emails`; Discord `/users/@me`) and upserts the user
  (find by provider id → link by email → create). Avatars are captured
  backfill-only — the first provider that supplies one wins.

## Bootstrap admin seed

On api boot with `ADMIN_EMAIL` + `ADMIN_PASSWORD` set, `seedAdmin` runs
idempotently: existing user with that email → promoted to admin; empty
users table → admin created; populated table without that email → no-op
(never silently inserts into a live install).

## Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `AUTH_MODE` | api + web | `disabled` (default) / `enabled` — must match on both |
| `AUTH_SECRET` | api + web | HS256 signing secret, must match. `openssl rand -base64 32` |
| `DATABASE_URL` | api | `postgres://sr:dev@postgres:5432/sr_dashboard` in compose |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | api | bootstrap admin seed |
| `INTERNAL_AUTH_SECRET` | api + web | Proves a caller is our own web tier, so forwarded browser IP / User-Agent are honoured. Unset ⇒ ignored, and sessions record what the api observes |
| `TRUST_PROXY` | api | How far to believe `X-Forwarded-For`. Hop count (default `1`), a comma list of proxy IPs/CIDRs, or `false` |
| `DEPLOYMENT_MODE` | api + web | `onprem` (default) / `managed` — forks invite and reset delivery |
| `SETUP_TOKEN` | api | First-run token. Unset ⇒ generated once at boot and logged |
| `SETUP_TOKEN_FILE` | api | Where to write a generated token (mode 0600) so an init container can surface it |
| `PASSWORD_BREACH_CHECK` | api | `hibp` (default) / `off` — turn the breach check off deliberately on an air-gapped site |
| `PUBLIC_WEB_ORIGIN` | api | Browser-facing origin of the web app; invitation and reset links are built from it. No default — guessing a host would produce links that look right and go nowhere |
| `AUTH_URL` | web | Auth.js base URL (default `http://localhost:3000`) |
| `INTERNAL_API_BASE_URL` | web | server-side api URL for Auth.js callbacks (`http://api:8000` in compose) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | web (+ id on api) | unset = no Google button. The api needs the id to pin the token audience |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | web | unset = no GitHub button |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | web | unset = no Discord button |

## Running it

```bash
# dev stack with auth (postgres joins via the auth profile):
AUTH_MODE=enabled docker compose -f docker-compose.dev.yml \
  --profile router --profile auth up --build

# sign in at http://localhost:3000/login with the dev-default seed:
#   admin@example.com / admin1234        (override via ADMIN_EMAIL/ADMIN_PASSWORD)

# prod-style:
AUTH_MODE=enabled AUTH_SECRET=$(openssl rand -base64 32) \
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=change-me \
  docker compose --profile router --profile auth up -d --build
```

> The dev compose ships working defaults (`admin@example.com` /
> `admin1234`, a fixed dev `AUTH_SECRET`) so `AUTH_MODE=enabled` works
> out of the box. **Production must override all three.**

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

## Sessions and revocation

Every authenticated request resolves `sid` to a session joined to its
account, and refuses the request if any of these hold:

| Condition | Response |
|---|---|
| No session row, or `revoked_at` set, or past `expires_at` | `401` · `SESSION_INVALID` |
| Account `status` is `suspended` or `removed` | `403` · `ACCOUNT_INACTIVE` |
| Token `iat` at or before `users.signed_out_all_at` | `401` · `SESSION_INVALID` |
| Database not reachable yet | `503` · `AUTH_UNAVAILABLE` |

The codes are machine-readable so the web can tell "sign in again" from
"you are not allowed" and stop rather than looping through the edge gate.

**Two revocation mechanisms, both needed.** They do different jobs:

- `users.signed_out_all_at` — a cutoff compared to the token's `iat`.
  Kills every outstanding token in one write without enumerating
  anything. Stamped on password change, sign-out-everywhere, and removal.
  The comparison is `<=`, not `<`: both sides have one-second resolution,
  so a token minted in the same second as the revocation must lose, or an
  attacker racing the sign-out keeps a live session.
- `sessions.revoked_at` — kills one device. What makes the sessions list
  and "sign out this device" possible.

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
