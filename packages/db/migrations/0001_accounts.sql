-- MAG-2729 slice 1 — named users: the four cumulative roles, account state,
-- and the session store. See docs/ACCOUNTS-DESIGN.md §4.
--
-- Hand-written, not drizzle-kit output. `ALTER TYPE … ADD VALUE` can't be used
-- in the transaction that adds it and Drizzle runs each file in one, so the role
-- change is a rename-create-swap; and the existing-row remap below is a product
-- decision (design §16.1), not something a generator should pick.

--------------------------------------------------------------------------------
-- Roles: admin|member  ->  read_only|requester|approver|admin
--
-- REMAP: `admin` stays admin. Everything else becomes `read_only` — least
-- privilege, and promoting is one click where over-granting is not. The chart
-- never sets AUTH_MODE, so live deployments run the default (disabled) with no
-- users table at all; in practice this remap is expected to touch zero rows.
--------------------------------------------------------------------------------
ALTER TYPE "public"."user_role" RENAME TO "user_role_old";--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('read_only', 'requester', 'approver', 'admin');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" TYPE "public"."user_role" USING (
  CASE "role"::text WHEN 'admin' THEN 'admin' ELSE 'read_only' END
)::"public"."user_role";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'read_only';--> statement-breakpoint
DROP TYPE "public"."user_role_old";--> statement-breakpoint

--------------------------------------------------------------------------------
-- Account state: is_suspended (bool) -> status (enum)
-- Removal becomes a state, so a person's history and audit rows survive them.
--------------------------------------------------------------------------------
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'removed');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "public"."user_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
UPDATE "users" SET "status" = 'suspended' WHERE "is_suspended" = true;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_suspended";--> statement-breakpoint

ALTER TABLE "users" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint

--------------------------------------------------------------------------------
-- Email uniqueness applies to living accounts only, so a removed person's
-- address can be invited again under a new account.
--------------------------------------------------------------------------------
DROP INDEX "users_email_lower_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email")) WHERE "status" = 'active';--> statement-breakpoint

--------------------------------------------------------------------------------
-- Sessions. Rows are never deleted on revoke — a revoked session is evidence,
-- and MAG-2770's access events reference it.
--------------------------------------------------------------------------------
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoked_reason" varchar(32),
	"ip" "inet",
	"user_agent" text,
	"client" varchar(128),
	"auth_method" varchar(32) NOT NULL
);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
