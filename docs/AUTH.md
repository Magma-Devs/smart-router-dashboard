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
