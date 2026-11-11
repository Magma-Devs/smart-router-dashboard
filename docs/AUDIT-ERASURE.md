# Erasing audit rows — the runbook

MAG-4444. The audit log is append-only, and the dashboard cannot remove or
alter a row of it: with a runtime role (see
[`DATABASE-ROLES.md`](DATABASE-ROLES.md)) its database role holds only
`SELECT` and `INSERT` on the two audit tables. Two things still have to be
possible, and both are this procedure — run by hand, by an Owner, with the
database **owner's** credential:

- **Retention.** The security record — the `access` group, and any other
  group agreed with the customer — ages out after the agreed period; `config`
  and `approval` are the compliance record and are kept.
- **Erasure.** A person's request to have their details removed. The events
  stay — the record that *something* happened is not theirs to erase — and
  the details that identify them are redacted.

Nothing else is a reason to run it. A row that is wrong, embarrassing or
noisy stays.

## What it touches

| Table | Retention | Erasure |
|---|---|---|
| `audit_events` | deletes the matching events | redacts `actor_name`, `actor_email`, `ip`, `client`, `target_name` and the address inside `note`, on the person's events |
| `audit_event_changes` | its rows go with their event (`ON DELETE CASCADE`) | redacts `from_value` / `to_value` that carry the person's address |
| `users`, `sessions`, … | untouched | untouched — removing the account itself is the team page's job, and anonymising its row is a separate change |

Both tables carry the `audit_append_only` trigger, which refuses `UPDATE` and
`DELETE` unless the transaction has said `SET LOCAL audit.purge = 'on'`. The
owner may set it and holds `DELETE` and `UPDATE`; the runtime role may set it
and holds neither, so for the backend the setting changes nothing.

## How it is recorded

Every run writes one `audit.erased` row **in the same transaction** as the
rows it removes or redacts — the statements below delete (or update) and
insert in one statement, so neither exists without the other. The row is
`source = host`, in the `recovery` group, names the Owner who ran it in
`actor_name`, and carries in `note` the request reference and the count —
**never** the erased person's address. It shows in the customer's own
**Audit log** page and pull API like any other event; `audit.erased` is in
the published catalog (`GET /api/audit/catalog`).

Outside the database, the change ticket carries who asked, on what basis,
the exact scope, the counts the run printed and the `seq` of its
`audit.erased` row.

## Before you start

1. **A change ticket** naming the request: for retention, the agreed period;
   for erasure, the customer's written request and the person's account id
   (and address).
2. **The owner's credential** — the role `DATABASE_URL` names (on a
   deployment with two roles, *not* `DATABASE_RUNTIME_URL`'s, which cannot do
   this). On a managed deployment: open the database tunnel and connect as the
   tenant's owner role with `sslmode=verify-full`. On a compose install:
   `docker compose exec postgres psql -U sr sr_dashboard`.
3. **Backups.** Dumps taken before the run still hold what it removes, until
   they age out. Say so in the ticket; for an erasure request, say when the
   last dump holding the details expires.

Set the run's values once, in `psql`, so every statement below reads them.
A `\set` line takes no trailing comment — `psql` would append the comment to
the value — so each is explained above it:

```sql
-- Who is running this, and the change ticket.
\set operator 'Full Name (Magma Devs)'
\set reference 'CHANGE-1234'
```

## Retention: delete events older than a cutoff

```sql
-- Events recorded before the cutoff go, in the groups listed (a Postgres array).
\set cutoff '2026-01-01T00:00:00Z'
\set groups '{access}'

BEGIN;
SET LOCAL audit.purge = 'on';

-- Preview: what is about to go, per group. Stop (ROLLBACK) if it is not what
-- the ticket says.
SELECT action_group, count(*) AS events, min(occurred_at), max(occurred_at)
  FROM audit_events
 WHERE action_group = ANY (:'groups'::text[]) AND occurred_at < :'cutoff'::timestamptz
 GROUP BY 1;

-- Delete, and record the deletion, in one statement.
WITH gone AS (
  DELETE FROM audit_events
   WHERE action_group = ANY (:'groups'::text[]) AND occurred_at < :'cutoff'::timestamptz
  RETURNING 1
)
INSERT INTO audit_events (action, action_group, source, actor_kind, actor_name, target_type, note)
SELECT 'audit.erased', 'recovery', 'host', 'host', :'operator', 'audit_log',
       format('retention: %s event(s) in %s recorded before %s deleted (%s)',
              count(*), array_to_string(:'groups'::text[], ', '), :'cutoff', :'reference')
  FROM gone
RETURNING seq, note;

COMMIT;
```

`audit.erased` itself is in `recovery`, so a retention run over the access
groups never deletes an earlier run's record.

## Erasure: redact one person

```sql
-- Their users.id, and their address.
\set subject_id '00000000-0000-0000-0000-000000000000'
\set subject_email 'person@example.com'

BEGIN;
SET LOCAL audit.purge = 'on';

-- The address as a case-insensitive pattern that matches it whole: a dot in
-- it matches only a dot, and it never matches inside a longer address.
SELECT '(?i)(?<![[:alnum:]._%+-])'
       || regexp_replace(:'subject_email', '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
       || '(?![[:alnum:]._-])' AS pattern \gset

-- Which events are theirs, and how. Every statement below reads this.
CREATE TEMP TABLE subject ON COMMIT DROP AS
SELECT seq,
       coalesce(actor_user_id = :'subject_id'::uuid OR lower(actor_email) = lower(:'subject_email'), false) AS actor,
       coalesce(target_id = :'subject_id' OR lower(target_name) = lower(:'subject_email'), false) AS target,
       coalesce(note ~ :'pattern', false) AS in_note
  FROM audit_events;

-- Preview.
SELECT count(*) FILTER (WHERE actor) AS as_actor, count(*) FILTER (WHERE target) AS as_target,
       count(*) FILTER (WHERE in_note) AS in_note
  FROM subject;
SELECT count(*) AS changes FROM audit_event_changes
 WHERE from_value ~ :'pattern' OR to_value ~ :'pattern';

-- Redact, and record the redaction, in one statement. One UPDATE per table:
-- Postgres applies a single update per row per statement, so the columns are
-- decided together rather than by separate updates of the same rows.
WITH events AS (
  UPDATE audit_events e
     SET actor_name  = CASE WHEN s.actor THEN '(erased)' ELSE e.actor_name END,
         actor_email = CASE WHEN s.actor THEN NULL ELSE e.actor_email END,
         ip          = CASE WHEN s.actor THEN NULL ELSE e.ip END,
         client      = CASE WHEN s.actor THEN NULL ELSE e.client END,
         target_name = CASE WHEN s.target THEN '(erased)' ELSE e.target_name END,
         note        = CASE WHEN s.in_note THEN regexp_replace(e.note, :'pattern', '(erased)', 'g') ELSE e.note END
    FROM subject s
   WHERE s.seq = e.seq AND (s.actor OR s.target OR s.in_note)
  RETURNING e.seq
), changes AS (
  UPDATE audit_event_changes
     SET from_value = regexp_replace(from_value, :'pattern', '(erased)', 'g'),
         to_value   = regexp_replace(to_value,   :'pattern', '(erased)', 'g')
   WHERE from_value ~ :'pattern' OR to_value ~ :'pattern'
  RETURNING id
)
INSERT INTO audit_events (action, action_group, source, actor_kind, actor_name, target_type, note)
SELECT 'audit.erased', 'recovery', 'host', 'host', :'operator', 'audit_log',
       format('erasure: one person''s details redacted in %s event(s) and %s field change(s) (%s)',
              (SELECT count(*) FROM events), (SELECT count(*) FROM changes), :'reference')
RETURNING seq, note;

COMMIT;
```

The account id stays on the rows (`actor_user_id`, `target_id`): it is an
opaque identifier, and once the details are gone it is what keeps "the same
person did these three things" answerable without saying who.

## Verify

As the owner, after `COMMIT`:

```sql
-- 1. Nothing the run should have removed is left: rerun its preview. Every
--    count is 0.

-- 2. The record is there, once.
SELECT seq, occurred_at, actor_name, note
  FROM audit_events WHERE action = 'audit.erased' ORDER BY seq DESC LIMIT 1;

-- 3. The hatch closed with the transaction: this must fail with
--    "audit rows are append-only".
BEGIN;
DELETE FROM audit_events WHERE seq = (SELECT max(seq) FROM audit_events);
ROLLBACK;
```

Then put the counts and the record's `seq` in the ticket. A customer's
scheduled puller is unaffected: the cursor is a position, not a row, and a
page simply no longer holds what was deleted.

## What not to do

- **`SET audit.purge = 'on'` without `LOCAL`.** It stays on for the rest of
  the session, and every later statement in it may rewrite the log.
- **Run it as the runtime role.** It cannot — `permission denied` — and that
  is the point of the role.
- **Drop or disable the trigger** "for the duration". The hatch exists so the
  guard never has to come down.
- **`TRUNCATE`.** Row triggers do not fire on it, and it leaves no count to
  record.
