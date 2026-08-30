# The integration branch — sanity checks by hand

`integration/accounts-audit` is **#147 merged into #149**: the accounts, team and
mail work (MAG-2729 + MAG-2870) on top of the audit log's viewer, read API,
export and pull token (MAG-2770). Neither branch does this on its own — #147
writes audit rows and has nothing that reads them, #149 reads them and has
nothing that writes any — so this is the only place the two halves can be seen
working together.

It is a **scratch branch for testing**. It is not for review and must not be
merged into either stack.

Allow about **thirty minutes**. Part A is the accounts work you have seen
before, run fast, purely to put rows in the log. Part B is the new part.

> The automated pass takes fifteen seconds and covers Part A completely:
>
> ```bash
> git checkout integration/accounts-audit
> make accounts-reset && make accounts-managed
> node scripts/sanity-accounts.mjs        # 11/11
> ```
>
> This document is for when you need to *watch* it, and for Part B, which has no
> runner.

---

## Before you start

**A database from either stack alone will not work here.** Both stacks ship a
migration tagged `0002_audit`, with different contents — the audit stack's adds
the `xact_id` column the read cursor depends on. Drizzle records migrations by
tag, so a database that already ran the other stack's `0002_audit` will never
receive that column, and the audit API will misbehave in a way nothing on screen
explains. `make accounts-reset` is mandatory, not hygiene. See
[`AUTH.md`](./AUTH.md) → "Migrations: the two ways they silently do nothing".

```bash
git checkout integration/accounts-audit
make accounts-reset            # wipes the accounts database
make accounts-managed          # rebuilds and boots, DEPLOYMENT_MODE=managed
```

Wait for `GET http://localhost:8000/auth/bootstrap` to answer
`{"needsSetup":true,"mode":"managed"}`.

| | |
|---|---|
| App | http://localhost:3000 |
| API | http://localhost:8000 |
| Inbox (SES mock) | http://localhost:8005 |
| Setup token | `installer-printed-this-token` |

| Who | Credentials |
|---|---|
| Administrator | `ops.admin@magmadevs.com` / `an-admin-passphrase-4417` |
| Invited person | `dana.okonkwo@dfns.co` / `dana-chose-this-one-8890` |

**What you need open:** Chrome for the administrator, an incognito window for the
invited person, and a terminal for the four things the UI deliberately does not
offer (checks B7, B9, and the two noted in Part A).

---

## Part A — put something in the log

The full walkthrough of these is
[`MAG-2729-MANUAL-CHECKS.md`](./MAG-2729-MANUAL-CHECKS.md); follow that document
if you want to check the accounts work itself. What follows is the minimum
sequence that produces a log worth looking at, in the order that works.

1. **Create the first admin.** Open http://localhost:3000. You land on `/setup`,
   not the dashboard. Enter the setup token, `ops.admin@magmadevs.com`, and the
   password above. → `setup.completed`
2. **Sign in** as that admin. → `signin.succeeded`
3. **Team → Invite.** `dana.okonkwo@dfns.co`, role **Approver**. The dialog gives
   you no link — managed emails it. → `member.invited`
4. **Open the inbox** at http://localhost:8005, click through to the invite, and
   redeem it in an **incognito** window with Dana's password above. →
   `invite.redeemed`
5. **Sign in as Dana** in that incognito window. → `signin.succeeded`
6. **Back as the admin: Team → Change role** on Dana, Approver → **Read-only**.
   → `member.role_changed`, and this one carries a diff, which check B3 needs.
7. **Sign out Dana, then fail a sign-in**: try her address with a wrong password
   once. → `signin.failed`
8. **Forgot your password?** on the sign-in page, as Dana. Take the link from the
   inbox and set a new password. → `password.reset_requested`,
   `password.reset_completed`

That is eight actions and about ten rows. Check B6 wants one more thing, so do
this too:

9. **Invite `sheet.test@dfns.co`** as Read-only, and redeem it in incognito —
   but when the page asks for a name, type exactly:

   ```
   =HYPERLINK("http://x","ok")
   ```

   A person's own name is the only free-text that reaches the log on this
   branch; on a full deployment provider names and rejection reasons do too.

---

## Part B — the audit log, through the screen

### B1 · Every role can read it

> *"Visible to every role, including read-only users."*

**As Dana**, who is now Read-only after step 6, open the sidebar. **Audit log**
is there, between the other entries, and it opens.

✅ **Passes if:** a read-only user reaches the log without being told to ask an
administrator. This is deliberate — a log only some people can see is not a
control, and putting it behind an admin gate would have been slow to undo.

### B2 · The actions you just performed are the rows you see

**As the admin**, open **Audit log**. Four columns: Time (UTC), Actor, Action,
Target.

Every step in Part A is there. Note the ordering: **the screen is newest-first**,
which is the opposite of what the API serves a machine (check B9). That is on
purpose — a person opens a log to see what just happened, and a spreadsheet
reverses it in one click.

✅ **Passes if:** each Part A action has exactly one row, named the way the
ticket names it, with the right person against it.

### B3 · A row that changed something shows what changed

Click the `member.role_changed` row from step 6. The side sheet opens.

- Under the header, the change: **role: approver → read_only**
- **Request** shows an em dash — this change skipped approval, which is not a gap
  but the normal path until MAG-2731 ships an approval queue
- Compare with a `signin.succeeded` row: no changes at all. Two shapes of row,
  as the ticket describes — things that changed something, and things that are
  just facts.

✅ **Passes if:** the diff names the field, the value before, and the value
after.

### B4 · Access events carry the context; the others do not

Still in the side sheet, compare two rows:

| Open this | Expect |
|---|---|
| `signin.succeeded` or `signin.failed` | **IP address**, **Client**, and a **Session** id |
| `member.invited` or `member.role_changed` | no context block at all |

✅ **Passes if:** the split is exactly that. It is the ticket's rule and it is
load-bearing: *"Dana changed the provider set"* is complete without an IP — her
name is the answer. *"Someone failed to sign in as Dana"* is close to useless
without one, because you cannot tell a mistyped password from a run of guesses
coming from somewhere else.

### B5 · The filters return the right rows and nothing else

Four controls above the table.

1. **Group** → `access`. Only sign-ins and sign-outs remain; the invites and role
   change disappear.
2. **Person (email)** → `dana.okonkwo@dfns.co`. Only rows where Dana is the
   actor. Note this is *actor*, not subject: the role change the admin made *to*
   Dana is not hers and correctly drops out.
3. **Object id** → paste an id from a Target cell. That object's history alone.
4. **From** / **To** → today's date in both. Everything is still there. Set
   **From** to tomorrow: nothing is.
5. **Clear** puts it all back.

✅ **Passes if:** each filter narrows to exactly its rows, and the empty state
reads **"No events match these filters"** — not the new-deployment message. Two
different empty states, because "your filter is too narrow" and "nothing has
happened yet" are different problems.

### B6 · The export is safe to open in a spreadsheet

> *"Test it with a provider named `=HYPERLINK("http://x","ok")` and confirm the
> cell doesn't execute."*

With **no filters set**, click **Export CSV**. Open `audit-log.csv` in Excel,
Numbers or Google Sheets.

1. Find the `invite.redeemed` row from step 9. The actor name cell shows the
   formula **as text**, beginning with an apostrophe:
   `'=HYPERLINK("http://x","ok")`. Nothing executes, no link renders.
2. The `member.role_changed` row has `field`, `from` and `to` columns filled;
   the `signin.succeeded` rows have them empty. One line per changed field, so a
   change touching three fields is three lines sharing an event id.
3. Now set a filter — Group `access` — and export again. **The file contains
   only access rows.** The export follows the filters, not the rows you happened
   to scroll to.

✅ **Passes if:** the formula is inert in a real spreadsheet, and the filtered
export matches the filtered screen.

### B7 · No secret and no link appears anywhere · terminal

Every password and link the run created, searched for across both audit tables:

```bash
PSQL() { docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard -tAc "$1"; }

PSQL "select count(*) from audit_events
       where audit_events::text ~* 'passphrase|srdash_audit_|/invite/|/reset/'"
PSQL "select count(*) from audit_event_changes
       where audit_event_changes::text ~* 'passphrase|/invite/|/reset/'"
```

Expect `0` from both. **Query the two tables separately** — joining them and
counting once looks tidier and is a trap: if either table is empty the join
yields no rows at all, and a genuine leak in the other reports `0`. **A zero proves nothing on its own**, so run the control — the same
query looking for something that is definitely in there:

```bash
PSQL "select count(*) from audit_events where audit_events::text ~* 'dfns'"
```

A non-zero answer is what makes the first result evidence rather than hope.

✅ **Passes if:** the first is 0 and the second is not.

### B8 · Nobody can edit or delete a row, including an admin · terminal

There is no button for this in the UI, which is the point — but the guarantee is
in the database, not just the absence of a button:

```bash
docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard -c \
  "update audit_events set action = 'nothing.happened'"
docker exec smart-router-dashboard-dev-postgres-1 psql -U sr -d sr_dashboard -c \
  "delete from audit_events"
```

✅ **Passes if:** both are refused by a trigger, as the superuser, on both
tables. This is a product boundary rather than tamper-evidence — hash chaining
is deliberately out of scope — but it means "append-only" is a property of the
schema, not a rule three code paths have to remember.

### B9 · A customer's own tooling can pull the log · terminal

The screen and the export are not what DFNS asked for; this is. There is **no UI
for audit tokens** — they are an API-only surface by design, so this check is a
terminal one.

Sign in and mint a token (`$T` is a session JWT — take it from your browser's
devtools, or use `scripts/sanity-accounts.mjs`'s helper):

```bash
curl -s -X POST http://localhost:8000/api/audit/tokens \
  -H "authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"name":"dfns-siem"}'
```

The response carries the metadata under `token` and the value under `secret`,
shown **once**, prefixed `srdash_audit_`. Then, as that token:

```bash
A="srdash_audit_…"
curl -s -H "authorization: Bearer $A" \
  'http://localhost:8000/api/audit/events?per_page=5'          # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $A" \
  http://localhost:8000/api/team/members                        # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "authorization: Bearer $A" \
  -H 'content-type: application/json' -d '{"name":"another"}' \
  http://localhost:8000/api/audit/tokens                        # 403
```

Then the property the whole thing exists for — **resume without gaps or
duplicates**. Take the `cursor` from the first response and pass it as `after`:

```bash
curl -s -H "authorization: Bearer $A" \
  'http://localhost:8000/api/audit/events?per_page=5&after=<cursor>'
```

✅ **Passes if:** the token reads the log and is refused 403 on everything else
including minting another token; `items` comes back **oldest first**; paging with
`after` never repeats or skips a row; and re-pulling the same range returns the
same `id` values, so a customer's system can drop duplicates.

### B10 · The Magma Devs account is visible · this branch only

This branch also carries the MAG-2729 marker. **Team → Members**: the row for
`ops.admin@magmadevs.com` has a brand-orange **Magma Devs** tag; nobody else
does, including anyone the operator invited. **Export** the member list — its
last column is `magma_account`, `yes` on that one row.

✅ **Passes if:** the one Magma-owned account says so on screen, and the Remove
button on its row is the ordinary one.

---

## What cannot be checked yet, and why

The ticket's event table spans four emitters. Only task 1's rows can exist
today, so a full pass leaves three groups legitimately empty:

| Group | Events | Blocked on |
|---|---|---|
| 2FA | `2fa.enrolled` · `2fa.reset` | MAG-2730 |
| Recovery | `host.recovery` | MAG-2730 |
| Config | `provider.*` · `endpoint.*` · `jwt.*` · `apikey.*` | MAG-2731 |
| Approval | `change.*` | MAG-2731 |

Two consequences worth knowing before you read anything into an empty screen:

- **The `request` column is empty on every row**, because nothing routes through
  an approval queue yet. The ticket asks that a change which skipped approval
  look exactly like one that did not, minus the reference — that is what you are
  seeing, not a missing field.
- **Filtering by Group `config` returns nothing.** Correct today.

Retention is deliberately not implemented: the ticket leaves the periods
undecided and says so.

---

## Starting over

```bash
make accounts-reset && make accounts-managed
```

Back to a fresh install with an empty log. The log's own empty state — *"Sign-ins,
account changes and configuration changes appear here as they happen. The log
starts empty on a new deployment."* — is worth seeing once, because it is the
first thing a real customer sees.

---

## Related

- [`MAG-2729-MANUAL-CHECKS.md`](./MAG-2729-MANUAL-CHECKS.md) — the eleven
  accounts checks in full, which Part A abbreviates
- [`MAG-2729-REQUIREMENTS.md`](./MAG-2729-REQUIREMENTS.md) — requirement coverage
  for the accounts half
- [`AUTH.md`](./AUTH.md) — the operator guide, including the migration trap in
  "Before you start"
