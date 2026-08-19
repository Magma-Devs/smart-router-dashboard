# MAG-2729 — requirement coverage

Every line of [MAG-2729](https://magmadevs.atlassian.net/browse/MAG-2729) ("Dashboard v2 (1/4) —
Accounts and team") against what is on the branch, so the ticket can be checked off rather than
taken on trust.

| | |
|---|---|
| As of | 19 Aug 2026, `b1154ac` on `feat/MAG-2729-slice6-audit-emission` |
| Parent epic | [MAG-2686](https://magmadevs.atlassian.net/browse/MAG-2686) — Dashboard v2, config change + SOC 2 |
| Design | [`ACCOUNTS-DESIGN.md`](./ACCOUNTS-DESIGN.md) (#109) · operator guide [`AUTH.md`](./AUTH.md) |

## Verdict

Everything the ticket asks for is implemented, except three things that belong to other tickets and
one open scope question.

The open question is **managed-mode delivery**: there is no mail transport anywhere in the repo, so
every managed path that ends in "send them a link" stops short. On-prem is complete. That is
asked on the ticket and is Omer's call, not a defect.

The three handoffs are the shared-login cutover (MAG-2805), cancelling a removed person's pending
config changes (MAG-2731 owns that table), and the audit log's own viewer, filtering and export
(MAG-2770). This ticket emits into MAG-2770's writer; it does not own the reading side.

Two places where the code disagreed with the ticket were found during this audit and fixed on the
branch — see [§5](#5-mismatches-found-and-fixed).

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
| Never a shared account; we never set a password for anyone | ✅ | True only after the `ADMIN_EMAIL` fix — see [§5](#5-mismatches-found-and-fixed) |
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
| On-prem: admin generates a single-use link, 24 hours | ✅ | Route complete and audited. ⚠️ no control on the member row — API-only today |
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
| **Managed-mode delivery** | No mail transport exists. Invitations withhold the link with nothing to send it; forgot-password logs it; the managed first-admin flow has no route | **Open question on the ticket** — scope call for Omer |
| Pending config changes cancelled on removal | `onMemberDeactivated` is a documented empty seam | MAG-2731 |
| Shared login disabled at cutover | Not this repo | MAG-2805 · victoria |
| On-prem reset-link control on the member row | Route exists, tested and audited; no UI | unassigned |
| Managed "Forgot password?" on `/login` | Moot until managed delivery is decided | unassigned |
| Audit viewer, filtering, export | Out of scope by ticket text | MAG-2770 |
| 2FA column populated | Out of scope by ticket text | MAG-2730 |

---

## 5. Mismatches found and fixed

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

## 6. How this was verified

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

The lesson generalises: a suite that never crosses an origin cannot see an origin bug, and a
walkthrough driven by curl proves the api, not the product.

**Guards were verified by breaking them**, not by watching them pass — `cors.test.ts` gives five
failures without its fix; the seed guard gives `expected 1 to be 0`.

At `b1154ac`: `pnpm -r typecheck` clean, **1281 tests** pass (774 shared · 317 api · 145 web · 45 db).
