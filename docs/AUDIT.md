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
  IP address, client and session it came from.
- `audit_event_changes` — for events that record a change, one row per field:
  `field`, `from`, `to`. Values are redacted at write time; no secret or node
  URL is ever stored.

Both tables are **append-only, enforced in the database**: a trigger refuses
`UPDATE` and `DELETE` for every principal, admins included. There is no way to
alter or remove a row through the product. (Operators with database access have
a retention escape hatch — `set local audit.purge = 'on'` inside a transaction
— which exists for data-retention law and for nothing else.)

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
say — not just the rows already on screen.

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
| `after`       | The `cursor` from the previous response                        |

The envelope is `{ items, cursor, has_more }`. A scheduled puller stores
`cursor` and sends it back as `after` on the next run:

```sh
TOKEN=srdash_audit_…            # minted by an admin over the API, shown once
CURSOR_FILE=.audit-cursor
after=$(cat "$CURSOR_FILE" 2>/dev/null)
page=$(curl -sf -H "Authorization: Bearer $TOKEN" \
  "https://dash.example.com/api/audit/events?per_page=500${after:+&after=$after}")
jq -c '.items[]' <<<"$page" >> events.ndjson
jq -r '.cursor // empty' <<<"$page" > "$CURSOR_FILE"
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
- A misspelled `action` or `group`, a malformed `actor`, an unparseable time
  and a cursor this endpoint did not issue are all **400**, never an empty page.
- Changing `per_page` mid-pull is fine; it is not part of the cursor.

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
target_type,target_id,target_name,request,note,field,from,to
```

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
  moment.
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
