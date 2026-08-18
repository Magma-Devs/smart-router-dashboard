# Accounts and team — design

Technical design for [MAG-2729](https://magmadevs.atlassian.net/browse/MAG-2729)
(epic [MAG-2686](https://magmadevs.atlassian.net/browse/MAG-2686)): replacing the
dashboard's shared login with named users — roles, sessions, invitations,
credential lifecycle, and the member record an auditor reads.

Written to be built from. Every table, route and flow below is a decision, not a
sketch. Supersedes [`docs/AUTH.md`](AUTH.md) once slice 1 lands; until then that
document describes what actually ships.

> **Status:** all six slices built and open as PRs (#111, #118–#122) · 3 open
> decisions (§16). **§16.1 and §16.3 are answered; nothing blocks #111** — see below.

---

## 1. Goals and non-goals

DFNS will not make real configuration changes through the dashboard until it meets
their SOC 2 requirements. Today every customer deployment shares one username and
password. This is not "add roles to the login we have" — it is the account system,
and every other task in the epic needs a named actor to attribute rows to.

### Goals

1. People sign in as themselves; the shared login stops working at the same moment.
2. An on-prem install bootstraps its own first admin, and refuses to without the
   installer's setup token.
3. Admins invite, demote and remove people — and each takes effect on the target's
   *current* session.
4. Credentials follow NIST 800-63B: breach-checked, rate-limited, no forced expiry,
   no composition rules.
5. Every people and account event lands in the audit log with enough context to
   investigate.
6. The member list exports — that is the access-review artifact auditors ask for first.

### Non-goals

- **Explicitly out per the ticket:** billing and plans · SSO · SCIM · LDAP · any
  integration with a customer's own identity system. We hold the accounts.
- **Owned by siblings:** the audit log itself — table, viewer, export, read API — is
  [MAG-2770](https://magmadevs.atlassian.net/browse/MAG-2770); 2FA is MAG-2730; the
  config-change approval flow is MAG-2731. This task emits into the first and leaves
  seams for the others.
- **Not in scope:** alerting on audit events, forwarding to a customer's SIEM, and the
  operational (relay-level) log.

---

## 2. Context and constraints

### 2.1 What exists

`AUTH_MODE=enabled` already provides a skeleton and it stays: Auth.js v5 on the web,
an HS256 JWT the api validates via `@fastify/jwt`, Drizzle + Postgres, bcrypt cost 12,
server-side OAuth verification, and an idempotent `ADMIN_EMAIL` seed. What it cannot
do is the rest of this document: the role enum is `admin | member` and **is never
checked anywhere**, tokens are validated statelessly so a role is frozen for 30 days,
and there is no invitation, reset, session record, member lifecycle or password policy
of any kind.

### 2.2 Two deployment shapes

**Managed** — we host, email works. **On-prem** — the customer hosts, and there is no
mail server and never will be. Every credential-delivery path therefore exists twice:
a link the system emails, and a link an admin copies out of the UI and hands over.
This is the single biggest structural constraint in the design; see §8.

### 2.3 What we take from lava-connect

`Magma-Devs/lava-connect` is the repo this codebase was shaped after and carries a
mature account system. It solves the *security primitives* and has *no team model at
all* — no organisation, no invitation, no multi-user tenancy.

| From lava-connect | Built here |
|---|---|
| `requireAuthFresh` / `requireAdminFresh` · the `jti`-per-sign-in mint · `isBreachedPassword` (HIBP) · lockout counters · the signed single-use link shape · the managed reset flow · `services/csv.ts` · SES email + templates · `verifyGithubTokenBelongsToOurApp` | Invitations · the four-role model · first-run and the setup token · removal as a state change · access events in the audit log · everything on-prem |

> **Constraint: no Redis, and no fail-open.**
> lava-connect keeps sessions, lockout counters and single-use token claims in Redis,
> and every helper opens with `if (!redis) return <permissive default>` —
> `isSessionActive` returns `true`, the lockout never trips, a reset link stays
> replayable. Defensible for a hosted SaaS that always has Redis. Not shippable here:
> "we can revoke a session, unless Redis is down, in which case we can't and nothing
> tells you" is a failed control, not a degraded one.
>
> **Decision: same designs, Postgres storage.** `AUTH_MODE=enabled` already requires
> Postgres, so this adds nothing to an on-prem install, fail-closed is the natural
> behaviour, and MAG-2770 needs sessions as durable audit data rather than
> TTL-evicting cache entries anyway. Cost is ~200 lines rewritten instead of copied.

Three semantics in lava-connect are the *opposite* of what this ticket requires, and
the closest-looking flows are the wrong ones to copy: its admin reset endpoint lets an
admin **choose** another user's password (§7); `DELETE /admin/users/:id`
**hard-deletes** the row (§4.1); and it **blocks** removing the last admin (§3.3).

---

## 3. Role model

### 3.1 The four roles

Cumulative — each role includes everything below it — so they are stored as an enum
and compared as an ordinal rather than expanded into a permission matrix.

| Role | Ord | See dashboard and audit | Propose changes | Approve others' | Manage people | Self-approve |
|---|---|---|---|---|---|---|
| `read_only` | 0 | yes | no | no | no | no |
| `requester` | 1 | yes | yes | no | no | no |
| `approver`  | 2 | yes | yes | yes | no | no |
| `admin`     | 3 | yes | yes | yes | yes | yes |

`roleAtLeast(role, min)` lives in `@sr/shared` so the web and api can never disagree
on the ordering. Columns 2–3 and 5 are enforced by MAG-2731; this task owns columns 1
and 4 and provides the helper everything else gates on.

### 3.2 Where it is enforced

| Surface | Minimum | Freshness |
|---|---|---|
| `/api/metrics/*`, `/api/config/*` | `read_only` | cheap — JWT claims only |
| `GET /api/team/*`, `GET /api/account/*` | `read_only` | cheap |
| Every `/api/*` mutation | route-specific | **fresh** — live user row |
| `POST\|PATCH\|DELETE /api/team/*` | `admin` | **fresh** |

Reads use the cheap path because they are idempotent and the next mutation catches a
stale token; mutations always re-read the row, which is what makes "role is read at
the moment of the action" true. The web mirrors `roleAtLeast` for affordances only —
**never** as the gate.

### 3.3 Rules that are not permissions

- **Nobody demotes or removes themselves.** Checked api-side, not just hidden in the UI.
- **One admin is a prompt, not a block.** While exactly one admin exists, the members
  screen says so and suggests adding a second — but nothing is prevented. Admin has to
  stay transferable, or a departing employee's account cannot be removed. A deliberate
  divergence from lava-connect, which refuses to remove the last admin.
- **Demoting below `approver`** cancels anything waiting on that person (§16, hook
  owned by MAG-2731).

---

## 4. Data model

One migration, `packages/db/migrations/0001_accounts.sql`. Start it with drizzle-kit,
then hand-edit — drizzle-kit will not reliably produce the enum swap, and the
existing-row remap is a decision, not something to generate.

### 4.1 `users` — changed

| Column | Change | Why |
|---|---|---|
| `role` | **swap** to new enum `read_only · requester · approver · admin` | Four cumulative roles. Existing rows remapped — §16.1 |
| `status` | **new** enum `active · suspended · removed`, replaces `is_suspended` | Removal is a state change, not a row deletion. Two overlapping "can this person sign in" concepts is a bug factory |
| `removed_at` · `removed_by` | **new** | Who removed whom, when — the row an auditor reads |
| `password_updated_at` | **new** | Surfaced on the account page; feeds nothing else (no forced expiry) |
| `last_active_at` | **new** | The member list's "last active". Written from session heartbeat, ≤1/min |
| `signed_out_all_at` | **enforced** — stops being reserved | Bulk revocation cutoff. **Kept alongside the session table, not instead of it** — §5.3 |
| `users_email_lower_idx` | **partial**: `WHERE status = 'active'` | Without this, "their email can be invited again later" is impossible |

> **Migration gotcha.** `ALTER TYPE … ADD VALUE` cannot be used in the same transaction
> that adds it, and Drizzle runs each migration file in one. Create a new enum type and
> swap the column with `USING` — which is also where existing rows are remapped.

### 4.2 `sessions` — new

```
id              uuid pk
user_id         uuid not null references users(id) on delete cascade
created_at      timestamptz not null default now()
last_seen_at    timestamptz not null default now()
expires_at      timestamptz not null            -- created_at + 30d, no idle timeout
revoked_at      timestamptz
revoked_by      uuid                            -- null = self / system
revoked_reason  text                            -- 'self' | 'sign_out_all' | 'password_change'
                                                --   | 'member_removed' | 'admin'
ip              inet
user_agent      text
client          varchar(128)                    -- parsed once: "Chrome 141 / macOS"
auth_method     varchar(32) not null            -- 'password' | 'google' | 'invite'

index (user_id) where revoked_at is null
index (expires_at)                              -- for the prune job
```

`client` is parsed at creation, never on read — it is what the audit log records and it
must not change if we swap UA parsers later. Expired rows are pruned on a schedule;
they are not deleted on revoke, because a revoked session is evidence.

### 4.3 `invitations` — new

```
id                uuid pk
email             varchar(255) not null          -- stored lowercased
role              user_role not null
token_hash        bytea not null                 -- sha256 of the raw token; the raw token
                                                 --   exists only inside the link
created_by        uuid not null references users(id)
created_at        timestamptz not null default now()
expires_at        timestamptz not null           -- managed 7d · on-prem 24h
redeemed_at       timestamptz
redeemed_user_id  uuid
revoked_at        timestamptz
revoked_by        uuid
expired_noted_at  timestamptz                    -- stamped once when first observed expired,
                                                 --   so `invite.expired` fires exactly once
resend_count      integer not null default 0

unique index (token_hash)
index (lower(email)) where redeemed_at is null and revoked_at is null
```

Single-use is a conditional update, not a read-then-write:

```sql
UPDATE invitations
   SET redeemed_at = now(), redeemed_user_id = $newUserId
 WHERE id = $id
   AND redeemed_at IS NULL
   AND revoked_at IS NULL
   AND expires_at > now()
```

Zero rows affected means the invite was already used, revoked or expired — reject. The
update and the `users` insert run in **one transaction**, so a crash between them
cannot produce a redeemed invite with no account, or an account with a still-live invite.

### 4.4 `password_resets` — new

```
id           uuid pk
user_id      uuid not null references users(id) on delete cascade
token_hash   bytea not null
created_by   uuid                               -- null = self-serve (managed);
                                                --   set = admin-generated (on-prem).
                                                --   This is the column an auditor looks for
created_at   timestamptz not null default now()
expires_at   timestamptz not null               -- managed 1h · on-prem 24h
used_at      timestamptz

unique index (token_hash)
```

### 4.5 `login_attempts` — new

Per-account lockout, replacing lava-connect's Redis counter. One row per identity per
window; bumped on failure, cleared on success.

```
email         varchar(255) pk                   -- lowercased; exists even for unknown
                                                --   addresses, so lockout leaks nothing
failed_count  integer not null default 0
window_start  timestamptz not null default now()
locked_until  timestamptz
```

A write per failed sign-in is the cost of not running Redis. At dashboard volumes that
is negligible, and successful sign-ins clear the row rather than accumulating.

---

## 5. Session and auth architecture

### 5.1 The transport stays a JWT

The web↔api contract is unchanged: Auth.js signs an HS256 JWT with the shared
`AUTH_SECRET`, and `lib/api-client.ts` attaches it as a Bearer. What changes is that
the token now carries a `sid` claim naming a row in `sessions`, and the api resolves
that row on every request.

```
claims  { sub, email, role, sid, iat, exp, iss, aud }
        iss = smart-router-dashboard-web
        aud = smart-router-dashboard-api        (both enforced, as today)
```

`role` stays in the token for cheap reads, but it is **advisory**: every mutation
re-reads it. `sid` is the only claim that is load-bearing.

### 5.2 The session is minted by the api, not the web

A deliberate departure from lava-connect, which fires a separate
`POST /me/sessions/register` from the `jwt()` callback. That call runs server-side in
the web container and forwards no client headers, so what the api records is whatever
it sees from the web pod — never the browser. Since MAG-2770's access events are built
on exactly those fields, inheriting it would make them useless.

```
 browser            web (Auth.js)                api                     postgres
   |  POST /login      |                          |                        |
   |------------------>| authorize(creds, request)|                        |
   |                   |  reads the browser's user-agent + x-forwarded-for |
   |                   |  from `request`          |                        |
   |                   |-- POST /auth/sign-in --->| lockout check -------->|
   |                   |   { email, password,     | verify bcrypt          |
   |                   |     clientContext }      | INSERT sessions ------>|
   |                   |   X-Internal-Auth: <s>   | audit signin.succeeded |
   |                   |<-- 200 { user, sessionId}|                        |
   |                   | jwt(): token.sid = sessionId                      |
   |<-- cookie --------| encode(): HS256 w/ sid   |                        |
   |                   |                          |                        |
   |  GET /api/...     |                          |                        |
   |-------------------+-- Bearer --------------->| verify sig + iss/aud   |
   |                   |                          | load session (x) user->|
   |                   |                          |  revoked? expired?     |
   |                   |                          |  status=active?        |
   |                   |                          |  iat > signed_out_all? |
```

One place creates the session, in the same transaction that records the sign-in and
writes the audit row. No fire-and-forget, no chicken-and-egg, and the client context
arrives with the request that knows it.

> **Trusting the forwarded client context.** `/auth/sign-in` is publicly reachable, so a
> caller-supplied IP is forgeable — an attacker could write their own audit trail. The
> api accepts `clientContext` **only** when the request carries the shared
> `INTERNAL_AUTH_SECRET` header, which only the web knows. Without it the field is
> ignored and the api falls back to `request.ip` — so a direct caller records their own
> real address rather than a chosen one.
>
> **Two trust paths, deliberately.** Only routes the web proxies — `/auth/sign-in` and
> `/auth/oauth/:provider` — accept a forwarded `clientContext`. Routes the browser calls
> directly (invite redemption, password reset) read `request.ip` and the `User-Agent`
> header natively and **must ignore any supplied `clientContext` entirely**. Same
> columns, two sources; the rule is that whichever party terminated the browser's
> connection is the one that reports it.
>
> **Related and live today:** `apps/api/src/app.ts:20` sets `trustProxy: true`
> unconditionally. On a publicly-reachable api that means anyone can set
> `X-Forwarded-For` and become any IP — which silently defeats the per-IP rate limit on
> `/auth/*`. Narrow it to the ingress CIDR as part of slice 1, and treat per-account
> lockout (§7.3) as the real control regardless.

Google sign-in follows the same path through `POST /auth/oauth/google`, reading the
client context via `next/headers` inside the `signIn()` callback. If that proves
unavailable in the Auth.js callback scope, the fallback is a single browser-originated
`POST /auth/session/context` immediately after sign-in, where the api reads
`request.ip` itself and no forwarding is involved.

### 5.3 Two revocation mechanisms, both required

They do different jobs, which is why lava-connect runs both and why §4.1 keeps
`signed_out_all_at` rather than replacing it:

| Mechanism | Kills | Fires on |
|---|---|---|
| `users.signed_out_all_at` cutoff, compared to the token's `iat` | every outstanding token, in one write, without enumerating anything | password change · password reset · sign-out-everywhere · member removal |
| `sessions.revoked_at` | one device | "sign out this device" · revoking a row from the sessions list · admin action |

Use `iat <= cutoff`, not `<`. Both sides have one-second resolution, and a token minted
in the same second as the revocation must lose — otherwise an attacker who races the
user's sign-out keeps a live session.

### 5.4 Cost

Every `/api/*` request now performs one indexed join. No cache: the same request
already makes multi-second Prometheus round-trips, so a sub-millisecond lookup is
noise, and a cache is the thing that would make revocation "eventually". If p99 ever
says otherwise, the escape hatch is a short-TTL cache on *reads only* — never on
mutations.

---

## 6. Flows

### 6.1 First run (on-prem)

Gated on **zero active users**, never a one-time flag — the ticket explicitly covers a
deployment restored from a backup with no users in it, and a flag would leave that
install permanently unopenable.

```
api boot, AUTH_MODE=enabled, count(users where status='active') = 0
  |- SETUP_TOKEN set?  -> use it
  \- else              -> generate 32 random bytes,
                          log once at warn, write to SETUP_TOKEN_FILE if set

 browser                        api
   | GET /                       |
   |- web asks GET /auth/bootstrap --> { needsSetup: true, mode: "onprem" }
   |<- redirect /setup           |      (the token itself is never returned)
   | POST /auth/setup            |
   |- { token, email, password } -> constant-time compare
   |                             | re-check zero active users *inside the tx*
   |                             | breach-check the password
   |                             | INSERT admin, audit setup.completed
   |<-- 201 ---------------------| -> sign in normally
```

The zero-user check is repeated inside the transaction with a lock, so two people
racing the first-run page cannot both become admin.

> **Coordination item.** MAG-2770's event table has no verb for first-admin creation.
> `setup.completed` needs adding there — it is the single most security-relevant row in
> the entire log.

### 6.2 Invitation

```
 admin                     api                                    invitee
   | POST /api/team/invites  |                                       |
   |- { email, role } ------>| requireRole(admin, fresh)             |
   |                         | token = 32 random bytes               |
   |                         | INSERT invitations (sha256(token))    |
   |                         | audit member.invited                  |
   |                         |                                       |
   |           managed ------+- email the link --------------------->|
   |<-- 201 { } -------------|                                       |
   |           on-prem ------+- 201 { url } (shown once, copyable) --+-> handed over
   |                         |                                       |
   |                         |<-- POST /auth/invite/preview ---------|
   |                         |      { token }                        |
   |                         |--> { email, role, expiresAt } --------|  (no user data)
   |                         |<-- POST /auth/invite/accept ----------|
   |                         |      { token, password }              |
   |                         |      | { token, googleIdToken }       |
   |                         |  ONE TRANSACTION:                     |
   |                         |   conditional UPDATE invitations      |
   |                         |   INSERT users (email = invite.email) |
   |                         |   INSERT sessions                     |
   |                         |  audit invite.redeemed                |
   |                         |--> 201 { user, sessionId } -----------|
```

- **The account is created with the invitation's email, never the submitted one.** That
  is what makes "redeemable only by the address it was sent to" structural rather than a
  check that can be forgotten.
- Google path: the verified `email` claim must equal the invite address
  case-insensitively *and* `email_verified` must be true. Mismatch → 403 with a message
  naming the invited address, so an honest user understands.
- **Resend** mints a new token, invalidates the old hash, resets the expiry, bumps
  `resend_count`, emits `invite.resent`.
- **Revoke** stamps `revoked_at`; the link dies immediately.
- **Expiry** needs no sweeper: the first time an expired invite is observed — on list or
  on a redemption attempt — `expired_noted_at` is stamped and `invite.expired` fires once.

### 6.3 Password reset

| | Managed | On-prem |
|---|---|---|
| Initiated by | the user, from `/login` | an admin, from the members table |
| Endpoint | `POST /auth/password/forgot` | `POST /api/team/members/:id/reset-link` |
| Delivery | emailed link | link returned once in the response, copied by the admin |
| TTL | 1 hour | 24 hours — it travels over a channel we don't control |
| Audit | `password.reset_requested` | `password.reset_link_generated`, actor = the admin |

Both converge on `POST /auth/password/reset { token, password }`, which breach-checks,
writes the hash, stamps `password_updated_at`, bumps `signed_out_all_at`, revokes every
session row, emits `password.reset_completed` — and **does not sign anyone in**. The
forgot endpoint always answers `202`, whether or not the address exists.

> **An admin never sets another person's password.** The ticket is explicit ("Nobody
> sets somebody else's password, ever"), and lava-connect's
> `POST /admin/users/:id/reset-password` — which takes a password in the body — is
> precisely the endpoint not to port. An admin generates a link; only the account holder
> chooses the value. A Google-only account has no password to reset, and the UI says so
> rather than silently doing nothing.

### 6.4 Removal and demotion

Removal is a **state change**. One transaction:

```sql
UPDATE users SET status='removed', removed_at=now(), removed_by=$actor,
                 signed_out_all_at=now()         WHERE id=$target;
UPDATE sessions SET revoked_at=now(), revoked_reason='member_removed'
                                                 WHERE user_id=$target AND revoked_at IS NULL;
UPDATE invitations SET revoked_at=now()          WHERE lower(email)=$email AND redeemed_at IS NULL;
-- onMemberDeactivated($target, 'removed')       hook, implemented by MAG-2731
-- audit member.removed
```

Their sessions die within one request, their name stays in the audit log permanently,
and the partial unique index frees the address so it can be invited again under a new
account. Removal needs no approval — a confirmation dialog naming the person is enough.

Demotion is the same shape minus the status change: update the role, call the hook when
the new role is below `approver`, emit `member.role_changed` with from/to. No session is
revoked, because the role is re-read on the next action anyway.

---

## 7. Credential policy

### 7.1 Storage and shape

- **bcrypt, cost 12** — retained. NIST names bcrypt and argon2 both, hashes already
  exist in the field, and there is no reason to migrate.
- **8–64 characters, everything allowed including spaces.** No composition rules, no
  forced expiry — both are in the ticket and both are what NIST 800-63B actually says.
- **Guard the byte length.** `bcryptjs` silently truncates past 72 *bytes*, and 64
  characters of UTF-8 can exceed that. Reject explicitly rather than hashing a prefix.

### 7.2 Breach check

Port `isBreachedPassword` from lava-connect: HIBP k-anonymity — SHA-1 the password, send
the first five hex characters, scan the response for the suffix, so the full hash never
leaves the process — with `Add-Padding` so response size leaks nothing, a 750 ms cap,
and fail-open with a logged reason.

Fail-open matters more here than it does there: an on-prem deployment may have no egress
at all, and failing closed would make the first admin uncreatable. Add
`PASSWORD_BREACH_CHECK=hibp|off` so an air-gapped install disables it deliberately rather
than discovering it silently. Run it on **all four write paths** — first-run setup,
invite redemption, reset, and change — not just "change password".

### 7.3 Rate limiting

| Axis | Limit | Response |
|---|---|---|
| Per IP, `/auth/*` | 10 / minute *(exists)* | `429` |
| Per account, sign-in | 5 failures / 15 min, then locked for the rest of the window | `423` · audit `signin.blocked` |
| Per address, token emails | 3 / 15 min across invite · reset | `429`, silently — no enumeration |

The per-account axis is the one that matters: a distributed attacker rotating IPs walks
straight past a per-IP limit, and with `trustProxy: true` they need not even rotate
anything (§5.2). The counter is keyed on the submitted address whether or not it exists,
so lockout leaks nothing.

### 7.4 Link tokens

Invite and reset tokens are 32 random bytes, base64url in the link, SHA-256 in the row.
They are **not** JWTs and they are **not** signed with `AUTH_SECRET`.

They also travel in a **request body, never a URL path or query string** — which is why
the preview and accept endpoints are `POST /auth/invite/preview` rather than
`GET /auth/invite/:token`. A token in a path lands in api access logs, ingress logs and
any proxy in between, and none of those are places we control the retention of.

> lava-connect signs its magic-link, verify and reset tokens with the same `AUTH_SECRET`
> as session JWTs, separated only by a `kind` claim. Tolerable when every consumer is
> server-side; not here, because our redemption path *creates accounts* — a
> `kind`-confusion bug becomes account creation rather than a bad link. Opaque random
> tokens sidestep the class entirely and are simpler to revoke.

---

## 8. Deployment modes

`DEPLOYMENT_MODE=managed|onprem`, defaulting to `onprem` — the safe default is to assume
no mail server.

| | Managed | On-prem |
|---|---|---|
| First admin | we create it, email a join link | first-run page + the installer's setup token |
| Invite delivery | emailed | link returned to the admin, copied out |
| Invite TTL | 7 days | 24 hours |
| Reset initiation | self-serve "forgot password" | admin generates a link |
| Reset TTL | 1 hour | 24 hours |
| "Forgot password" on `/login` | shown | hidden — there is nowhere to send it |
| Email transport | SES (ported) | none, ever |

**The web needs this value at runtime**, not build time — `NEXT_PUBLIC_*` is baked into
the bundle and one published image has to serve both shapes. Fold it into the existing
`GET /api/config` route alongside `DASHBOARD_API_URL`, which the browser already
resolves once per session.

Build link generation first, for both modes; **email is a thin adapter** that only
managed uses. That is why the provider choice is not on the critical path.

### New environment variables

| Variable | Default | Read by |
|---|---|---|
| `DEPLOYMENT_MODE` | `onprem` | api + web (via `/api/config`) |
| `INTERNAL_AUTH_SECRET` | — | api + web · gates the forwarded client context |
| `SETUP_TOKEN` / `SETUP_TOKEN_FILE` | generated / unset | api |
| `PASSWORD_BREACH_CHECK` | `hibp` | api |
| `PUBLIC_WEB_ORIGIN` | — | api · builds invite and reset links |
| `AWS_REGION`, `EMAIL_FROM`, … | unset | api · managed only; unset ⇒ no email transport |

---

## 9. API contract

> **Placement matters.** `isPublicPath()` in `plugins/auth.ts` treats *all* of `/auth/*`
> as public. Unauthenticated flows belong there; anything admin-only must live under
> `/api/` or it ships wide open.

| Route | Auth | Body / returns | Errors |
|---|---|---|---|
| `GET /auth/bootstrap` | public | → `{ needsSetup, mode }` | — |
| `POST /auth/setup` | public | `{ token, email, password }` → `{ user }` | 403 bad token · 409 already set up · 400 weak/breached |
| `POST /auth/sign-in` | public | `{ email, password, clientContext? }` → `{ user, sessionId }` | 401 · 403 suspended/removed · 423 locked · 429 |
| `POST /auth/oauth/:provider` | public | `{ token, clientContext? }` → `{ user, sessionId }` | 401 · 403 no matching account (§12.1) |
| `POST /auth/sign-out` | session | → `{ ok }`, revokes the current row | — |
| `POST /auth/invite/preview` | public | `{ token }` → `{ email, role, expiresAt }` | 404 unknown · 410 used/revoked/expired |
| `POST /auth/invite/accept` | public | `{ token, password }` \| `{ token, googleIdToken }` → `{ user, sessionId }` | 410 · 403 email mismatch · 400 breached |
| `POST /auth/password/forgot` | public | `{ email }` → `202` always | 429 · 404 in on-prem mode |
| `POST /auth/password/reset` | public | `{ token, password }` → `{ ok }` | 410 · 400 breached |
| `POST /api/account/password` | self, fresh | `{ current, next }` | 401 wrong current · 400 breached · 409 no password (OAuth account) |
| `GET /api/account/sessions` | self | → rows with `client`, `ip`, `createdAt`, `current` | — |
| `DELETE /api/account/sessions/:id` · `DELETE /api/account/sessions` | self, fresh | revoke one / all | 404 |
| `GET /api/team/members` | `read_only` | → name, email, role, 2FA, lastActive, joined, status | — |
| `GET /api/team/members.csv` | `read_only` | → `text/csv`, formula-guarded | — |
| `GET /api/team/invites` | `admin` | → pending invites with sent + expiry | — |
| `POST /api/team/invites` | `admin`, fresh | `{ email, role }` → `{ invite, url? }` | 409 already a member / already invited |
| `POST /api/team/invites/:id/resend` · `DELETE …/:id` | `admin`, fresh | new link / revoke | 410 already redeemed |
| `PATCH /api/team/members/:id` | `admin`, fresh | `{ role }` | 409 self-demotion · 404 |
| `DELETE /api/team/members/:id` | `admin`, fresh | state change per §6.4 | 409 self-removal · 404 |
| `POST /api/team/members/:id/reset-link` | `admin`, fresh | → `{ url, expiresAt }`, shown once | 409 OAuth-only account · 404 |

Error bodies keep the existing shape (`{ statusCode, error, message }`). A revoked or
expired session returns `401` with a distinguishable code so the web signs out rather
than looping through the edge gate.

---

## 10. Audit contract (MAG-2770 interface)

MAG-2770 owns the table, the writer, the viewer, the export and the read API — and its
own description says task 1 needs the writer "within days". The dependency runs both
ways, so the interface is settled here, in code, before either side builds against it.
This task ships a no-op implementation; 2770 swaps it in.

```ts
export interface AuditEvent {
  action:  AuditAction;                        // 2770 owns the verb set
  actor:   { id: string | null; kind: "user" | "system" };
  target?: { type: "member" | "invite" | "session"; id: string; name: string };
  changes?: Array<{ field: string; from: string; to: string }>;
  access?:  { ip: string | null; client: string | null; sessionId: string | null };
  note?:    string;
}

export interface AuditWriter {
  /** Runs inside the caller's transaction when one is supplied, so the row
   *  and the mutation it records commit or roll back together. */
  write(event: AuditEvent, tx?: Database): Promise<void>;
}
```

### Events this task emits

Take **MAG-2770's table as authoritative** — it is the newer split and a strict superset
of the eight listed on 2729.

| Group | Events | `access` |
|---|---|---|
| Access | `signin.succeeded` · `signin.failed` · `signin.blocked` · `signout` · `session.revoked` | yes |
| Accounts | `password.changed` · `password.reset_requested` · `password.reset_link_generated` · `password.reset_completed` | yes |
| People | `member.invited` · `invite.resent` · `invite.revoked` · `invite.expired` · `invite.redeemed` · `member.role_changed` · `member.removed` | no |
| Setup | `setup.completed` **(to add to 2770's set)** | yes |

Access events carry `ip`, `client` and `session`; people events do not — *Dana changed
the provider set* is complete without them, whereas *someone failed to sign in as Dana*
is close to useless. Redaction applies throughout: a token, a link or a password is
`(changed)`, never a value, and no reset URL is ever written to a row or a log line.

---

## 11. Web surfaces

### New pages

- `/setup` — first run. Setup token, email, password, repeat. Nothing else opens until
  it is done.
- `/invite/[token]` — shows the invited address as fixed text, takes a password or a
  Google sign-in.
- `/reset/[token]` — sets a new password, then sends the user to `/login`. It does not
  sign them in.

### Existing pages, rebuilt

- `/team` — members tab becomes real (name, email, role, 2FA, last active, joined) with
  change-role and remove; invites tab becomes real (sent, expiry, resend, revoke, and
  copy-link on-prem); CSV export; the single-admin prompt. The 2FA column stays `—`
  until MAG-2730 populates it — "No" would be technically true and misleading, which the
  repo's honesty contract already rules out.
- `/account` — change password, active sessions with per-device revoke, sign out
  everywhere. All four `CloudNotice` blocks come out.
- `/login` — "Forgot password" appears in managed mode only.

### Plumbing

- `components/team/bits.tsx` still carries the prototype's `owner | admin | member`
  vocabulary; it becomes the four real roles. `RoleBadge` and `InitialsAvatar` survive
  unchanged.
- `proxy.ts` must let `/setup`, `/invite/*` and `/reset/*` through unauthenticated. The
  needs-setup redirect lives in a server component, not the edge proxy — the edge cannot
  reach Postgres and should not fetch per request.
- A revoked session lands on `/login`, never in a redirect loop.

---

## 12. Security posture

### 12.1 OAuth becomes link-only

`upsertOAuthUser` (`apps/api/src/services/users.ts`) ends in an **unconditional
insert**: no provider-id match, no email match, and it creates the account. Correct for
today's no-invite world, silently fatal the moment invitations exist — anyone with a
Google account reaches `POST /auth/oauth/google` and provisions themselves, defeating
both "redeemable only by the address it was sent to" and the done-when "an invite
redeemed from a different email address is refused".

Match an existing **active** user or fail. The single exception is invite redemption,
and it lives in the redemption route, not in the upsert. That makes account creation
exist in exactly two places — first-run setup and invite redemption — and it should read
that way in the code.

### 12.2 Fail-open / fail-closed, stated deliberately

| Dependency unavailable | Behaviour | Why |
|---|---|---|
| Postgres | **closed** — no sign-in, no api | There is no partial-trust state worth inventing |
| HIBP | **open**, logged | On-prem may have no egress; failing closed makes the first admin uncreatable |
| SES (managed) | **closed** for that action, surfaced to the admin | A silently-unsent invite looks like a delivered one |
| Prometheus | unchanged — metrics degrade, auth is unaffected | The auth path never touches it |

### 12.3 Everything else

- **Enumeration.** Sign-in returns one response for unknown email and wrong password
  (already true). Forgot-password always `202`. Invite creation returns `409` to an
  admin — who is entitled to know — but the public redemption preview reveals only the
  address already in the link.
- **Token handling.** Raw invite and reset tokens are never logged, never audited, never
  returned twice, and never appear in an api URL — they travel in POST bodies (§7.4). The
  on-prem link is shown once and the response is not cached. The one exposure we cannot
  remove is the *web* route the person clicks (`/invite/<token>`), which lands in browser
  history by the nature of an emailed link; mitigated by a short TTL, single use, and
  `Referrer-Policy: no-referrer` on those pages so the token never leaves in a referer
  header.
- **CSV injection.** Port `services/csv.ts` — it guards `= + - @` plus tab and CR, and
  uses RFC 4180 CRLF. Put it in `packages/shared`; MAG-2770's export needs the same
  function.
- **`trustProxy`.** Narrow from `true` to the ingress CIDR (§5.2).
- **Secret separation.** Link tokens are opaque random values, not JWTs signed with the
  session secret (§7.4).

---

## 13. Migration and rollout

### 13.1 Schema

Migrations already run on api boot via `dbPlugin`, so each slice deploys as a normal
release. Everything in §4 is additive except the role enum swap, which rewrites existing
rows — and that remap is §16.1, not a developer default.

### 13.2 Rollback

Additive migrations are safe to leave in place on a rollback; the enum swap is not. Keep
slice 1 deployable as its own release and verify it against a restored copy of a
customer database before it goes near one. After slice 1, rolling the api back to a
build that reads `admin | member` will fail on the enum — so slice 1 is the release that
gets a real backup taken first.

### 13.3 The shared-login cutover

"The shared login is disabled at the same moment" is a done-when **this repo cannot
satisfy** — and it is a live piece of work, not a hypothetical: Omer confirmed on
17 Aug 2026 that customers run the v1 backend, so the shared credential really is what
stands in front of the dashboard today. The shared credential is `dashboard.AUTH_USERNAME`
(`charts/smart-router/values.yaml:390`, default `"admin"`) plus the `auth-password`
secret key, injected by `templates/dashboard/dashboard-backend-deployment.yaml` in
`smart-router-helm-chart` — a different repo. Per customer, the sequence is:

1. Deploy the release with accounts enabled.
2. Create an admin for one named person on their side; send the join link.
3. **Confirm they have signed in.**
4. Remove the shared credential from the chart and roll the deployment.
5. **The people who shared the login are set up as admins** (Omer, 17 Aug 2026 — §16.1).
   In practice: the named person from step 2 is an admin by construction, and invites the
   rest at `admin` rather than at a lower role.

Step 4 is where this stops being ours to do, and **it splits three ways** — which the
earlier version of this section missed by treating the cutover as one job:

| Part | Whose |
|---|---|
| Ship the chart change that makes the credential removable | **Ours.** `AUTH_USERNAME` was added by Sebastian Sejzer in *"add dashboard (#40)"* |
| Apply it to a **Magma-operated** box (DFNS, today) | **Ours — while we hold root.** See the window below |
| Apply it to a **customer-operated** box (GK8) | **The customer's.** We can ship the release; we cannot roll it |

MAG-2749 is explicit about the third row: GK8 is *"another customer's live server and we
may only read from it, never change it"*, with restarting a deployment listed under
cannot-do. So for those deployments the honest done-when is "the release is available and
the customer has been told what to change", not "we disabled it".

**Owner: MAG-2805, item 1 (victoria).** The cutover was never unassigned work — it is
already the first open item on *"Prepare the DFNS production server for handover"*:
*"the dashboard password is a common eight-character word, on a public page, with the
user name `admin`."* That is this exact credential. Raised there on 18 Aug 2026.

**The window may be closing.** MAG-2805's item 6 leaves open *"who keeps root access
after handover"*. While Magma holds root on the DFNS box this is step 4 as written; after
handover it becomes DFNS's, and we drop to the third row above.

**Order is not negotiable.** Steps 2 → 3 → 4, never 4 first. Removing the shared
credential before confirming a named admin can sign in locks the customer out of their
own dashboard with nothing to fall back to.

> **Resolved:** which backend image customers run. Omer, 17 Aug 2026 — the **v1** image,
> which is why the shared credential is genuinely what stands in front of the dashboard
> and why `AUTH_MODE` is never set. The same template also injects `DEBUG`,
> `CORS_ALLOW_CREDENTIALS` and `AUTH_GATEWAY_*`, all v1-only; they become dead
> configuration the moment a deployment moves to the v2 image, and should be removed from
> the chart in the same change as `AUTH_USERNAME`.

---

## 14. Test plan

`.claude/rules/testing.md` requires a happy-path `app.inject()` test per route, and
every route here needs real rows. Today `apps/api/src/__tests__/auth.test.ts`
deliberately points at an unroutable address and only exercises the JWT gate.

**lava-connect has already answered this:** a Map-backed fake store with the service
layer mocked (`__tests__/_helpers/test-app.ts`) for route tests, plus opt-in integration
tests gated on `TEST_DATABASE_URL`. Same harness, same conventions, no new dependency —
with one caveat to fix rather than inherit: those integration tests `describe.skip`
without the env var, so nothing gates a merge. The behaviour this design leans on
hardest — the partial unique index, the conditional single-use update, the removal
transaction — is exactly what a fake store cannot check. Either run a Postgres service
container in CI, or add **pglite** for real in-process Postgres with no Docker. Decide in
slice 1.

### Cases, mapped to done-whens

| Case | Proves |
|---|---|
| Invite redeemed from a different address → refused | Done-when 4 |
| Invite redeemed twice → second refused; expired → refused | Single-use, TTL |
| Removing a member kills their sessions within one request | Done-when 7 |
| Removed member's email can be invited again | Done-when 7 · the partial index |
| Demotion takes effect on the current session | Done-when 8 |
| A breached password is refused with a clear message; HIBP unreachable lets it through with a warning | Done-when 6 |
| `/auth/setup` without the token → refused; zero active users after a restore → offered again | Done-when 2 |
| On-prem invite and reset produce a usable link with no mail transport configured | Done-when 5 |
| Sign-in and forgot-password stay enumeration-proof | §12.3 |
| Member CSV neutralises a display name beginning `=` | §12.3 |
| `clientContext` is ignored without the internal secret | §5.2 |
| Every emitted event reaches the `AuditWriter` with the right shape | Done-when 10 |

Component tests stay out, per the project rule — typecheck plus manual UI verification.

---

## 15. Build order

Six PRs, each independently shippable behind `AUTH_MODE=enabled`, in dependency order —
a real sequence, not a grouping.

**1 · Session store, roles, fresh enforcement — ~2 pts**
§4 migration · `sessions` · `sid` minted by the api and carried through `jwt()` · real
client context · per-request session⨝user load · `requireRole` / fresh variants ·
`trustProxy` narrowing · `AuditWriter` interface with a no-op impl · the test-harness
decision.
*Not a silent PR:* the enum swap plus `requireRole` changes live behaviour for anyone
currently on `member`, and it is the one release that needs a backup taken first (§13.2).

**2 · First run and setup token — ~2 pts**
`GET /auth/bootstrap` · `POST /auth/setup` · the `/setup` page · `DEPLOYMENT_MODE`
through `/api/config`. Nothing to port — this is the piece lava-connect has no
equivalent of.

**3 · Invitations — ~2.5 pts**
Table, create/list/resend/revoke, the redemption page, mode-dependent TTL and delivery —
and the OAuth link-only fix, which belongs here because this is the PR where it becomes
exploitable. Ports the signed-link *shape*; the invitation model itself is net-new.

**4 · Password lifecycle — ~1.5 pts**
Reset in both modes, change-own-password, breach check, length bounds, per-account
lockout. Mostly a port — only the on-prem admin-generated link is new.

**5 · Members, sessions UI, export — ~2.5 pts**
Real team page, role change, removal with its confirmation dialog, the account page's
sessions list, CSV export, role-gated affordances, the single-admin prompt. Ports
`services/csv.ts` verbatim and the admin-table patterns — but not their
delete-or-set-password semantics.

**6 · Audit emission — ~1 pt**
Swap the no-op writer for MAG-2770's. Small *because* the call sites went in as each
slice landed — which only works if the §10 interface is agreed during slice 1.

Roughly 11 points against the 8 on the ticket — 15 without the lava-connect ports. If the
estimate has to hold, the cut line is after slice 3: that is what "people sign in as
themselves" requires. Slices 4–6 are what makes it pass the review.

---

## 16. Open decisions

Five things that are not the implementer's call. The first three block slice 1.

**16.1 · What do existing `member` rows become?** — **ANSWERED, 17 Aug 2026.**
Omer on MAG-2729: *"use V1 logic"* and *"existing users would become admin in the next
setup"*.

The first half settles it: deployments run the **v1 backend**, so there is no v2 `users`
table anywhere and the remap in `0001_accounts.sql` provably touches zero rows. It stays
`ELSE 'read_only'` — least privilege, and with no rows to convert there is nothing to
gain by loosening it.

The second half is read as a **cutover** instruction, not a migration one — see §13.3.
The people who share a login today are set up as admins when their deployment is
onboarded; that is a first-run and invitation matter, not something a migration can
express, because there are no rows for it to act on. Stated back on the ticket so it can
be corrected in passing. It is deliberately *not* implemented as `member -> admin` in the
migration: mapping everyone to admin hands out people-management and self-approval, which
is the expensive direction to be wrong in, where the other costs one click per person.

**16.2 · Who generates and surfaces the setup token?**
Our installer is a helm chart. **Recommend**: the api generates one on first boot when
there are zero active users, logs it once and writes it to `SETUP_TOKEN_FILE`, with
`SETUP_TOKEN` as a chart-supplied override. Needs whoever owns the chart.

**16.3 · Who disables the shared login, per customer?** — **ANSWERED, 18 Aug 2026.**
It was already open item 1 on **MAG-2805** (victoria), *"Prepare the DFNS production
server for handover"*. See §13.3 for the three-way split and the root-access window;
the part that is genuinely ours is shipping the chart change.

**16.4 · Google only, or keep GitHub and Discord?**
The ticket names email + password and Google. GitHub and Discord work today. **Recommend
keeping them** under the same link-only rule — near-zero cost — but flagging it rather
than quietly widening the scope.

**16.5 · The estimate.**
8 points does not cover this. **Recommend** splitting into the six slices above so
progress is visible and the cut line is explicit.

### Deliberately not blocking

- **Email provider.** Managed-only and a thin adapter over link generation; SES ports
  from lava-connect if we want it.
- **Retention periods for IP data.** MAG-2770 owns it and says explicitly it does not
  block the build.
- **Pending-request cancellation.** MAG-2731 owns the table; this task exposes and
  documents `onMemberDeactivated`. Worth tracking so it does not become a done-when
  nobody delivered.
- **2FA.** MAG-2730. The column exists; the value stays `—`.

---

## 17. Files touched

| Area | Files |
|---|---|
| Schema | `packages/db/src/schema.ts` · `migrations/0001_accounts.sql` · `src/seed.ts` |
| Api — plugins | `plugins/auth.ts` (session load, `requireRole`, fresh variants) · `plugins/db.ts` (setup-token bootstrap) · `app.ts` (`trustProxy`) |
| Api — routes | `routes/auth.ts` (rewritten) · `routes/team.ts` **new** · `routes/account.ts` **new** · `routes/config.ts` (mode) |
| Api — services | `services/users.ts` (link-only) · `services/password.ts` (policy, HIBP) · `sessions.ts` · `invitations.ts` · `password-reset.ts` · `lockout.ts` · `audit.ts` · `email.ts` **new** |
| Shared | `roles.ts` (`roleAtLeast`) · `csv.ts` · `types/domain.ts` |
| Web — auth | `auth.config.ts` (`sid`, client context) · `proxy.ts` · `app/login` · `app/setup` · `app/invite/[token]` · `app/reset/[token]` **new** |
| Web — app | `app/(app)/team/page.tsx` · `app/(app)/account/page.tsx` · `components/team/*` · `app/api/config/route.ts` |
| Docs | `docs/AUTH.md` (rewritten) · `CLAUDE.md` (env + endpoint tables) |

---

*Sources: MAG-2729 · MAG-2770 · MAG-2686 · `Magma-Devs/lava-connect` @ main incl. its
`docs/AUTH-FLOWS.md` · `Magma-Devs/smart-router-helm-chart`.*
