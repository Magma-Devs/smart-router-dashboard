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

### The four checks that need a terminal

Not a shortcoming of the runbook — three of them are asking about things the UI
deliberately does not offer.

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
— check 2 — so nobody at Magma ever knows the customer's password. It does leave
an operator account behind that has to be removed afterwards. Raised with Omer;
no answer yet.

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

✅ **Passes if:** the admin never saw the link, the recipient did, and nowhere in
the flow did anyone but Dana choose Dana's password.

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

```bash
# a fresh invitation, from the admin window: Team → Invite → mallory@example.com
# take its link from http://localhost:8005 and keep just the token:
TOKEN='paste-the-last-path-segment-here'

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
2. **Incognito window** — do not sign out, do not reload yet. Reload Team. The
   **Invite** button is now there, and her rows have **Change role** and
   **Remove**. Same session throughout.
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
2. **Admin window** → Account → **Active sessions** shows only *your* sessions,
   so to see hers, leave both her windows open and trust the effect below.

**Now the reset.** On managed, Dana asks for it herself:

```bash
curl -s -X POST localhost:8000/auth/password/forgot \
  -H 'content-type: application/json' \
  -d '{"email":"dana.okonkwo@dfns.co"}' -w '\nstatus: %{http_code}\n'
```

3. `202`. Run it again with an address that does not exist — **also `202`**.
   Anything else would turn this into a way to ask who is a member.
4. Open http://localhost:8005. The reset email is there: subject *"Reset your
   Smart Router password"*, the link as text as well as a button, *"This link
   expires in 1 hour"*, and a last line saying what to do if it wasn't her.
5. Open the link in the **incognito window**. The page shows **her address**
   under the heading, so somebody with two accounts knows which one they are
   changing, and the rule *"At least 8 characters. Any characters, including
   spaces."* **before** the field rather than after a failure.
6. Set a new password → **Save password**.
7. It says *"Your password has been changed. You have been signed out everywhere
   else."* and offers **Sign in** — it does **not** drop her into the dashboard.
   A reset link that signs you in is a reset link worth stealing.
8. Switch to **Safari**. Click anything. She is signed out.
9. Sign in with the **new** password — works. Try the old one — refused.

✅ **Passes if:** 202 either way, no automatic sign-in, both prior sessions dead,
new password works and the old one does not.

---

## 9 · Expired and already-used links read the same

You just spent a reset link in check 8. Paste **the same link** into the
incognito window again.

1. *"This link has expired."*
2. Now invent one: http://localhost:3000/reset/a-token-that-was-never-issued
3. **Word for word the same message.**

Telling somebody a link was *already used* also tells an attacker it was already
used, so used, expired and never-issued are one answer.

✅ **Passes if:** both screens are identical.

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

✅ **Passes if:** every action above is present, the role change has its
before/after, and the leak count is **0**.

---

## What differs on-prem

`make accounts-reset && make accounts` runs the same build with
`DEPLOYMENT_MODE=onprem`. Everything above behaves identically **except
delivery**, which is the only difference between the two shapes:

| | Managed | On-prem |
|---|---|---|
| Check 2 | The whole check | **Does not apply** — there is no email, by design |
| Invitation | Emailed; the admin never sees the link | The dialog shows the link **once**; the admin passes it on |
| Reset | Dana asks via forgot-password | An admin uses **Reset link** on her row; there is no forgot-password (it 404s — there is nowhere to send it) |
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
