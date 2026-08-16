-- MAG-2770 — the audit log: one append-only table of events, one child table of
-- field changes. See docs/AUDIT.md and MAG-2770 → "What a row holds".
--
-- Hand-written, not drizzle-kit output: the append-only triggers and the
-- retention escape hatch are product decisions a generator has no view on, and
-- the CHECK constraint encodes a stated done-when.

--------------------------------------------------------------------------------
-- Where an event came from, and what kind of thing acted.
--
-- `host` is MAG-2730's recovery commands — run from a shell on the machine, so
-- there is no browser and no session, and the operator's name is the whole
-- attribution.
--------------------------------------------------------------------------------
CREATE TYPE "public"."audit_source" AS ENUM('dashboard', 'system', 'host');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'system', 'host');--> statement-breakpoint

--------------------------------------------------------------------------------
-- audit_events
--
-- Two identifiers, deliberately:
--
--   `seq` is the read cursor. A puller resumes on it, so it must be monotonic
--         and dense — hence bigserial rather than a timestamp, which ties and
--         goes backwards when a clock is corrected.
--   `id`  is the public identifier. MAG-2770 requires it be "stable forever" so
--         a customer's tooling can drop duplicates across re-pulls, and it is a
--         uuid rather than the sequence so the published surface does not leak
--         how many events the deployment has recorded.
--
-- Names are SNAPSHOTS, not joins. `actor_name` and `target_name` record what the
-- thing was called at the time. Resolving them at read time would silently
-- rewrite history on every rename — and MAG-2731 treats renaming a pending
-- object as an attack ("the cheapest way to disguise what an approver is looking
-- at"), so a log that reflects renames is a log that hides the thing it exists
-- to show.
--
-- Nothing here is a foreign key, for the same reason `users.removed_by` and
-- `sessions.revoked_by` are not: the audit row has to outlive whatever it
-- points at. Users are removed as a state change so their rows persist, but
-- sessions are pruned once expired — a FK with ON DELETE SET NULL would quietly
-- blank the session reference on rows that are years old, which is exactly the
-- evidence an incident review is looking for.
--------------------------------------------------------------------------------
CREATE TABLE "audit_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,

	"action" varchar(64) NOT NULL,
	"action_group" varchar(32) NOT NULL,
	"source" "public"."audit_source" NOT NULL,

	"actor_kind" "public"."audit_actor_kind" NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text NOT NULL,
	"actor_email" varchar(255),

	"target_type" varchar(32),
	"target_id" varchar(128),
	"target_name" text,

	"request_id" varchar(64),
	"note" text,

	"ip" "inet",
	"client" varchar(128),
	"session_id" uuid,

	CONSTRAINT "audit_events_id_unique" UNIQUE("id"),
	--------------------------------------------------------------------------
	-- MAG-2770 done-when: "Access events carry the IP, the client and the
	-- session. Config events do not."
	--
	-- A backstop, not the rule. Which events may carry context is decided in
	-- `@sr/shared`'s catalog per event and asserted by the writer; this only
	-- stops a hand-written INSERT from putting an address on a config row.
	--------------------------------------------------------------------------
	CONSTRAINT "audit_events_no_context_on_config" CHECK (
		"action_group" NOT IN ('config', 'approval')
		OR ("ip" IS NULL AND "client" IS NULL AND "session_id" IS NULL)
	)
);--> statement-breakpoint

--------------------------------------------------------------------------------
-- audit_event_changes — one row per field touched.
--
-- A child table rather than a JSONB column because the CSV export is specified
-- as exactly this shape: "one line per changed field, so a change touching three
-- fields becomes three lines sharing the same event id". Storing it nested would
-- mean unrolling it again in the export, the viewer and the API.
--
-- `from_value` and `to_value` are ALREADY REDACTED AND FORMATTED by the writer.
-- There is no un-redacted copy anywhere in this table — that is what makes "no
-- secret or node URL appears as a value in the log, the export, or the API" a
-- property of the schema rather than a rule three read paths have to remember.
--------------------------------------------------------------------------------
CREATE TABLE "audit_event_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_seq" bigint NOT NULL,
	"ord" integer NOT NULL,
	"field" varchar(64) NOT NULL,
	"from_value" text NOT NULL,
	"to_value" text NOT NULL
);--> statement-breakpoint

ALTER TABLE "audit_event_changes" ADD CONSTRAINT "audit_event_changes_event_seq_fk"
	FOREIGN KEY ("event_seq") REFERENCES "public"."audit_events"("seq")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Indexes. Write rate is human-paced — a handful of rows a minute at worst — so
-- the read paths win: the viewer's default ordering, and the four filters the
-- API documents (person, event name, group, object).
--------------------------------------------------------------------------------
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_group_time_idx" ON "audit_events" USING btree ("action_group","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_action_time_idx" ON "audit_events" USING btree ("action","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_actor_time_idx" ON "audit_events" USING btree ("actor_user_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "audit_event_changes_event_idx" ON "audit_event_changes" USING btree ("event_seq","ord");--> statement-breakpoint

--------------------------------------------------------------------------------
-- Append-only.
--
-- MAG-2770: "No user, including an admin, can remove or alter a row through the
-- product." That is a product boundary — there is no UPDATE or DELETE route —
-- and this trigger is what makes it true of the database as well, so a stray
-- service-layer bug cannot rewrite history either. It is deliberately NOT
-- tamper-evidence: someone holding the database credentials can disable a
-- trigger, and hash chaining is not in scope for this ticket.
--
-- The one legitimate writer is retention. The ticket says access events should
-- age out while the viewer says nothing is ever deleted; those describe two
-- different actors, and system ageing is not user deletion. The sweep opens the
-- gate with `SET LOCAL audit.purge = 'on'` inside its own transaction, so the
-- exemption cannot leak into any other statement.
--
-- The guard goes on BOTH tables. In normal operation the parent trigger refuses
-- first and the cascade never reaches the child, so an unguarded child looks
-- correct right up until the first purge — which then aborts on the first event
-- that happens to have a diff.
--------------------------------------------------------------------------------
CREATE FUNCTION "audit_append_only"() RETURNS trigger AS $$
BEGIN
	IF coalesce(current_setting('audit.purge', true), 'off') = 'on' THEN
		-- BEFORE triggers must return OLD to allow a DELETE and NEW to allow an
		-- UPDATE. `coalesce(OLD, NEW)` looks equivalent and is not: on UPDATE it
		-- returns OLD, which silently discards the update instead of applying it.
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'audit rows are append-only (table %, operation %)', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "audit_events_append_only"
	BEFORE UPDATE OR DELETE ON "audit_events"
	FOR EACH ROW EXECUTE FUNCTION "audit_append_only"();--> statement-breakpoint

CREATE TRIGGER "audit_event_changes_append_only"
	BEFORE UPDATE OR DELETE ON "audit_event_changes"
	FOR EACH ROW EXECUTE FUNCTION "audit_append_only"();
