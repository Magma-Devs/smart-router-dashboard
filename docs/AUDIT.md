# The audit log

MAG-2770. Who did what, and when — an append-only record of sign-ins, account
changes and configuration changes, kept in Postgres beside the state it
describes and readable three ways: on the **Audit log** page, over a **pull
API** built for a security team's tooling, and as a **CSV export**. All three
run the same query, so no surface can disagree with another.

Everything here requires `AUTH_MODE=enabled`. Without accounts there are no
routes, no page, and no log.

## What is recorded

Two tables, written by one writer (`packages/db/src/audit.ts`):

- `audit_events` — one row per event. Actor (with the name and address
  *snapshotted*, so a later rename or removal cannot rewrite history), action,
  target, an optional note, and — only for the event kinds that carry one — the
  IP address, client and session it came from. Every read surface shows the
  session as a reference rather than its id (see [Sessions](#sessions)).
- `audit_event_changes` — for events that record a change, one row per field:
  `field`, `from`, `to`. Values are redacted at write time; no secret or node
  URL is ever stored.

Both tables are **append-only, enforced in the database**: a trigger refuses
`UPDATE` and `DELETE` for every principal, admins included. There is no way to
alter or remove a row through the product. (Operators with database access have
a retention escape hatch — `set local audit.purge = 'on'` inside a transaction
— which exists for data-retention law and for nothing else.)

### Rows that commit with their change

For the events that record how a person gets into an account, or loses the
ability to let others in, the row is written in the same transaction as the
change it records, and a row that cannot be written undoes the change and
fails the request:

- an admin generating a reset link (`password.reset_link_generated`);
- a reset link being used (`password.reset_completed`, and a
  `session.revoked` for each session it ended);
- an invitation being redeemed (`invite.redeemed`, and for a Google or GitHub
  redemption the session it opens and its `signin.succeeded`);
- removing a member or changing a role, with everything those revoke (below).

A refused sign-in has no change of its own to share a transaction with. The
attempt it spent is counted before the credential is checked and commits
then, so a refusal row that cannot be written never gives that attempt back:
the row (`signin.failed`, or `signin.blocked` for an account that was removed)
is written in a transaction of its own, and the request answers `500` rather
than the usual refusal. A lockout's `signin.blocked` row is written in the
transaction that counted the attempt, since no credential is checked between
the two. A row written outside any transaction is reported in the api's log
and dropped when its write fails.

### What a removal or a demotion revokes

Removing a member, or changing an admin to any other role, revokes what they
handed out as an admin, in the same transaction: invitations they sent that
nobody has redeemed (`invite.revoked`), reset links they generated that nobody
has used (`password.reset_link_revoked`, naming the member the link was for),
and audit tokens they created (`apikey.deleted`). The acting admin is the
actor, and each note names who the thing came from: `created by Dana, who was
removed` or `created by Dana, who is no longer an admin`.

### When a row's time is not the time it was written

`invite.expired` is recorded the first time anything notices the expiry (the
link being opened, or an admin's Invites list), and the row's time is the
invitation's expiry, not that later moment. The feed's order is unaffected:
it follows the order rows were written, so a puller resuming from its cursor
still receives the row.

### What a sign-in or reset request records

- A refused Google or GitHub sign-in writes `signin.failed`, with the address
  the provider verified (when it gave one) and why: no account with this
  address, no verified email address, or a token it would not verify.
- A sign-in at the address of a removed account, with a password or with
  Google or GitHub, writes `signin.blocked` against that account, with a note
  ending `account removed`. A password sign-in there gets the same `401` as an
  address with no account.
- Every forgot-password request a managed deployment with a mail transport
  accepts writes `password.reset_requested`, including the ones that send
  nothing. The note says which: `emailed`, `email failed, no
  link delivered`, `not re-sent, a recent link is still unused`, `not sent, no
  account with this address`, `not sent, account removed`, or `not sent, the
  account has no password`. The answer is the same `202` for all of them, sent
  before the address is looked up.
- On a managed deployment, the email telling the owner their password was
  reset is recorded on its own `password.reset_notice` row after
  `password.reset_completed`, since that row has already committed when the
  email is sent.
- "Sign out everywhere" writes a `session.revoked` for every other device and
  a `signout` for the one it was done from.

### The catalog

The event vocabulary is a closed catalog
(`packages/shared/src/constants/audit-events.ts`), and it is **published**:
`GET /api/audit/catalog` returns every event name, its group, what it means,
and whether its rows carry field changes and an access context — readable with
a session or an audit token, and derived from the same constant the writer and
the filters validate against. The API refuses a filter naming an unknown
action rather than answering with an empty page — an empty answer for
`signin.failure` reads exactly like "this never happened", which is the one
thing an audit surface must never imply.

## The page

**Audit log** in the sidebar, visible to **every role** including read-only.
Reading the record of what happened is not a privilege; changing things is.
Newest first, filterable by group, person, object and date, with a detail
sheet per event and an **Export CSV** button that exports what the filters
say — not just the page on screen.

A row names its event in words ("Sign-in failed", "Session ended"), its
group, and its target by the name it had at the time. The detail sheet keeps
the codes the API and the CSV use: the event's (`signin.failed`) and the
target's kind and id, which is what the **Object id** filter takes. It gives
the time twice, on the reader's clock and in UTC
(`Nov 12, 2026, 12:22:07 UTC`), the zone the notification emails state, so a
row can be matched with the email it sent.

The **Group** filter offers the groups something in the product writes. The
config-approval events (group `approval`) are in the catalog with no writer
yet, so that group is not offered, and the sheet shows an **Approval request**
only on a row that names one. `apps/web/src/components/audit/filter-groups.ts`
holds the groups left out, and a test fails when it disagrees with the
writers.

It reads a page at a time — 25, 50 (the default) or 100 rows — with
**Newest**, **Newer** and **Older** above and below the table and a label
saying where the reader is ("Newest 50", "Older entries · page 3"). A page is
the rows next to a row, never an offset: Older reads `after` the last row on
screen and Newer reads `before` the first, so entries recorded at the head
while someone reads further down never shift or repeat what they see.
Stepping back up to the page that was the newest shows it as it was and says
how many entries have arrived above it ("7 new entries since this page was
the newest — Show"); nothing slides in on its own, and Refresh re-reads the
page on screen.

The position is in the URL, so a reload, Back / Forward and a shared link
open the same page:

| Parameter | Meaning |
| --------- | ------- |
| `group` · `actor` · `target` · `from` · `to` | The filters (`from` / `to` as `yyyy-mm-dd`) |
| `size` | Rows per page, 25 or 100; 50 is the default and stays out of the URL |
| `older` / `newer` | An api cursor: the page older than that row, or newer than it. Neither is the newest page |
| `page` | How many pages down from the newest, for the label only |

A filter or page-size change starts again at the newest page — the cursor on
screen was issued for the old filter set, and the api refuses it under
another. A link whose cursor the api refuses says so and offers the newest
entries.

**Person** and **Object id** apply once typing pauses (350 ms), and a run of
typing in one box is one history entry, so Back undoes the word rather than a
letter. Person also waits for a value the api takes — a user id (UUID) or
anything with an "@" — so a half-typed address sends nothing and shows no
error. Enter, or leaving the box, applies whatever it holds; a value the api
refuses then shows the error, as the same value in a link does.

## The pull API

```
GET /api/audit/events
```

Authenticated with a session **or an audit token** (below). Query parameters:

| Parameter     | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `from` / `to` | RFC 3339 bounds on the recorded time, both inclusive           |
| `actor`       | One person — user id (UUID) or email address                   |
| `action`      | Event name, repeatable                                         |
| `group`       | Event group, repeatable                                        |
| `target_type` / `target_id` | The object an event is about                     |
| `order`       | `asc` (default — oldest first, resumable) or `desc` (viewer)   |
| `per_page`    | Rows per page, default 100, max 1000                           |
| `after`       | The `cursor` from a previous response: the page after it       |
| `before`      | The `start_cursor` from a previous response: the page ahead of it — newer rows under `desc`. Not with `after` |

The envelope is `{ items, cursor, has_more, start_cursor, has_previous }`:
`cursor` and `has_more` describe what lies past the page's last row,
`start_cursor` and `has_previous` what lies ahead of its first, whichever way
the page was read. A scheduled puller needs only the first pair — it stores
`cursor` and sends it back as `after` on the next run:

```sh
TOKEN=srdash_audit_…            # minted by an admin over the API, shown once
CURSOR_FILE=.audit-cursor
after=$(cat "$CURSOR_FILE" 2>/dev/null)
page=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://dash.example.com/api/audit/events?per_page=500${after:+&after=$after}") || exit 1
jq -c '.items[]' <<<"$page" >> events.ndjson
# A page with nothing new has no cursor: keep the stored one, or the next
# run starts again from the first event.
next=$(jq -r '.cursor // empty' <<<"$page")
if [ -n "$next" ]; then printf '%s\n' "$next" > "$CURSOR_FILE"; fi
```

**The resume is gap-free and duplicate-free.** A row is served only once its
writing transaction has settled, and the feed is ordered by `(transaction,
sequence)` — an order that late-committing transactions only ever *append* to.
A row whose transaction commits late is therefore delivered late rather than
never, and never twice. The honest cost: the feed is not strictly ordered by
recorded time across pages; each row's `time` says when it happened, and the
feed order exists for resuming, not for display.

Rules a puller must know:

- The cursor encodes the **filter set and direction** it was issued for. A
  resume under different filters or the other `order` is refused with a 400 —
  answering it would silently skip rows.
- A misspelled `action` or `group`, a malformed `actor`, an unparseable time,
  `after` and `before` together, and a cursor this endpoint did not issue are
  all **400**, never an empty page.
- Changing `per_page` mid-pull is fine; it is not part of the cursor.

Each item carries `id`, `time`, `action`, `group`, `source`, `actor`,
`target`, `request`, `note` and `changes`, and, on the event kinds that carry
one, a `context` of `ip`, `client` and `session`. A config event has no
`context` key at all rather than one full of nulls.

### Sessions

`context.session` is a reference to the sign-in the event came from: the first
12 hex characters of the SHA-256 of the session id. Every row that sign-in
wrote carries the same reference, and so does the `session.revoked` row that
ended it, as its `target.id`. The session id itself appears on no read
surface: not the page, the export or this API. `target_type=session&target_id=`
takes the reference, and a session id there matches nothing.

## The CSV export

```
GET /api/audit/export.csv
```

The same filters, the same 400s, the whole matching history — streamed, so it
is bounded-memory on the server however long the log is. Flat on purpose: one
line per changed field (a change touching three fields is three lines sharing
one `event_id`), and events with nothing to diff get one line with the field
columns empty. Columns:

```
event_id,time,actor_name,actor_email,source,action,group,
target_type,target_id,target_name,request,note,ip,client,session,field,from,to
```

`ip`, `client` and `session` are the event's access context (the page's
**IP address**, **Client** and **Session**), empty on events that carry none;
`session` and a session's `target_id` hold the [reference](#sessions), as in
the feed.

Starts with a UTF-8 BOM (Excel assumes the local codepage otherwise; scripted
consumers read it as `utf-8-sig`), CRLF line endings, and every cell passes the
same formula-lead neutralisation as the member-list export.

## Audit tokens

A read-only principal for the pull API, because handing a security team a
credential that can also edit routing fails their vendor review.

- **Minted by an admin** (`POST /api/audit/tokens`), named, and shown **once**.
  Stored only as a SHA-256 hash plus the last four characters, so it cannot be
  shown again — if it is lost, revoke it and mint another.
- **Recognisable on sight**: every token starts with `srdash_audit_`, so secret
  scanners and push protection catch one that lands in a config repo.
- **Reads the audit log and nothing else, by construction**: the auth gate
  allows a token exactly `GET`/`HEAD` under `/api/audit/`, excluding the
  token-management routes themselves — a token that could mint another token
  would be an escalation dressed as a read. Everything else answers 403.
- **Listed with last-used** (`GET /api/audit/tokens`, admin): name, suffix,
  creator, last use time and address, revocation. Never the hash.
- **Revocable** (`DELETE /api/audit/tokens/:id`, admin) and dead from that
  moment. Removing the admin who created it, or changing them to any other
  role, revokes it too.
- Its **lifecycle is logged** — `apikey.created` / `apikey.deleted` rows name
  the admin and the token — while its heartbeat lives on the row itself. A
  five-minute puller does not get to bury the log in rows that only say it is
  still running.

## Wiring reference

| Piece            | Where                                                    |
| ---------------- | -------------------------------------------------------- |
| Writer + catalog | `packages/db/src/audit.ts`, `packages/shared/src/constants/audit-events.ts` |
| Read + cursor    | `packages/db/src/audit-read.ts`                          |
| Routes           | `apps/api/src/routes/audit.ts`, `routes/audit-tokens.ts` |
| Token principal  | `apps/api/src/plugins/auth.ts` (`auditTokenMayReach`)    |
| Viewer           | `apps/web/src/components/audit/`                         |
| Migrations       | `0004_audit.sql`, `0008_audit_xact.sql`, `0009_audit_tokens.sql` |
