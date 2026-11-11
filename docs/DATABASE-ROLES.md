# Database roles: owner and runtime

MAG-4444. `AUTH_MODE=enabled` only — without accounts there is no database.

The audit log's append-only trigger stops a stray `UPDATE` or `DELETE`, and
nothing more: any role holding `DELETE` on the table opens the retention hatch
with `SET LOCAL audit.purge = 'on'` (a custom setting every role may set), and
the table's owner can drop the trigger. So how hard the log is to alter from the
api is decided by the privileges of the role the api serves requests as. With
one credential that role owns every table. With two, it owns nothing and may
only read and append to the log.

## The two shapes

| | One role (default) | Two roles |
|---|---|---|
| Configure | `DATABASE_URL` | `DATABASE_URL` (owner) + `DATABASE_RUNTIME_URL` (runtime) |
| Migrations run as | `DATABASE_URL`'s role, on connect | `DATABASE_URL`'s role, on connect, over one connection that is closed once the boot is done |
| Requests are served as | `DATABASE_URL`'s role | `DATABASE_RUNTIME_URL`'s role, over the `DB_POOL_MAX` pool |
| The audit log, from the api | the trigger refuses; the owner's privileges would not | `UPDATE`, `DELETE`, `TRUNCATE`, the trigger and the table are out of reach |
| Who uses it | every compose install, every deployment until its second credential exists | the managed fleet |

Both shapes keep the same contract: **migrations run on connect, retried until
the database answers**, and `/auth/*` answers 503 until they have. Nothing
runs before the pods roll; there is no separate migration job to schedule.

`DATABASE_URL` names the owner in both shapes on purpose. An image older than
`DATABASE_RUNTIME_URL` ignores it, so a rollback past this release on a
deployment that already has two credentials serves as the owner, exactly as it
did before. Had the runtime credential taken over `DATABASE_URL`, that image
would try to migrate as a role that may not create the migrator's schema
(`permission denied for database`), and never become ready.

## What the runtime role holds

Granted by the api itself, as the owner, right after every migration run
(`grantRuntimeRole` in `packages/db/src/runtime-role.ts`):

| Object | Privileges |
|---|---|
| every table in `public` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `audit_events`, `audit_event_changes` | `SELECT`, `INSERT` only |
| every sequence in `public` | `USAGE` |
| schema `public` | `USAGE` |

Nothing else: no `TRUNCATE`, `REFERENCES` or `TRIGGER` on anything, no
`UPDATE` or `DELETE` on an audit table, no `CREATE`, and no ownership.
`audit_tokens` is not an audit table — a token's last use and its revocation
are updates. The `drizzle` schema, where the migrator keeps its history, is
the owner's alone.

**Why the api grants, not provisioning.** A later migration adds tables, and the
runtime role cannot touch a table nobody granted it. `ALTER DEFAULT PRIVILEGES`
at provisioning would cover new tables — and hand `DELETE` to any audit table a
later migration adds, with the exception kept in a repository that does not
know which tables those are. The grant pass runs after every migration run,
knows the audit tables (they are defined beside it), and **converges**: it
revokes everything the role holds in `public` first, so a privilege granted by
hand is taken away again on the next boot. It holds an advisory lock, so
backends booting together do not trip over each other's `GRANT`s, and runs in
one transaction.

## What the api refuses

After granting, the pass reads the result back from the catalog. If the
runtime role could still alter the log, or lacks what the api needs, the
attempt fails like any other connect failure: nothing is granted, both pools
are closed, the reason is logged at `error`, the backend stays unready, and the
loop retries — so a role fixed out of band is picked up without a restart.
Refused:

- the same role as `DATABASE_URL`'s;
- a superuser, or a role that can become one;
- a role that is, or can become (`SET ROLE`, or membership), the owner of an
  audit table — the owner may drop the trigger;
- a role that is, or can become, the owner of schema `public` — a schema's
  owner may drop any table in it, and **on Postgres 15 and later the database's
  owner owns `public`**, so the runtime role must not own the database;
- a role that holds, or can reach through another role, `UPDATE`, `DELETE`,
  `TRUNCATE`, `REFERENCES` or `TRIGGER` on an audit table;
- any table in `public` the migration role does not own (it cannot grant on
  it).

## Provisioning the runtime role yourself

The managed fleet's provisioning creates both roles. On a self-hosted Postgres,
as a superuser or the database's owner:

```sql
-- The owner: what DATABASE_URL signs in as. It owns the database.
CREATE ROLE sr_owner LOGIN PASSWORD '…';
CREATE DATABASE sr_dashboard OWNER sr_owner;

-- The runtime role: what DATABASE_RUNTIME_URL signs in as. It owns nothing and
-- is a member of nothing; the api grants its table privileges.
CREATE ROLE sr_app LOGIN NOINHERIT PASSWORD '…';
GRANT CONNECT ON DATABASE sr_dashboard TO sr_app;
```

On an existing database the owner is whichever role ran the migrations so far:
point `DATABASE_URL` at it, create the runtime role, set
`DATABASE_RUNTIME_URL`, restart. The compose stacks keep one role — their
bundled Postgres's `sr` is a superuser, so there is nothing to separate from —
and pass `DATABASE_RUNTIME_URL` through for an install pointed at its own
Postgres.

## Connections

The owner holds one connection per backend while it boots, and none after. The
runtime role holds the `DB_POOL_MAX` pool. A role's connection limit is sized
for what it holds: during a rollout a node briefly runs two backends.

## The host recovery commands

`recover` (`apps/api/src/recover.ts`) connects with `DATABASE_RUNTIME_URL` when
it is set: everything a recovery does — update an account, end its sessions,
issue a reset link, append its `host.recovery` row — the runtime role may do,
and nothing it does needs to alter the log.
