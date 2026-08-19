# MAG-2729 — requirement coverage

Every line of [MAG-2729](https://magmadevs.atlassian.net/browse/MAG-2729) ("Dashboard v2 (1/4) —
Accounts and team") against what is on the branch, so the ticket can be checked off rather than
taken on trust.

| | |
|---|---|
| As of | 19 Aug 2026, `cedb1af` on `feat/MAG-2729-slice6-audit-emission` |
| Parent epic | [MAG-2686](https://magmadevs.atlassian.net/browse/MAG-2686) — Dashboard v2, config change + SOC 2 |
| Design | [`ACCOUNTS-DESIGN.md`](./ACCOUNTS-DESIGN.md) (#109) · operator guide [`AUTH.md`](./AUTH.md) |

## Verdict

Everything the ticket asks for is implemented. Nothing is open for decision; what remains belongs to
four sibling tickets.

**Managed-mode delivery is [MAG-2870](https://magmadevs.atlassian.net/browse/MAG-2870)** — "Account
emails and the reset password page", carved out of this ticket deliberately, _"so the copy and the
screen have one owner rather than being buried in the accounts ticket"_. It scopes exactly two
emails, invitation and password reset, and restates the rule this ticket already implements: on-prem
sends none. So the managed paths below stop one step short **by design, not omission** — there is no
mail transport in the repo because sending was never this ticket's job.

The other three are the shared-login cutover (MAG-2805), cancelling a removed person's pending
config changes (MAG-2731 owns that table), and the audit log's own viewer, filtering and export
(MAG-2770). This ticket emits into MAG-2770's writer; it does not own the reading side.

Two places where the code disagreed with the ticket were found during this audit and fixed on the
branch — see [§6](#6-mismatches-found-and-fixed). **Every row below that is not ✅ is explained in
[§5](#5-the-gaps-and-why-each-one-is-open)**, grouped by cause rather than listed one by one, since
three of them are the same missing piece.

---

## 1. What was built

Seven pull requests, stacked. `#115` is MAG-2770's writer, merged in because slice 6 emits through it.

| PR | Slice | Contents |
|---|---|---|
| [#109](https://github.com/Magma-Devs/smart-router-dashboard/pull/109) | design | `ACCOUNTS-DESIGN.md` — the decisions everything below implements |
| [#111](https://github.com/Magma-Devs/smart-router-dashboard/pull/111) | 1 | Server-side sessions (`sid` in the JWT, resolved per request), the four-role model, `users` + `sessions`, role enum swap |
| [#118](https://github.com/Magma-Devs/smart-router-dashboard/pull/118) | 2 | First-run setup, the installer setup token, `GET /auth/bootstrap`, the `/setup` page |
| [#119](https://github.com/Magma-Devs/smart-router-dashboard/pull/119) | 3 | Invitations — create, preview, redeem, resend, revoke, expire; `invitations`; the `/invite/[token]` page |
| [#120](https://github.com/Magma-Devs/smart-router-dashboard/pull/120) | 4 | Password reset (both modes), change-own-password, per-account lockout, breach check, NIST policy |
| [#121](https://github.com/Magma-Devs/smart-router-dashboard/pull/121) | 5 | Member list, change role, remove, CSV export, active-sessions card, account page |
| [#122](https://github.com/Magma-Devs/smart-router-dashboard/pull/122) | 6 | Audit emission — plus everything the by-hand pass turned up |

---

## 2. Requirement coverage

✅ implemented · ◐ partly, blocked on another ticket · ⚠️ gap · ⛔ not this ticket

### Shared rules

| Requirement | | Where |
|---|---|---|
| Four cumulative roles; Owner becomes Admin | ✅ | `constants/roles.ts`; migration `0001` maps `admin`→`admin`, else `read_only` — v1 logic, per Omer's answer on the ticket |
| Tokens, keys, credentials and node URLs never written as values; `(changed)` / `(changed, ends a91f)` | ✅ | `audit/format.ts`. Nothing in this ticket's scope writes a secret, so the guarantee holds here and the helpers are ready for MAG-2731 |

### 1 · Sign-in

| Requirement | | Notes |
|---|---|---|
| Email and password — "the only way in" | ✅ | Social sign-in removed outright, not left configurable |
| On-prem first admin: email, password, repeat; nothing else opens | ✅ | `/` → `/login` → `/setup` |
| First-run requires the installer's setup token | ✅ | Constant-time compare. The gate is `count(active users) == 0`, never a flag, so a backup restored with no users is covered — which the ticket calls out |
| Managed first admin: we create it and send a join link | ⚠️ | No route for that flow. `/setup` is not mode-gated, so a first admin is still creatable in managed |
| Never a shared account; we never set a password for anyone | ✅ | True only after the `ADMIN_EMAIL` fix — see [§6](#6-mismatches-found-and-fixed) |
| No standing admin account inside a customer's deployment | ✅ | Same fix |

**Passwords** (NIST 800-63B)

| Requirement | | Notes |
|---|---|---|
| argon2 or bcrypt, salted | ✅ | bcrypt cost 12 |
| Rate-limited per account **and** per IP | ✅ | 5 failures → 15 min, window measured from the *first* failure, so hammering doesn't extend the ban; 10/min per IP on every credential route |
| Every new password checked against breached lists | ✅ | HaveIBeenPwned by k-anonymity — only the first five characters of the SHA-1 leave the process. Fails open, so `PASSWORD_BREACH_CHECK=off` is the honest setting for an air-gapped install |
| Minimum 8, up to 64, every character including spaces | ✅ | Counted in **code points**, not UTF-16 units, so 64 emoji is 64. A 72-byte guard refuses what bcrypt would silently truncate |
| Valid until the user changes it | ✅ | No expiry |

**Password reset**

| Requirement | | Notes |
|---|---|---|
| Managed: user-initiated, emailed link, 1 hour | ⚠️ | TTL correct; no transport. Creates the reset, logs the link, returns 202 |
| On-prem: admin generates a single-use link, 24 hours | ✅ | **Reset link** on the member row → shown once, copied by hand. The admin never sees or chooses the value |
| A reset link sets a password; it does not sign anyone in | ✅ | |
| Resetting kills every session for that user | ✅ | |

**Sessions**

| Requirement | | Notes |
|---|---|---|
| No idle timeout; 30 days then a full sign-in | ✅ | |
| Listed per user with device, browser, IP and sign-in time | ✅ | Device string parsed once at creation, never on read, so the audit record can't shift if the parser changes |
| Revocable individually or all at once | ✅ | "Sign out everywhere" ends the current tab too, deliberately; changing your own password does not |
| Removal or reset kills all sessions immediately | ✅ | Removal revokes in the same transaction as the status change |
| **Role read at the moment of the action, not from the session** | ✅ | The api resolves session ⨝ user per request; a demotion lands on a session already open |

### 2 · Team

| Requirement | | Notes |
|---|---|---|
| Only an admin changes roles, including making an admin | ✅ | |
| Admin is transferable | ✅ | Promote a replacement, then they demote you — the last move is never your own |
| Nobody can demote or remove themselves | ✅ | Enforced in `services/members.ts`, not merely hidden in the UI |
| Invite by email address and role | ✅ | |
| Managed: invitation email with a join link | ⚠️ | Returns `delivery: "email"` and withholds the link; nothing sends it |
| On-prem: link shown to the admin. No mail server ever required | ✅ | Shown once, not readable back |
| Redeemable only by the address it was sent to | ✅ | **Structural**: the account is created with the invitation's address and the redeemer supplies none |
| Single-use; 7 days managed, 24 hours on-prem | ✅ | Exactly as specified |
| Pending tab with sent and expiry dates; resend and revoke | ✅ | Resend mints a new token and kills the old link. Expiry needs no sweeper — the first read that observes it stamps the row, so `invite.expired` fires once |
| Members table: name, email, role, 2FA, last active, joined | ✅ | 2FA renders `—`, not "No" — it is MAG-2730's, and "No" would be true today and wrong the day it ships |
| Change role, remove | ✅ | |
| Removal is a state change, not a row deletion | ✅ | Sessions die immediately, the name stays in the log permanently, the address can be invited again |
| Removal needs no approval; a dialog naming the person is enough | ✅ | |
| Pending config changes cancelled, reason "requester was removed" | ⛔ | `onMemberDeactivated` is a documented empty seam. MAG-2731 owns the change-request table |
| The member list is the access review, and it exports | ✅ | CSV covers the whole list, not the current page |

### 3 · Audit log

The log itself is MAG-2770. This ticket emits into it. All sixteen events are in the typed catalog
**and** fire from a call site — checked separately, because being catalogued does not mean being
emitted.

| Group | Events |
|---|---|
| Access | `signin.succeeded` · `signin.failed` · `signin.blocked` · `signout` · `session.revoked` |
| Account | `password.changed` · `password.reset_requested` · `password.reset_link_generated` · `password.reset_completed` |
| People | `member.invited` · `invite.resent` · `invite.revoked` · `invite.expired` · `invite.redeemed` · `member.role_changed` · `member.removed` |

Role changes carry real diff rows (`field` / `from_value` / `to_value`), so the log is filterable
rather than only readable. Names are snapshots: a removed person keeps their name in the log, and a
rename cannot rewrite history.

---

## 3. The "Done when" list

| # | Criterion | |
|---|---|---|
| 1 | Signs in as themselves; the shared login no longer works | ⛔ cutover — MAG-2805 |
| 2 | Fresh on-prem install asks for email and password before anything opens, and refuses without the setup token | ✅ |
| 3 | A requester cannot approve anything | ◐ roles gate correctly; there is no approval surface to be refused from until MAG-2731 |
| 4 | An invite redeemed from a different address is refused | ✅ |
| 5 | On-prem invites and resets work with no mail server | ✅ |
| 6 | A breached password is refused with a clear message | ✅ |
| 7 | A removed person's sessions die, **pending requests are cancelled**, history stays, email re-invitable | ◐ three of four; cancellation is MAG-2731's |
| 8 | Demoting someone takes effect on their current session | ✅ |
| 9 | The member list shows role and last active, and exports | ✅ |
| 10 | Every event is a row in the log, and the log filters and exports safely | ✅ emission; filtering and export are MAG-2770's |

---

## 4. Outstanding, with owners

| | State | Owner |
|---|---|---|
| **Managed-mode delivery** | No mail transport exists. Invitations withhold the link with nothing to send it; forgot-password logs it; the managed first-admin flow has no route | [MAG-2870](https://magmadevs.atlassian.net/browse/MAG-2870) — assigned, To Do |
| Pending config changes cancelled on removal | `onMemberDeactivated` is a documented empty seam | MAG-2731 |
| Shared login disabled at cutover | Not this repo | MAG-2805 · victoria |
| Managed "Forgot password?" on `/login` | The screen MAG-2870 specifies, on the flow it delivers | [MAG-2870](https://magmadevs.atlassian.net/browse/MAG-2870) |
| Audit viewer, filtering, export | Out of scope by ticket text | MAG-2770 |
| 2FA column populated | Out of scope by ticket text | MAG-2730 |

---

## 5. The gaps, and why each one is open

Six rows above are not ✅. They collapse into three causes, and only one was ever work sitting on
this ticket — that one is now built, which is why it no longer appears. Nothing here is undecided;
each has a ticket.

### Cause 1 — there is no mail transport. Three of them.

Nothing in the repo sends email: no nodemailer, no SES, no SMTP. Every managed path that ends in
"…and send them a link" therefore stops one step short. These are one missing piece, not three
bugs.

| | What happens today |
|---|---|
| **Managed invitation** | The row is created correctly with the right 7-day TTL, and the response deliberately *withholds* the link because managed is meant to email it. Nothing emails it. The invitation exists and is unreachable by anyone — the worst of the three, because it looks like it worked |
| **Managed forgot-password** | Creates the reset with the correct 1-hour TTL, writes `password.reset_requested`, logs the link at `warn`, returns 202. An operator with log access can retrieve it; the user gets nothing. A `TODO(slice: email adapter)` sits on it, so it was known rather than missed |
| **Managed first admin** | No route for the flow the ticket describes. It does not *block* a managed deployment: `/setup` is not gated on `DEPLOYMENT_MODE`, so a first admin is still creatable with the setup token |

**Who owns it:** [MAG-2870](https://magmadevs.atlassian.net/browse/MAG-2870), which scopes exactly
two emails — invitation and password reset — with the copy written out, and confirms on-prem sends
none. So this is a boundary, not a hole: the link generation, the TTLs, the single-use semantics and
the audit rows all live here; what MAG-2870 adds is the transport and the wording.

**What it takes:** one adapter behind the existing link generation — both call sites already produce
the URL and know the mode. `lava-connect` is a working reference (`services/email.ts` +
`email-layout.ts` over SES v2), and the shape worth copying is its single `deliver()` choke point:
send, then write a row recording `type` and `template_version` but **never the body**, so a
token-bearing link is never persisted. Note it has no invitation email to port — it is self-serve
signup with no team concept — so that template gets written from MAG-2870's copy rather than
inherited.

### Cause 2 — a missing control. Now built.

The on-prem reset-link route was complete, tested and audited, but nothing in the web called it, so
the design's *"initiated by an admin, from the members table"* was API-only. **Reset link** now sits
on the member row beside Change role and Remove: a confirmation naming the person, then the link
shown once with a copy button.

It sits behind a confirmation rather than firing on click because generating one is the first half
of an account takeover if the wrong person asked — which is also why the api records it with the
admin's address and device attached. There is no password field, and no endpoint that would accept
one.

### Cause 3 — sequencing. Four items another ticket must own.

Not oversights; the ticket hands most of them away in its own text.

| | Why it cannot be done here |
|---|---|
| **Pending config changes cancelled on removal** | The ticket does ask for this, but MAG-2731 creates the change-request table — there is literally nothing to cancel yet. `onMemberDeactivated` is an empty function with a docblock saying so, so it lands in MAG-2731's path rather than being quietly dropped. **This is the handoff worth chasing**, because it is a requirement of *this* ticket that somebody else has to satisfy |
| **Shared login disabled at cutover** | Not this repo. The chart change is ours, the customer-operated box is theirs |
| **Audit viewer, filtering, export** | "The audit log moved out of this task into MAG-2770." We emit; they read |
| **2FA column populated** | "Populated by task 3" (MAG-2730). The column renders `—` rather than "No", so it does not assert something that becomes false the day 2FA ships |

### The two "partial" marks, so they are not misread

**Done-when 3** — *"an admin invites someone as a requester, and that person cannot approve
anything"*. Role gating is real and verified: a requester gets 403 on admin routes, and a promotion
and demotion were both watched landing on an already-open session. What cannot be demonstrated is
"cannot approve" *specifically*, because there is no approval surface to be refused from. This is
as met as it can be until MAG-2731.

**Done-when 7** — four clauses. Three are met and were exercised by hand: sessions died
(`member_removed × 2` in the session table), history stayed, the address was re-invitable. The
fourth is the pending-changes cancellation above.

---

## 6. Mismatches found and fixed

Both found by reading the ticket line by line against the code, and fixed on this branch.

### The `ADMIN_EMAIL` / `ADMIN_PASSWORD` seed failed three lines at once

It predates first-run setup and nobody removed it. Against the ticket:

- *"That first-run page requires the setup token the installer prints"* — the seed needs none.
- *"We never set a password for anyone"* — it sets one, from the environment.
- *"We keep no standing admin account inside a customer's deployment"* — it is exactly that, for as
  long as the variables stay set.

Both paths open on the same condition — no active users — so the room had two doors and a lock on
one. Now **refused under `NODE_ENV=production`**, with a warning naming the variables so an operator
expecting an admin learns it from a log line rather than a locked-out install. Kept for development,
because `make dev-auth` would otherwise need somebody to walk `/setup` after every `down -v`.

That fix needed a second one to be usable: `resolveSetupToken` was only ever called from *inside*
`POST /auth/setup`, so with no `SETUP_TOKEN` configured nothing was generated, logged, or written to
`SETUP_TOKEN_FILE` until somebody had already submitted a wrong guess — and an init container
reading that file runs before the api serves a request. It resolves at boot now.

### "Promote someone else first, then step down" could not be followed

Nobody can change their own role, so after promoting a replacement you still cannot demote yourself
— they have to. The behaviour is right: the ticket's stricter line ("nobody can demote or remove
themselves") wins over "an admin can step down". The message described a sequence ending in a 409,
and now says the last move is never your own.

---

## 7. How this was verified

Worth stating, because the failure mode that produced the worst bug in this ticket was a test suite
that could not see it.

**Read in the source** — every claim above was checked against the code, not against memory or the
design doc.

**Exercised against a running stack** — `make accounts` brings up a deployment with no seeded admin,
which `up-auth` and `dev-auth` cannot, so `/setup` never appeared before and none of these flows had
been clicked through. The walkthrough in [`AUTH.md`](./AUTH.md) was run end to end: 42 assertions
covering first run, invitation, live role change, sessions, reset, lockout, export and removal.

**Then in a browser** — which found three things neither of the above could:

- **CORS never allowed `DELETE` or `PATCH`.** `@fastify/cors` defaults `methods` to `GET,HEAD,POST`
  and the registration never overrode it, so the browser refused to send sign-out, revoke-invite,
  change-role or remove-member. `app.inject()` and curl are same-origin and skip CORS entirely,
  which is why the 42-assertion pass went green while the UI could not call one of those routes.
- **A failed member read rendered as an empty team** — on the page whose only job is answering "who
  still has access", which is the dangerous direction to be wrong in.
- **"Deleting your own account is a Magma Cloud feature"** — false; it is a product rule in both
  shapes, and a disabled control implied paying would unlock it.

**Then somebody used it for its actual purpose**, which found two more — and this is the class of
defect that neither reading code nor driving it deliberately will produce, because both start from
knowing what is supposed to happen:

- **An invitation vanished from the screen that created it.** Invite somebody, then look for them
  in Members, where they correctly are not — an invitation is not an account until it is redeemed.
  Nothing said so, and the tab holding the answer gave no reason to click it. Reported as "I don't
  see the account I just created".
- **An invitation link opened while signed in explained nothing.** The edge gate redirected
  `/invite/*` to the dashboard for anyone with a session. The rule is right; the silence made it
  indistinguishable from a broken link. It strands more than a tester: somebody who already has an
  account, clicking an invitation for a second address, lands on the dashboard and the invitation
  stays pending with nobody able to say why.

### One pattern, five times

Every browser-found defect above is the same shape — **the system does the correct thing and tells
nobody**. A 401 renders as an empty roster. An invitation moves to a tab you weren't looking at. A
redirect fires with no sentence attached. A product rule wears the costume of a paid feature. In
each case the behaviour was right and the reporting was absent, so it read as broken.

That is worth carrying into MAG-2730 and MAG-2731 rather than treating as five coincidences. It is
also why none of them had a failing test: there is nothing to assert when the code does exactly what
it meant to.

**Guards were verified by breaking them**, not by watching them pass — `cors.test.ts` gives five
failures without its fix; the seed guard gives `expected 1 to be 0`. Both invitation states above
were checked by rendering them against a running stack, signed out and signed in, rather than by
typechecking them.

At `cedb1af`: `pnpm -r typecheck` clean, **1281 tests** pass (774 shared · 317 api · 145 web · 45 db).
