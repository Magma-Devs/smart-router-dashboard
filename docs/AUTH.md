# Authentication

The dashboard has two auth modes, selected by the `AUTH_MODE` env var
(same value on the api **and** the web):

| Mode | What it means |
|---|---|
| `disabled` *(default)* | Today's behaviour — no login, no database, every route open. The zero-dependency self-hosted posture. |
| `enabled` | Auth.js v5 sign-in (email and password — the only way in), Postgres-backed users, HS256 JWT shared between web and api. `/api/*` requires a Bearer token. |

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
both become admin. It deliberately opens **no** session: the web signs in
with the password just typed, and a session created here would sit unused
for its full thirty days on the one screen meant for spotting exactly that.

### The Magma Devs account (managed only)

The page is not gated on the mode — something has to create the very first
account whoever hosts the deployment. On **managed** that first account is
therefore ours: a Magma operator runs the page, then invites the customer's
named admin, who sets their own password from the emailed link. Nobody at
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
  rather than a check someone can forget to write — the redeemer supplies no
  address at all, so there is nothing that could disagree with the invitation.
  This used to need a real comparison, back when somebody could redeem holding
  a Google identity asserting a *different* verified address; removing social
  sign-in turned that check into a property of the INSERT.
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

> **Account creation lives in exactly two places**: first-run setup and invite
> redemption. It used to have a third — `upsertOAuthUser` fell through to an
> insert, so anyone with a Google account could reach `POST /auth/oauth/google`
> and provision themselves. That was made link-only, and then social sign-in was
> removed outright (below), which deletes the path rather than guarding it.

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

<img src="./assets/password-reset.png" alt="The password reset page: a card headed &quot;Choose a new password&quot;, with new-password and repeat-password fields and a note that setting it signs out every device on the account, that any characters are accepted from 8 to 64, and that the password is checked against known breached passwords." width="420">

`/auth/password/forgot` always answers `202`, whether or not the address exists
and whether or not the account has a password at all — anything else turns it
into a way to ask "is this person a member?". On-prem it answers `404` with a
reason, because there is genuinely nowhere to send anything.

**Changing your own password** (`POST /api/account/password`) requires the
current one and signs out your *other* devices, keeping the tab you are in.
Being logged out of the window you just changed your password in is hostile;
logging out the other devices is the security value.

## Email (MAG-2870)

Exactly two transactional emails, and the ticket is explicit that nothing else
is in scope: the invitation, and the password reset. Both are ports of
lava-connect's approach — SES v2 behind a single send function, table-based HTML
with inline styles because that is what renders the same in Gmail, Outlook and
Apple Mail.

**On-prem sends nothing, ever.** That is the design, not a limitation: both
flows produce a link the admin hands over, and no customer deployment needs a
mail server. The copy still matters there, because the same link lands in a chat
message instead.

| Setting | Effect |
|---|---|
| `AWS_REGION` | **The switch.** Unset ⇒ nothing is sent, the body is logged at `warn`, and the caller is told |
| `AWS_ACCESS_KEY_ID` / `SECRET` | Optional. Absent ⇒ resolved from the environment (IRSA, instance role), so production stores no static keys |
| `EMAIL_FROM` | Sender; an unmonitored no-reply |
| `EMAIL_REPLY_TO` | A monitored inbox, so a reply to a reset reaches somebody |
| `EMAIL_CONFIGURATION_SET` | Keeps each environment's bounce reputation separate on a shared SES identity |
| `SES_ENDPOINT` | Points at a local SES mock for development |
| `CUSTOMER_NAME` | Appears in the invitation subject — an invite lands somewhere that has never heard of us, and the customer's own name is what stops it reading as spam |

### A send that does not happen

`sendEmail` **never throws**. An invitation row is committed before the send is
attempted, so failing the request would report failure for something that half
happened — and returning `201` with no link would leave an admin believing an
invitation is on its way to somebody who will never receive it.

So the three outcomes collapse into two shapes, and the response says which:

- **sent** — the link is in the recipient's inbox and nowhere else. The response
  carries no url.
- **not sent** (no transport, or SES refused) — the response carries the url and
  `deliveryFallback: true`, and the invite dialog says the email could not be
  sent rather than reusing the on-prem wording, which would blame a deployment
  shape for an operational fault.

Password reset has no such fallback: there is no admin in that flow to hand a
link to, and returning one would let anybody mint a reset for any address. The
audit note is the only record it went nowhere.

### Why there is no email-log table

lava-connect has `user_emails` because it has sixteen types, an admin console
answering "did this person already get X", CSV export, and SES bounce
correlation to build on. None of that is in scope here, and a table nothing
reads is schema to migrate around later.

The one fact worth keeping — did it go, or is the admin holding the link — goes
on the audit row that already describes the event: `member.invited`,
`invite.resent`, `password.reset_requested` each carry a `note` of `emailed`,
`link shown to the admin`, or `email failed, link shown to the admin`. That is
where somebody investigating already looks.

**The body is never persisted**, in either design. A rendered invitation
contains a live token.

<img src="./assets/account-emails.png" alt="The two account emails side by side, rendered by the shipping templates. Left: the invitation, subject &quot;You've been added to DFNS on Smart Router&quot;, headed &quot;Set up your account&quot;, with a Set up your account button, the same link repeated as selectable text beneath it, and a line reading &quot;The link works once and expires in 7 days. It only works for dana.okonkwo@dfns.co.&quot; Right: the password reset, subject &quot;Reset your Smart Router password&quot;, with a Reset password button, the link again as text, and &quot;This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.&quot; Neither has a footer, an unsubscribe link, or any image." width="820">

### The rules the copy follows

From the ticket, and each has a test:

- **The link appears as text as well as a button.** Mail clients strip buttons
  and people forward these.
- **The expiry is in the message**, and is passed in rather than written into
  the copy — lava-connect's template hardcodes 30 minutes and ours is an hour.
- **No marketing footer, no tracking, no unsubscribe.** The shell has no footer
  and **no `<img>` at all**: a remote image in a security email reports when it
  was opened and from where, whether or not anybody meant it as a tracking
  pixel. The wordmark is set in text.
- **The invitation does not name the inviter.** It goes to an address nobody has
  verified, so a mistyped one puts a colleague's name and address in a
  stranger's inbox.
- **The reset says what to do if it wasn't you**, as the last line.


### The reset password page

<img src="./assets/reset-password-states.png" alt="The three states of the reset password page, captured against a running stack. Setting a password: heading &quot;Choose a new password&quot; with the address dana.okonkwo@dfns.co underneath, New password and Repeat password fields, the rule &quot;At least 8 characters. Any characters, including spaces.&quot; shown beneath the first field before typing, and a Save password button. Done: &quot;Your password has been changed. You have been signed out everywhere else.&quot; and a Sign in button. Dead link: &quot;This link has expired&quot;, with on-prem wording asking an administrator to generate a new one, and a Go to sign in button." width="900">

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

**Email and password. That is the only way in** — the ticket's words, and
now the code's. Verified api-side (`POST /auth/sign-in`, bcrypt cost 12,
enumeration-proof responses), which also opens the session row and returns
its id. Accounts come from first-run setup or an invitation; there is no
self-serve sign-up.

### Why social sign-in was removed

Google, GitHub and Discord buttons used to appear on the login page
whenever their `*_CLIENT_ID` + `*_CLIENT_SECRET` pair was set. They are
gone — the providers, `POST /auth/oauth/:provider`, `services/oauth.ts`,
`upsertOAuthUser`, and the Google branch of invite redemption.

The reason is revocation, not cryptography. A personal Google account is
not administered by the customer's IT: when somebody leaves the company
their corporate identity is disabled, but that personal account still
exists and still opens this dashboard, until an admin separately
remembers to remove them from the member list. Closing that gap
automatically is what SSO is for, and it arrives as its own task when a
customer asks for it. Social login reopens it, which is why the ticket
lists it out of scope twice — once as a scope boundary, once with this
reasoning.

Two things bounded the exposure while it existed, and neither was the
point: OAuth was already link-only, so nobody self-provisioned; and no
deployment had ever set a credential pair, so the buttons never rendered.
Removing the code makes "email and password only" structural rather than
a fact about configuration.

**The `google_id` / `github_id` / `discord_id` columns stay.** They are
nullable, unwritten, and inert. Nothing shipped, so there is no data to
preserve or to leak, and dropping three dead columns is not worth a
migration on a schema other deployments already have.

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
| `DATABASE_URL` | api | `postgres://sr:dev@postgres:5432/sr_dashboard` in compose |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | api | **development-only** admin seed; ignored (with a warning) when `NODE_ENV=production` |
| `INTERNAL_AUTH_SECRET` | api + web | Proves a caller is our own web tier, so forwarded browser IP / User-Agent are honoured. Unset ⇒ ignored, and sessions record what the api observes |
| `TRUST_PROXY` | api | How far to believe `X-Forwarded-For`. Hop count (default `1`), a comma list of proxy IPs/CIDRs, or `false` |
| `DEPLOYMENT_MODE` | api + web | `onprem` (default) / `managed` — forks invite and reset delivery |
| `SETUP_TOKEN` | api | First-run token. Unset ⇒ generated once at boot and logged |
| `SETUP_TOKEN_FILE` | api | Where to write a generated token (mode 0600) so an init container can surface it |
| `PASSWORD_BREACH_CHECK` | api | `hibp` (default) / `off` — turn the breach check off deliberately on an air-gapped site |
| `PUBLIC_WEB_ORIGIN` | api | Browser-facing origin of the web app; invitation and reset links are built from it. No default — guessing a host would produce links that look right and go nowhere |
| `AUTH_URL` | web | Auth.js base URL (default `http://localhost:3000`) |
| `INTERNAL_API_BASE_URL` | web | server-side api URL for Auth.js callbacks (`http://api:8000` in compose) |

## Running it

```bash
make accounts          # a fresh install with NO accounts, on http://localhost:3000
make accounts-reset    # wipe the database and start from first-run again
```

That is the stack for exercising the account system. It differs from
`make dev-auth` in the one way that matters: `dev-auth` seeds
`ADMIN_EMAIL`/`ADMIN_PASSWORD`, so the deployment already has an account
and **the first-run page can never appear**. `make accounts` clears them,
supplies a setup token, and points invitation and reset links at
`localhost:3000`.

Dev credentials are deliberately guessable. The setup token is
`installer-printed-this-token`; in a real install it is printed by the
installer or read from `SETUP_TOKEN_FILE`.

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
The route exists and is audited; the members-table button that should
trigger it does not (see "What has no screen yet" below), so drive it
directly.

Get the same Bearer the browser uses: DevTools → Network → any
`/api/team/…` request → copy its `Authorization` header value, minus the
word `Bearer`. (Signed in already? `curl -b <cookies> localhost:3000/api/auth/session`
returns it as `accessToken` — the web re-signs it there on every session
read, carrying the `sid` through.)

```bash
TOKEN='eyJ…'

curl -s localhost:8000/api/team/members -H "authorization: Bearer $TOKEN"
#   → find the member's id in the response

curl -s -X POST localhost:8000/api/team/members/<id>/reset-link \
     -H "authorization: Bearer $TOKEN"
#   → { "url": "http://localhost:3000/reset/…", "expiresAt": … }
```

Twenty-four hours on-prem against a managed deployment's one, because the
link travels over a channel we don't control. Open it, set a password —
and note that it does **not** sign you in, and that it kills every session
that account had.

Two refusals worth seeing: an account with no password set answers 409
(defensive — setup and invite redemption both set one), and a removed
member answers 404.

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
people-events don't, and no token, link or password appears anywhere.

### What has no screen yet

Two designed surfaces are reachable only over the api, so a walkthrough
that stays in the browser will not find them. Both are missing UI, not
missing behaviour — the routes work and are tested.

Both are named in `docs/ACCOUNTS-DESIGN.md` §6.3 — which lands with
MAG-2729's design PR, on `docs/MAG-2729-accounts-design`.

| Design says | Route | Missing |
|---|---|---|
| on-prem reset, "initiated by an admin, from the members table" | `POST /api/team/members/:id/reset-link` | no control on the member row |
| managed reset, "initiated by the user, from `/login`" | `POST /auth/password/forgot` | no "Forgot password?" link |

The second is not exercisable in this stack anyway: `DEPLOYMENT_MODE=onprem`
makes `/auth/password/forgot` answer 404 by design, because there is
nowhere to send an email.

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

It happened here. `0002_audit` (MAG-2770) carries `when` 1786953600000;
`0004_password_lifecycle` (MAG-2729) carries 1787040000000. A developer
who ran the auth profile before the audit work merged has a high-water
mark of 1787040000000, so `0002_audit` is **skipped on their machine** —
migrations report success and the `audit_events` tables simply are not
there. The first symptom is `relation "audit_events" does not exist` from
a route that is perfectly fine in CI.

```bash
# The fix, and the only one — re-migrate from empty:
docker compose -f docker-compose.dev.yml --profile auth down -v
```

Only developer machines are affected: nothing deployed sets
`AUTH_MODE=enabled`, so no deployment has a `users` table, let alone a
migration history. CI is unaffected too — every suite builds its database
from empty, where the high-water mark does not exist and entries apply in
array order regardless of their timestamps.

> **Do not fix this by bumping the `when`.** It is the obvious repair and it
> trades a silent skip for a hard failure. Raising `0002_audit`'s stamp above
> `0004`'s does let it apply on a database sitting at `0004` — but on a
> database sitting at `0002` the same change makes it *greater than the mark
> again*, so the migration **re-runs**: `CREATE TYPE` against a type that
> already exists, and boot fails. Tested, not reasoned: applying `0000`–`0002`,
> bumping the entry, and re-migrating throws.
>
> Both populations exist as soon as the two tickets merge in sequence, so
> either choice strands somebody. A skip is recoverable by a developer who
> reads this section; a failed migration blocks boot for people who never
> touched this work. Leave the timestamps alone and wipe the database.

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

> **Where pglite is not enough.** It is a real Postgres, but it is reached
> through a different driver, and the drivers do not agree about parameter
> serialisation. A bare JS `Date` interpolated into a `sql` template works
> under pglite and throws under postgres-js
> (`ERR_INVALID_ARG_TYPE: Received an instance of Date`) — so a green test
> suite is not proof the production driver is happy.
>
> This bit once, in the lockout counter, and was caught only by running the
> real stack. Prefer computing values **in SQL** (`now()`,
> `make_interval(...)`) over interpolating JS values into raw templates: it
> sidesteps the divergence, and for anything time-based it is more correct
> anyway, since the app and the database can disagree about the clock.
