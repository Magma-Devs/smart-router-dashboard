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
                             │  authorize() → POST api /auth/sign-in     (bcrypt verify)
                             │  signIn()    → POST api /auth/oauth/:p    (server-side token verify)
                             ▼
                       HS256 session JWT  (jose, AUTH_SECRET,
                        iss=smart-router-dashboard-web,
                        aud=smart-router-dashboard-api)
                             │
Browser ── Authorization: Bearer <same JWT> ──▶ Fastify api (@fastify/jwt)
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
  decorates `request.authUser`, and 401s any non-public route without a
  valid token. Public: `/health*`, `/version`, `/auth/*`, `/docs*`.
- **Database** (`packages/db`) — Drizzle + Postgres, a single `users`
  table. The api's db plugin connects **lazily with retries** (no
  compose `depends_on`), runs migrations, then seeds the admin. `/auth/*`
  returns 503 until the DB is reachable; everything else never blocks.

## Sign-in methods

- **Email + password** — always available in enabled mode. Verified
  api-side (`POST /auth/sign-in`, bcrypt cost 12, enumeration-proof
  responses). Accounts come from the admin seed or OAuth — there is no
  self-serve sign-up.
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

## JWT shape

```ts
{ sub: userId, email, role: "admin" | "member", iat, exp }
```

HS256, 30-day TTL, `iss: smart-router-dashboard-web`,
`aud: smart-router-dashboard-api` (enforced on both sides so no other
HS256 token signed with the same secret can pose as a session).

## Session lifetime & revocation — honest limits

Tokens are validated **statelessly**: the api checks the signature,
issuer/audience, and expiry — it does not re-read the user row per
request. Consequences to know:

- **Suspending a user** (`users.is_suspended`) blocks their *next
  sign-in*; an already-issued JWT keeps working until it expires (30d).
- **Deleting a user** likewise does not invalidate their outstanding JWT.
- The `users.signed_out_all_at` column is **reserved** — nothing reads it
  yet. Porting lava-connect's `requireAuthFresh` (per-mutation DB
  freshness check) is the follow-up if instant revocation is needed.
- Until then, the operational kill switch is **rotating `AUTH_SECRET`**
  (both containers) — every outstanding session becomes invalid at once.

For an observability dashboard this trade (stateless hot path, coarse
revocation) is deliberate; the metrics surface never touches the DB.
