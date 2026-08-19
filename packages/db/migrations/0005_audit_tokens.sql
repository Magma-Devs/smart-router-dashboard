-- MAG-2770 — read-only tokens for the audit pull API.
--
-- DFNS's fourth vendor requirement is "API key best practices", and the ticket
-- is blunt about why this exists: "handing a security team a token that also
-- edits routing fails that review". So this is a principal that can read the
-- audit log and nothing else — not a user, not a role, not a session.
--
-- Tag numbered 0005 rather than 0003 on purpose: MAG-2729's slices already hold
-- 0003 and 0004 on a branch this one does not contain, and drizzle keys
-- migrations by tag rather than by the journal's `idx`, so distinct names are
-- what keeps the two stacks from colliding when they merge.

--------------------------------------------------------------------------------
-- Deliberately NOT append-only: unlike the log itself this table is mutable
-- state — `last_used_at` moves on every pull and `revoked_at` is the whole
-- point. The `audit_append_only()` trigger must never be attached here.
--
-- Nothing is a foreign key, matching the log: `created_by` has to survive the
-- creator's own removal, or a token outlives the only record of who minted it.
--------------------------------------------------------------------------------
CREATE TABLE "audit_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,

	-- SHA-256 of the token, hex. Not bcrypt: the secret is 32 bytes from a CSPRNG,
	-- so there is no dictionary to slow down and no user-chosen entropy to
	-- protect — and this hash is computed on every request to the pull API, where
	-- a deliberate 100ms would be a self-inflicted rate limit.
	"token_hash" char(64) NOT NULL,
	-- Last four characters of the secret, so a listing can say *which* token
	-- without being able to reconstruct one.
	"suffix" varchar(8) NOT NULL,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	-- Snapshotted for the same reason the log snapshots names.
	"created_by_name" text NOT NULL,

	-- "listed with last-used", from the ticket. Written on every successful
	-- pull; see `audit-tokens.ts` for why this is a column rather than an event.
	"last_used_at" timestamp with time zone,
	"last_used_ip" "inet",

	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_by_name" text,

	CONSTRAINT "audit_tokens_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint

-- The hot path: resolve a presented token. Unique index above already serves it;
-- this one is for the listing, newest first.
CREATE INDEX "audit_tokens_created_at_idx" ON "audit_tokens" USING btree ("created_at" DESC);
