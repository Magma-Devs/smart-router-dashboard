-- MAG-2729 slice 3 — invitations. See docs/ACCOUNTS-DESIGN.md §4.3.
--
-- MAG-2770's audit tables are developed in parallel and were holding 0002.
-- They cannot: drizzle applies a migration only when its journal `when` beats
-- the highest already recorded, so a lane that lands second with an equal or
-- earlier timestamp is skipped in silence. Slices are numbered in the order
-- they merge, and the audit lane renumbers -- file AND `when` -- when it lands.

CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"role" "user_role" NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"expired_noted_at" timestamp with time zone,
	"resend_count" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash_idx" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitations_pending_email_idx" ON "invitations" USING btree (lower("email")) WHERE "redeemed_at" is null and "revoked_at" is null;
