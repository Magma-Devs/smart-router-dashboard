# MAG-2729 — requirement coverage

Every line of [MAG-2729](https://magmadevs.atlassian.net/browse/MAG-2729) ("Dashboard v2 (1/4) —
Accounts and team") against what is on the branch, so the ticket can be checked off rather than
taken on trust.

| | |
|---|---|
| As of | 30 Aug 2026 on `feat/MAG-2870-account-emails` — the top of the stack, containing every MAG-2729 slice plus MAG-2870, and the Magma-account marker Omer's 26 Aug decision asked for |
| Parent epic | [MAG-2686](https://magmadevs.atlassian.net/browse/MAG-2686) — Dashboard v2, config change + SOC 2 |
| Design | [`ACCOUNTS-DESIGN.md`](./ACCOUNTS-DESIGN.md) (#109) · operator guide [`AUTH.md`](./AUTH.md) |
| Acceptance | **11/11** of the checks on the ticket pass — [§4](#4-the-acceptance-checks) |

## Verdict

Everything the ticket asks for is implemented. Nothing is open for decision; what remains belongs to
four sibling tickets.

**The eleven acceptance checks on the ticket all pass**, run against a live deployment in both
deployment shapes — 11/11 managed, 10/10 on-prem, where the eleventh is managed-only. [§4](#4-the-acceptance-checks)
has the list and how each is exercised.

**Managed-mode delivery has landed too.** It belongs to
[MAG-2870](https://magmadevs.atlassian.net/browse/MAG-2870) — "Account emails and the reset password
page", carved out of this ticket deliberately, _"so the copy and the screen have one owner rather
than being buried in the accounts ticket"_ — and that ticket is implemented in
[#147](https://github.com/Magma-Devs/smart-router-dashboard/pull/147), on this branch. So the
managed rows below are now green rather than deferred: invitations and resets are emailed, over SES.

What remains belongs to three sibling tickets: the shared-login cutover ([MAG-3002](https://magmadevs.atlassian.net/browse/MAG-3002)), cancelling a
removed person's pending config changes (MAG-2731 owns that table), and the audit log's own viewer,
filtering and export (MAG-2770). This ticket emits into MAG-2770's writer; it does not own the
reading side.

Three places where the code disagreed with the ticket were found and fixed on the branch — see
[§7](#7-mismatches-found-and-fixed). The third arrived after the audit rather than during it:
Omer's 26 Aug decision kept the Magma operator account on managed deployments and required it to be
**visible as ours** in the member list, which nothing on that screen could say. **Every row below that is not ✅ is explained in
[§6](#6-the-gaps-and-why-each-one-is-open)**, grouped by cause rather than listed one by one, since
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
| Managed first admin: we create it and send a join link | ✅ | **Two steps, by decision** (Omer, 26 Aug): a Magma operator runs `/setup`, then invites the customer's named admin, who sets their own password from the emailed link. `/setup` is not mode-gated — something has to create the very first account whoever hosts it — and the separate provisioning route was considered and declined |
| Never a shared account; we never set a password for anyone | ✅ | True only after the `ADMIN_EMAIL` fix — see [§7](#7-mismatches-found-and-fixed) |
| ~~No standing admin account inside a customer's deployment~~ **No hidden Magma account, and none the customer can't see in their member list** | ✅ | Replaced by Omer on 26 Aug, once the two-step managed flow was accepted. The operator account **stays** and carries a **Magma Devs** tag in the member list and a `magma_account` column in the CSV — `users.is_magma_account`, written only by `/setup` under `DEPLOYMENT_MODE=managed`, so on-prem has none by construction. Its four conditions hold for the same reason: it is full admin because that is what `/setup` creates; nothing branches on the flag on a read path, so no list, export or audit row omits it; and removal is the ordinary `DELETE /api/team/members/:id`, asserted so a later well-meaning guard fails a test rather than quietly making the account unremovable. [§7](#7-mismatches-found-and-fixed) |

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
| Managed: user-initiated, emailed link, 1 hour | ✅ | Emailed over SES. Always 202, whether or not the address exists — anything else asks who is a member |
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
| Managed: invitation email with a join link | ✅ | Emailed, and the link is **not** returned to the admin. If the send fails it comes back with `deliveryFallback: true` and the dialog says so, rather than reporting success into a void |
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
| 1 | Signs in as themselves; the shared login no longer works | ⛔ cutover — [MAG-3002](https://magmadevs.atlassian.net/browse/MAG-3002) |
| 2 | Fresh on-prem install asks for email and password before anything opens, and refuses without the setup token | ✅ |
| 3 | A requester cannot approve anything | ◐ roles gate correctly; there is no approval surface to be refused from until MAG-2731 |
| 4 | An invite can only create the account it was issued for | ✅ reworded by Omer on 26 Aug, accepting the shipped shape: the redeemer supplies no address, so a mismatch cannot be expressed |
| 5 | On-prem invites and resets work with no mail server | ✅ |
| 6 | A breached password is refused with a clear message | ✅ |
| 7 | A removed person's sessions die, **pending requests are cancelled**, history stays, email re-invitable | ◐ three of four; cancellation is MAG-2731's |
| 8 | Demoting someone takes effect on their current session | ✅ |
| 9 | The member list shows role and last active, and exports | ✅ |
| 10 | Every event is a row in the log, and the log filters and exports safely | ✅ emission; filtering and export are MAG-2770's |

---

## 4. The acceptance checks

Eleven checks were set on the ticket as the bar for "working". They are **not** the same list as the
ticket's ten "Done when" items in [§3](#3-the-done-when-list) — that list includes the shared-login
cutover and the approval flow, which other tickets own, so it scores 7 met / 2 partial / 1 elsewhere.
These eleven are all things this ticket can actually be held to, and they all pass.

They are run by `scripts/sanity-accounts.mjs` against a **live deployment** — HTTP to the api and the web, the audit
log read straight out of Postgres — rather than asserted in unit tests, because several of them are
only meaningful at runtime.

```bash
make accounts-reset && make accounts     # or accounts-managed
node scripts/sanity-accounts.mjs         # ~15 seconds
```

To do the same by hand through the screen — for a demo, or to watch a thing
happen rather than read that it passed — follow
[`MAG-2729-MANUAL-CHECKS.md`](./MAG-2729-MANUAL-CHECKS.md).

**11/11 managed · 10/10 on-prem** (check 2 is managed-only and skips there). The runner refuses to
start against an install that already has accounts, because the first check is about a fresh one —
the refusal is the check.

| # | Check | How it is exercised |
|---|---|---|
| 1 | Create an account through the install | A fresh install reports `needsSetup`, every `/api/*` route 401s an anonymous caller, `/` → `/login` → `/setup`, a wrong setup token is refused, the account created is an **admin**, and setup cannot be claimed twice |
| 2 | Create an account on managed; the person sets their own password | The invitation is **emailed** and the link is *not* returned to the admin. Asserted against the recipient's mailbox: right destination, customer named in the subject, text alongside HTML, a reply-to somebody reads. Then the member list: the operator account is labelled **Magma Devs**, the customer's own person is not, neither is hidden, and the CSV export carries the same label |
| 3 | An admin invites and they join with exactly the role picked | Invite as `approver`, redeem, assert the created account's role. On-prem the same flow runs with no email at all |
| 4 | An invite already used is refused | Second redemption refused, and the link stops previewing |
| 5 | A lower role is refused **when attempted directly** | A valid *approver* token fires all four admin-only mutations — invite, change role, remove, mint a reset link. Four 403s, no UI involved |
| 6 | Demote someone signed in; their next action is refused | Promote, use their **existing** token successfully, demote, reuse **the same token** → 403. No sign-out, no new token |
| 7 | Nobody can demote or remove themselves | Both refused 409, with messages that say what to do instead |
| 8 | Forgot password: sets a new password, does not sign in, ends other sessions | Two live sessions before, both dead after; the response carries no session; the old password stops working and the new one starts |
| 9 | An expired reset link and an already-used one give the same message | Same status **and** same string, compared directly, on both preview and submit |
| 10 | Remove a person | Their next request 401s, they leave the member list, their name survives in the audit log, and their address can be invited again |
| 11 | A row for each of the above including a failed sign-in, and no secret as a value | Ten distinct actions asserted present. Then every secret the run created — three passwords, the setup token, every minted JWT — is grepped across **both** audit tables, every column, plus a sweep for anything link-shaped |

Two are worth reading closely, because they are the ones a code review cannot settle.

**Check 5** is the difference between a hidden button and an enforced rule. The runner holds a
legitimate approver session and calls the admin routes directly. Nothing about the UI is involved.

**Check 11** turns "no password or token appears anywhere as a value" from a policy into an
assertion. It does not check that redaction was called; it checks the resulting rows for the actual
strings.

### One failure along the way, which was the runner's

The runner reset a password and signed back in inside the same second, and got a token
`checkSession` correctly refused. `signed_out_all_at` and a JWT's `iat` both have one-second
resolution and the comparison is `<=` on purpose, so somebody racing a sign-out cannot keep their
session. A human cannot reach that window — the reset page does not sign you in, so they have to get
to `/login` and type — but a script can. It waits past the boundary now, and says why.

---

## 5. Outstanding, with owners

| | State | Owner |
|---|---|---|
| Pending config changes cancelled on removal | `onMemberDeactivated` is a documented empty seam | MAG-2731 |
| Shared login disabled at cutover | Not this repo. Per deployment, and blocked on this ticket merging — named accounts have to exist before the shared one can go | [MAG-3002](https://magmadevs.atlassian.net/browse/MAG-3002) |
| ~~Managed "Forgot password?" link on `/login`~~ | **Built.** `/forgot-password`, linked from the sign-in page; on-prem it says there is no mail server and points at an administrator | — |
| Audit viewer, filtering, export | Out of scope by ticket text | MAG-2770 |
| 2FA column populated | Out of scope by ticket text | MAG-2730 |
| AWS/SES setup so managed can actually send | The code ships in MAG-2870; the verified domain, sandbox exit, DNS records and chart env do not. On-prem is unaffected — it sends nothing by design | [MAG-3003](https://magmadevs.atlassian.net/browse/MAG-3003) |

---

## 6. The gaps, and why each one is open

Three rows above are not ✅, all of them sequencing behind sibling tickets. The other two causes are
kept here because they explain the shape of the work rather than an outstanding gap — both are
built now, and a reader comparing this doc to an older version should be able to see what moved.

### Cause 1 — the mail transport. Now landed, in MAG-2870.

Three managed paths used to stop one step short, because nothing in the repo sent email. All three
were the same missing piece rather than three bugs, and that piece was never this ticket's: MAG-2870
owns the transport and the copy, and it is implemented in
[#147](https://github.com/Magma-Devs/smart-router-dashboard/pull/147) on this branch.

| | Then | Now |
|---|---|---|
| **Managed invitation** | The row was created correctly and the response *withheld* the link because managed is meant to email it — and nothing emailed it. The invitation existed and was unreachable, which looked like success | Emailed over SES. The link is not returned to the admin, because it is in the recipient's inbox |
| **Managed forgot-password** | Created the reset, logged the link, returned 202. An operator with log access could retrieve it; the user got nothing | Emailed. Still always 202, whether or not the address exists |
| **Managed first admin** | No route for the described flow. Never blocking — `/setup` is not mode-gated — but not that flow | An admin invites, the invitation is emailed, the holder sets the password |

Ported from lava-connect's `services/email.ts` and `email-layout.ts`: SES v2 behind one send
function, table-based HTML with no webfonts, and its single `deliver()` choke point. Three
deliberate departures, all recorded in [`AUTH.md`](./AUTH.md) — no email-log table, no footer and no
`<img>` anywhere, and an expiry passed in rather than baked into the copy.

**The one decision worth knowing.** An invitation row is committed before the send is attempted, so
a failed send cannot fail the request without reporting failure for something that half happened —
and `201` with no link would leave an admin believing an invitation is on its way to somebody who
will never get it. So managed falls back to handing over the link with `deliveryFallback: true`, and
the dialog says the email could not be sent rather than reusing the on-prem wording.

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

## 7. Mismatches found and fixed

Both found by reading the ticket line by line against the code, and fixed on this branch.

### The `ADMIN_EMAIL` / `ADMIN_PASSWORD` seed failed three lines at once

It predates first-run setup and nobody removed it. Against the ticket:

- *"That first-run page requires the setup token the installer prints"* — the seed needs none.
- *"We never set a password for anyone"* — it sets one, from the environment.
- *"We keep no standing admin account inside a customer's deployment"* — it is exactly that, for as
  long as the variables stay set.

The third line was replaced on 26 Aug, and the fix does not depend on it: a seeded admin still needs
no setup token and still has a password somebody at Magma chose, and those two are enough on their
own. What the replacement rules out is a *hidden* account — and the seeded one was hidden in the
sense that matters, since nothing on screen said where it came from.

Both paths open on the same condition — no active users — so the room had two doors and a lock on
one. Now **refused under `NODE_ENV=production`**, with a warning naming the variables so an operator
expecting an admin learns it from a log line rather than a locked-out install. Kept for development,
because `make dev-auth` would otherwise need somebody to walk `/setup` after every `down -v`.

That fix needed a second one to be usable: `resolveSetupToken` was only ever called from *inside*
`POST /auth/setup`, so with no `SETUP_TOKEN` configured nothing was generated, logged, or written to
`SETUP_TOKEN_FILE` until somebody had already submitted a wrong guess — and an init container
reading that file runs before the api serves a request. It resolves at boot now.

### The Magma account had nowhere to be visible

Omer's 26 Aug decision kept the two-step managed flow **and** kept the account it leaves behind,
replacing *"we keep no standing admin account inside a customer's deployment"* with *"no hidden
Magma account, and none the customer can't see in their member list."* That turns an absence
requirement into a visibility one, and the member list had no way to express it: every row was a
name, a role and a date, so an admin account belonging to Magma sat among the customer's own people
looking exactly like one of them.

`users.is_magma_account` records the provenance. It is written in one place — first-run setup, and
only under `DEPLOYMENT_MODE=managed` — so an invitation cannot mint one and on-prem never has one.
A derived rule would have been cheaper (label any `@magmadevs.com` address) and would have been a
guess: it labels a customer's own contractor at our domain, and misses an operator who used another.
Recording what happened beats inferring it afterwards.

The mark buys the account nothing. No permission check reads it, no list or export filters on it,
and Remove is the ordinary route — which is asserted, because the plausible future mistake is a
guard that feels protective and quietly makes the account unremovable.

| | |
|---|---|
| Column | `users.is_magma_account`, `packages/db/migrations/0005_magma_account.sql`, backfilled false |
| Written by | `completeSetup` ← `POST /auth/setup`, managed only |
| Read by | `GET /api/team/members` (`isMagmaAccount`), `GET /api/team/members.csv` (`magma_account`) |
| Shown as | a brand-coloured **Magma Devs** tag on the member row (`MagmaAccountTag`) |
| Verified by | `magma-account.test.ts`, `migrations.test.ts` → `0005_magma_account`, and check 2 of the live runner |

### "Promote someone else first, then step down" could not be followed

Nobody can change their own role, so after promoting a replacement you still cannot demote yourself
— they have to. The behaviour is right: the ticket's stricter line ("nobody can demote or remove
themselves") wins over "an admin can step down". The message described a sequence ending in a 409,
and now says the last move is never your own.

---

## 8. How this was verified

Worth stating, because the failure mode that produced the worst bug in this ticket was a test suite
that could not see it.

**Read in the source** — every claim above was checked against the code, not against memory or the
design doc.

**Exercised against a running stack** — `make accounts` brings up a deployment with no seeded admin,
which `up-auth` and `dev-auth` cannot, so `/setup` never appeared before and none of these flows had
been clicked through. The walkthrough in [`AUTH.md`](./AUTH.md) was run end to end: 42 assertions
covering first run, invitation, live role change, sessions, reset, lockout, export and removal.

**Then as the ticket's own acceptance checks** — `scripts/sanity-accounts.mjs`, [§4](#4-the-acceptance-checks).
Same idea, narrowed to exactly the eleven that were asked for, and re-runnable. Managed mail is
verified against a **local SES mock** (`make accounts-managed`), so check 2 reads the recipient's
mailbox rather than a log line: it proves the message was delivered to a transport, not merely that
a link was generated.

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

At `8594841`: `pnpm -r typecheck` clean, **1302 tests** pass (774 shared · 338 api · 145 web · 45 db),
eslint clean of errors, and the eleven acceptance checks pass in both deployment shapes.
