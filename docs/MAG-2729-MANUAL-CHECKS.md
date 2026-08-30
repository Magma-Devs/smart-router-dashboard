# MAG-2729 — the acceptance checks, by hand

The eleven checks on the ticket, done through the screen instead of through
`scripts/sanity-accounts.mjs`. Same coverage, same order of evidence — this is
the version to follow when demonstrating the work to somebody, or when you want
to see a thing happen rather than read that it passed.

Allow about **forty minutes** for a full pass.

**Do them in order.** Each check builds on the state the previous one left: check
1 creates the administrator every later check signs in as, check 3 creates the
person checks 5 to 10 act on, and check 9 reuses the link check 8 spent. Jumping
to check 2 on a fresh install just returns you to `/setup`, because there is no
admin yet to invite anybody.

> The script does all of this in fifteen seconds:
>
> ```bash
> make accounts-reset && make accounts-managed
> node scripts/sanity-accounts.mjs
> ```
>
> Run that first if you only need the answer. This document is for when you need
> to *watch* it.

---

## What you need open

| | |
|---|---|
| **Chrome, normal window** | the administrator |
| **Chrome, incognito** | the invited person |
| **Safari (or Firefox) private** | the invited person's *second* device, needed once, in check 8 |
| **A terminal** | four checks cannot be done from a browser — see below |
| **A second terminal tab** | optional, for watching `docker logs` |

**Two incognito windows are not two sessions.** Chrome shares one incognito
profile across every window, so signing in twice there gives you one session,
not two. That is why check 8 needs a genuinely different browser.

### The three checks that need a terminal

Not a shortcoming of the runbook — all three are asking about things the UI
deliberately does not offer. **Check 8 used to be here and no longer is**: the
sign-in page now has a *Forgot your password?* link, so the whole reset flow is
clickable.

| Check | Why |
|---|---|
| 4 (part 2) | Submitting a rogue address alongside a token. No form lets you do this, which is the point |
| 5 | "Refused **when attempted directly**" is a statement about the api, not the UI. A hidden button proves nothing |
| 7 (part 2) | The buttons are absent on your own row, so proving the *server* refuses needs a direct call |
| 11 | The audit log has no viewer yet — that is MAG-2770 |

---

## Setup

```bash
cd ~/go/smart-router-dashboard
git checkout feat/MAG-2870-account-emails    # every MAG-2729 slice + MAG-2870
make accounts-reset && make accounts-managed
```

Wait for it to settle, then confirm all three are up:

```bash
curl -s localhost:8000/auth/bootstrap     # {"needsSetup":true,"mode":"managed"}
curl -s localhost:8005/store              # {"emails":[],"templates":{}}
open http://localhost:3000
```

| | |
|---|---|
| App | http://localhost:3000 |
| Inbox | http://localhost:8005 |
| Setup token | `installer-printed-this-token` |

**Managed mode is the right choice for a full pass**, because check 2 is
managed-only. Mail goes to a local mock, so nothing leaves your machine. See
[what differs on-prem](#what-differs-on-prem) at the end.

### Sign out before you start

`make accounts-reset` wipes the database, but it cannot reach into your browser.
If you were signed in on a previous run you are still holding that cookie, and
its signature is still valid because `AUTH_SECRET` did not change — so the app
believes you are signed in to an account that no longer exists.

What that looks like: pages load but every panel reports **"Your session is no
longer valid"**, the **Invite** button is missing because the page cannot read
your role, and — the part that actually blocks you — **`/setup` bounces you to
`/overview`**, because the edge gate only sees the cookie and has no way to ask
the database whether the deployment needs setting up.

So before check 1: **sign out** (the icon by your name, bottom-left), or start in
a fresh incognito window. Either clears it.

> Worth knowing beyond the runbook: this is the restored-backup case the ticket
> calls out. Restore a backup that predates the first account and an admin still
> holding an unexpired cookie cannot reach first-run setup until they clear it.
> Nobody gains access they should not — it is a way of being stuck, not a hole.

### Names used below

Use whatever you like, but the document refers to:

| | |
|---|---|
| Administrator | `ops.admin@magmadevs.com` / `an-admin-passphrase-4417` |
| Invited person | `dana.okonkwo@dfns.co` / `dana-chose-this-one-8890` |

---

## 1 · Create an account through the install

> *"On-prem, a fresh deployment lets someone create an account, that account is
> an admin, and nothing else in the dashboard is reachable until it exists."*

**This check is identical in both modes**, even though it is written as an
on-prem one. `/setup` is gated on *"this deployment has zero active users"* and
not on `DEPLOYMENT_MODE` — something has to create the very first account, and a
deployment with nobody in it has nobody to sign in as regardless of who hosts it.

So on managed you also start here, which is a small divergence from the ticket's
managed wording (*"we create the account and send a join link"*). In practice a
Magma operator runs this page, then invites the customer's named person by email
— check 2 — so nobody at Magma ever knows the customer's password.

**That operator account stays.** Omer settled it on 26 Aug: ship the two-step
flow, don't build the separate provisioning route, and don't remove the account
afterwards. What changed with it is the rule it answers to — *"we keep no
standing admin account inside a customer's deployment"* became *"no hidden Magma
account, and none the customer can't see in their member list"*. So on managed
this account is labelled **Magma Devs** in the member list from the moment it
exists, is full admin, is logged and exported like anyone else, and a customer
admin can remove it like any other member. On-prem it is the customer's own
first admin and carries no label at all. Check 2 is where you see the tag.

**In the admin window**, go to http://localhost:3000.

1. You land on `/setup`, not the dashboard. The route is `/` → `/login` →
   `/setup`: a deployment with no accounts has nobody to sign in as.
2. Try to reach something else directly — http://localhost:3000/team,
   http://localhost:3000/metrics. Every one comes back to setup. **Nothing is
   reachable until an account exists.**
3. Enter a **wrong** setup token with a valid email and password. Refused.
   Without the token, whoever reaches the URL between install and the operator
   sitting down becomes the admin.
4. Now the real token, and try `correct horse battery staple` as the password.
   Refused as breached — a live HaveIBeenPwned lookup, where only the first five
   characters of the password's SHA-1 leave the process.
5. Real token, real password. You land signed in.
6. Check the sidebar: your name, and the badge reads **ADMIN**.

**Then confirm it cannot be claimed twice.** Open a new incognito window and go
to http://localhost:3000/setup — you are sent to `/login` instead. The gate is
"no active users", not a one-time flag, which is what protects a deployment
restored from a backup.

✅ **Passes if:** setup was unreachable without the token, the breached password
was refused, the account created is an admin, and `/setup` is now closed.

---

## 2 · Create an account on managed

> *"We create it, and the person sets their own password from the join link.
> Nobody at Magma ever knows it."*

**Admin window** → **Team** → **Invite**.

1. Enter `dana.okonkwo@dfns.co`, pick **Approver**, create.
2. Read the dialog. On managed it tells you the invitation was emailed and
   **gives you no link** — the link is in the recipient's inbox and nowhere
   else. There is no password field anywhere in this flow.
3. The page switches to the **Invites** tab, where the invitation is listed as
   pending with its expiry.

**Open the inbox** at http://localhost:8005.

4. The message is there. Check it against what the ticket asks for:
   - subject **"You've been added to DFNS on Smart Router"** — the customer's
     name, because this lands somewhere that has never heard of us
   - a **Set up your account** button
   - the same link again **as plain text** underneath, because mail clients
     strip buttons and people forward these
   - *"The link works once and expires in 7 days. It only works for
     dana.okonkwo@dfns.co."*
   - **no unsubscribe, no footer, no images** — a remote image in a security
     email reports when it was opened and from where
   - **the inviter is not named.** An invite goes to an address nobody has
     verified, so a mistyped one would put your name in a stranger's inbox

**Back in the admin window** → **Team** → **Members**.

5. The row for `ops.admin@magmadevs.com` carries a brand-orange **Magma Devs**
   tag beside the name. That is the account you created in check 1: it is ours,
   it is staying, and the customer is looking at it rather than wondering who
   the extra admin is. Hover it for the sentence that says it can be removed
   like any other member.
6. Nobody else has the tag — not Dana once she joins in check 3, and not an
   admin the operator invites. The label means *this account is Magma's*, not
   *Magma created it*, so only first-run setup ever applies it.
7. **Export** the list. The CSV's last column is `magma_account`, `yes` on that
   one row and `no` on the rest. Nothing is filtered out of either surface —
   an account the customer cannot see in their own member list is the thing
   this replaced.
8. On-prem there is no such row: run the same page after `make accounts` and
   every account is the customer's, tagless.

✅ **Passes if:** the admin never saw the link, the recipient did, nowhere in
the flow did anyone but Dana choose Dana's password, and the one Magma-owned
account on the deployment says so on screen.

---

## 3 · They join with exactly the role picked

**Copy the link** out of the inbox and paste it into the **incognito window**.

1. The address `dana.okonkwo@dfns.co` is shown as **fixed text, not a field**.
   The account is created from the invitation row, so there is nothing here that
   could disagree with it.
2. The role is shown, with a line describing what it can do.
3. Set a password and **Accept invitation**. You land signed in as Dana.
4. **Back in the admin window**, reload Team. Dana is in **Members** with the
   role **Approver** — the one you picked, not a default.

✅ **Passes if:** the role on the row matches the role you chose.

---

## 4 · An invite already used is refused

**In the incognito window**, paste the same link again.

1. Dead. It does not offer the form a second time.

**Then the other half, which needs the terminal.** *"Redeemable only by the
address it was sent to"* used to be a comparison. It is now structural: the
redeemer supplies no address at all, so there is nothing to compare. Prove it by
trying to supply one anyway.

First, **invite `mallory@example.com`** from the admin window — Team → Invite.
Do not reuse Dana's link here; hers has been redeemed already, which is the
other half of this check.

The token is everything after `/invite/` in the link:

```
http://localhost:3000/invite/XgyWcnWySTQNTBOC_3OUOLeMEZ1vSVcM5chJWemUcDs
                             └──────────────── the token ───────────────┘
```

Copy it out of the inbox by hand, or let the shell take the newest one:

```bash
TOKEN=$(curl -s localhost:8005/store | python3 -c "
import json,sys,re
print(re.search(r'/invite/([A-Za-z0-9_-]+)', json.load(sys.stdin)['emails'][-1]['body']['text']).group(1))")
echo "$TOKEN"          # sanity-check it is not empty
```

On-prem there is no inbox — the link is in the dialog when you create the
invitation, so copy the token straight from there.

Then:

```bash

curl -s -X POST localhost:8000/auth/invite/accept \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"password\":\"a-good-passphrase-771\",\"email\":\"attacker@evil.co\"}" \
  | python3 -m json.tool
```

The account comes back as **`mallory@example.com`**. The `email` field was
ignored — the api does not read one.

✅ **Passes if:** the used link is refused, and the submitted address had no
effect.

---

## 5 · A lower role is refused when attempted directly

> *"Not just when the button is hidden."*

**First, the UI half.** In the incognito window Dana (Approver) can see Team, but
her rows have no **Change role** or **Remove** buttons, and there is no
**Invite**.

**Now the half that matters.** A hidden button proves nothing — the api has to
refuse the call. Get Dana's token:

1. In the **incognito window**, open DevTools (`⌥⌘I`) → **Network**.
2. Reload the Team page.
3. Click any request to `/api/team/…` → **Headers** → **Request Headers**.
4. Copy the value of `authorization`, **without** the leading `Bearer `.

```bash
DANA='eyJ…'                       # paste it here
ADMIN_ID=$(curl -s localhost:8000/api/team/members -H "authorization: Bearer $DANA" \
  | python3 -c 'import json,sys
m = json.load(sys.stdin)["members"]
print([x["id"] for x in m if x["email"] == "ops.admin@magmadevs.com"][0])')

# she can read the member list — approver is allowed that
curl -s -o /dev/null -w 'read members     : %{http_code}\n' \
  localhost:8000/api/team/members -H "authorization: Bearer $DANA"

# and is refused all four admin-only mutations
curl -s -o /dev/null -w 'invite somebody  : %{http_code}\n' -X POST \
  localhost:8000/api/team/invites -H "authorization: Bearer $DANA" \
  -H 'content-type: application/json' -d '{"email":"x@y.co","role":"admin"}'

curl -s -o /dev/null -w 'change a role    : %{http_code}\n' -X PATCH \
  "localhost:8000/api/team/members/$ADMIN_ID" -H "authorization: Bearer $DANA" \
  -H 'content-type: application/json' -d '{"role":"read_only"}'

curl -s -o /dev/null -w 'remove a member  : %{http_code}\n' -X DELETE \
  "localhost:8000/api/team/members/$ADMIN_ID" -H "authorization: Bearer $DANA"

curl -s -o /dev/null -w 'mint reset link  : %{http_code}\n' -X POST \
  "localhost:8000/api/team/members/$ADMIN_ID/reset-link" -H "authorization: Bearer $DANA"
```

✅ **Passes if:** `200` for the read and **`403` for all four mutations**. Keep
`$DANA` — the next check reuses it.

---

## 6 · Demote someone who is signed in

> *"Their next action is refused without them signing out."*

This is the one worth watching, because it is the difference between a role
that is checked per request and one baked into a token at sign-in.

1. **Admin window** → Team → Dana's row → **Change role** → **Admin**.
2. **Incognito window** — reload Team. Her badge now reads **Admin**, the
   **Invite** button and the **Invites** tab appear, and the admin controls
   **Change role · Reset link · Remove** appear on the *other* member's row.

   **Her own row stays empty**, and that is check 7 rather than a fault: nobody
   can change or remove themselves, so those buttons are never drawn on your own
   row. Look at the other person's row.

   She has not signed out; it is the same session throughout. The page also
   corrects itself within fifteen seconds without a reload, because the role is
   polled.

   The screen follows the row because the page reads its own role from
   `GET /api/account/me` — the live account — rather than from the session,
   whose copy is stamped once at sign-in. Before that endpoint existed, a
   demoted person kept seeing admin buttons that then 403'd, for up to the
   30-day session lifetime.

3. Prove the api agrees, using the **same token from check 5**:

   ```bash
   curl -s -o /dev/null -w 'invite as admin  : %{http_code}\n' -X POST \
     localhost:8000/api/team/invites -H "authorization: Bearer $DANA" \
     -H 'content-type: application/json' \
     -d '{"email":"probe@example.com","role":"read_only"}'
   ```

   `201`. No new sign-in, no new token.

4. **Admin window** → change Dana back to **Read-only**.
5. Run **the exact same command again**, with the same `$DANA`:

   `403`.

✅ **Passes if:** one unchanged token gets `201` and then `403` across a
demotion. The role is read from the row on every request.

---

## 7 · Nobody can demote or remove themselves

1. **Admin window** → Team. Your own row is marked **· you**, and has **no**
   Change role or Remove buttons.
2. Prove the server refuses too, not just the screen. Get **your own** token the
   same way as in check 5, from the admin window's DevTools:

   ```bash
   ME='eyJ…'
   MY_ID=$(curl -s localhost:8000/api/team/members -H "authorization: Bearer $ME" \
     | python3 -c 'import json,sys,os;
   d=json.load(sys.stdin)["members"]
   print([m["id"] for m in d if m["email"]=="ops.admin@magmadevs.com"][0])')

   curl -s -X PATCH "localhost:8000/api/team/members/$MY_ID" \
     -H "authorization: Bearer $ME" -H 'content-type: application/json' \
     -d '{"role":"read_only"}' | python3 -m json.tool

   curl -s -X DELETE "localhost:8000/api/team/members/$MY_ID" \
     -H "authorization: Bearer $ME" | python3 -m json.tool
   ```

✅ **Passes if:** both return **409**, with messages explaining what to do
instead — *"promote someone else and ask them to demote you"* and *"You cannot
remove yourself."*

---

## 8 · Forgot password

> *"The link sets a new password, does not sign the person in, and ends their
> other sessions."*

**Give Dana a second session first**, or there is nothing to end.

1. Open **Safari (or Firefox) private** and sign in as Dana. She is now signed
   in on two devices: incognito and Safari.

   Two, not three: neither redeeming an invitation nor first-run setup opens a
   session any more. Both used to, and the page then signed in on top of it,
   leaving everybody with a device on their list they had never used.
2. Her own **Account → Active sessions** now lists two devices. Yours lists
   only yours: the list is scoped to the caller, so an admin never sees anybody
   else's sessions.

> **This is the reset flow, not the change flow**, and they are different on
> purpose. **Change password** on the Account tab needs your *current* one, takes
> effect immediately, sends no email, and **keeps** the device you are on.
> **Reset** is for when you cannot sign in at all: no current password, a link
> delivered instead, and it closes **every** session including the one that used
> it — because a reset is what somebody does when they think another person is
> in their account.
>
> Only the reset flow has an email in it. If you change the password from the
> Account tab, nothing is sent — a "your password was changed" notice is
> MAG-2868's, not this ticket's.

**Now the reset — entirely in the browser.** On managed, Dana asks for it
herself.

3. **Incognito window** — sign Dana out, so you are on `/login` as a stranger
   would be. Click **Forgot your password?** under the Sign in button.
4. Enter `dana.okonkwo@dfns.co` → **Send reset link**. It says **"Check your
   inbox"**.
5. **Do the enumeration check while you are here.** Go back and submit
   `nobody@nowhere.co`, an address with no account. **Word for word the same
   screen.** Anything else would turn this form into a way to ask who is a
   member — and the inbox stays empty, so nothing was sent either.
6. Open http://localhost:8005. Dana's reset email is there: subject *"Reset your
   Smart Router password"*, the link as text as well as a button, *"This link
   expires in 1 hour"*, and a last line saying what to do if it wasn't her.
7. Click the link. The page shows **her address** under the heading, so somebody
   with two accounts knows which one they are changing, and the rule *"At least
   8 characters. Any characters, including spaces."* is shown **before** the
   field rather than after a failure.
8. Set a new password → **Save password**.
9. It says *"Your password has been changed. You have been signed out everywhere
   else."* and offers **Sign in** — it does **not** drop her into the dashboard.
   A reset link that signs you in is a reset link worth stealing.
10. Switch to **Safari**. Click anything. She is signed out.
11. Sign in with the **new** password — works. Try the old one — refused.

> **On-prem** there is no mail server, so the same button says so and points at
> an administrator. Use **Reset link** on her row in the Team page instead; the
> rest of the steps are identical.

✅ **Passes if:** both addresses give the same screen and only the real one
receives mail, there is no automatic sign-in, both prior sessions are dead, and
the new password works where the old one does not.

---

## 9 · Expired and already-used links read the same

A reset link stops working for four different reasons, and the check is that
whoever holds one **cannot tell which**:

| | |
|---|---|
| **Already used** | single-use; somebody set a password with it |
| **Expired** | 1 hour managed, 24 hours on-prem |
| **Superseded** | asking for a new link invalidates the previous one, so there is never more than one live way in |
| **Never issued** | a guessed or invented token |

1. You just spent a link in check 8. Paste **the same link** in again →
   *"This link has expired."*
2. Invent one: http://localhost:3000/reset/a-token-that-was-never-issued →
   **word for word the same page.**
3. If you would rather not spend a link to see this, use the third case instead:
   request a reset, then request **another**, then open the **first** email's
   link. Also dead, also the same message — and nothing was consumed.

Put two of them side by side. Same heading, same body, same button.

**Why they must match.** If *"already used"* read differently, somebody holding a
stolen or guessed token learns that it was real, belonged to an account, and had
been used — an answer they should never get for free. Same reasoning as the
sign-in page giving one answer for a wrong password and an unknown address.

The only thing that varies is what to do next: managed offers to send another,
on-prem says to ask an administrator. Both refuse identically, which is the part
under test.

✅ **Passes if:** every dead link gives the same heading and the same body.

---

## 10 · Remove a person

1. **Incognito window** — make sure Dana is signed in and on the Team page.
2. **Admin window** → Team → Dana's row → **Remove**. The dialog names her and
   says what will happen, because "remove" reads like a deletion and this
   deliberately is not one.
3. Confirm.
4. **Incognito window** — click anything. She is signed out **immediately**, not
   at her next sign-in.
5. **Admin window** — she is gone from Members.
6. **Her history stays.** In the terminal:

   ```bash
   docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard \
     -c "select occurred_at::time(0), action, actor_name, target_name
           from audit_events where target_name = 'dana.okonkwo@dfns.co'
          order by seq"
   ```

   Her name is still on every row. A removed person keeps their name in the log
   permanently — that record is what an auditor reads.
7. **Her address is free again.** Team → Invite → `dana.okonkwo@dfns.co`.
   Accepted, as a brand-new account.

✅ **Passes if:** the session died at once, the history survived, and the address
was re-invitable.

---

## 11 · The log has a row for each of the above

There is no viewer yet — that is MAG-2770 — so read the table directly.

```bash
docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard \
  -c "select occurred_at::time(0) as at, action, actor_name, target_name, note
        from audit_events order by seq"
```

Look for a row from each thing you did, **including a failed sign-in** — if you
have not produced one yet, mistype your password once and re-run:

```
setup.completed            member.invited           member.role_changed
signin.succeeded           invite.redeemed          member.removed
signin.failed              invite.revoked           password.reset_requested
                                                    password.reset_completed
```

Role changes carry a real before/after, not a sentence:

```bash
docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard \
  -c "select e.action, c.field, c.from_value, c.to_value
        from audit_event_changes c join audit_events e on e.seq = c.event_seq
       order by c.event_seq"
```

**Now the part that matters most.** Search the whole log for the secrets you
used — every password you typed, the setup token, and any link:

```bash
docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard -c "
select count(*) as leaks from audit_events
 where coalesce(action,'') || coalesce(actor_name,'') || coalesce(actor_email,'')
    || coalesce(target_name,'') || coalesce(target_id,'') || coalesce(note,'')
    || coalesce(client,'')
       ~* 'passphrase|installer-printed|/invite/|/reset/'"
```

**`0` is the pass.** It is also what a broken query returns, so prove the query
works by pointing it at something you know is there:

```bash
docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard -c "
select count(*) as hits from audit_events
 where coalesce(action,'') || coalesce(actor_name,'') || coalesce(actor_email,'')
    || coalesce(target_name,'') || coalesce(target_id,'') || coalesce(note,'')
    || coalesce(client,'')
       ~* 'dana|passphrase|installer-printed'"
```

Same query, one word added. It should return a healthy count — every row
mentioning Dana. That is what makes the `0` above mean something: the search
finds things when there are things to find, and finds no secrets.

✅ **Passes if:** every action above is present, the role change has its
before/after, the leak count is **0**, and the control query above is not.

---

## What differs on-prem

`make accounts-reset && make accounts` runs the same build with
`DEPLOYMENT_MODE=onprem`. Everything above behaves identically except
**delivery** and the **Magma Devs tag**:

| | Managed | On-prem |
|---|---|---|
| Check 2 | The whole check | **Does not apply** — there is no email, by design |
| Magma Devs tag | On the first-run account, permanently | Never — on-prem gets no Magma account |
| Invitation | Emailed; the admin never sees the link | The dialog shows the link **once**; the admin passes it on |
| Reset | Dana clicks **Forgot your password?** and gets an email | The same button says there is no mail server and points at an administrator; use **Reset link** on her row instead |
| Inbox | http://localhost:8005 | Nothing to look at |
| Dead reset link | *"Request a new one and we'll email it to you"* | *"Ask an administrator to generate a new one"* |
| Check 1 | Identical | Identical — `/setup` is gated on zero users, not on the mode |

On-prem is the shape that ships without a mail server, so a customer never needs
one. Ten of the eleven checks apply.

**On-prem is also the faster pass**, if you only want to see the account system
work rather than the email with it: no inbox to switch to, and the invitation
and reset links appear directly in the dialogs. Run managed when the emails
themselves are the thing you want to show.

---

## Starting over

```bash
make accounts-reset && make accounts-managed    # or accounts
```

Wipes the database and the inbox and returns you to the first-run page. Worth
doing before a demo — a run leaves removed people and spent invitations behind,
all of which are supposed to persist.

## Related

- `scripts/sanity-accounts.mjs` — the same eleven, automated
- [`MAG-2729-REQUIREMENTS.md`](./MAG-2729-REQUIREMENTS.md) — every requirement
  against what implements it
- [`AUTH.md`](./AUTH.md) — how the whole thing works, and the env that configures it
