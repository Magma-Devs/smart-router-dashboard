-- MAG-2730 — two-factor login (TOTP).
--
-- Hand-written, not drizzle-kit output: the backfill decisions below are
-- product choices, not something a generator should pick.

--------------------------------------------------------------------------------
-- The enrolled secret, and the replay guard.
--
-- `totp_secret` holds an AES-256-GCM envelope (base64: iv | tag | ciphertext),
-- never the secret itself — "encrypted at rest, never logged, never returned by
-- any API after setup" is a stated requirement. The key is TOTP_ENCRYPTION_KEY
-- and is deliberately NOT derived from AUTH_SECRET: rotating the session signing
-- key would otherwise invalidate every enrolled authenticator at once, turning a
-- routine rotation into a fleet-wide lockout.
--
-- `totp_last_step` is the TOTP counter (unix seconds / 30) of the last code this
-- account spent. It is what makes "a used code cannot be reused, even within its
-- 30-second window" true: without it the ±1-step tolerance IS a 90-second replay
-- window. bigint because the counter is unbounded; it is ~58 million today.
--------------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;--> statement-breakpoint

--------------------------------------------------------------------------------
-- The grace period's two inputs.
--
-- Neither can be derived from what already exists, and each near-miss is worth
-- naming because all three look plausible:
--
--   `last_sign_in_at`   is overwritten on every sign-in, so it answers "when did
--                       they last sign in", never "when did the clock start".
--   `is_magma_account`  is only ever written under DEPLOYMENT_MODE=managed, so
--                       on-prem — the mode this grace period exists for — it is
--                       false for the very account it would have to identify.
--   the `setup.completed` audit row
--                       would work, and must not be used: a permission-adjacent
--                       check reading the audit log makes the log load-bearing
--                       for access decisions, which is not what it is for.
--
-- So: `created_by_setup` is written once by completeSetup(), and
-- `first_signin_at` once by the first successful sign-in. The grace period is
-- `created_by_setup AND first_signin_at + 30 days`, and it ends early the moment
-- that admin tries to invite somebody.
--
-- BACKFILL: both stay null/false, following 0005_magma_account.sql's reasoning.
-- The chart never sets AUTH_MODE and configures no database, so no deployment
-- runs the account system today and there is no first admin to grandfather. If
-- one existed, false is the safe direction to be wrong in: it means "enrol at
-- your next sign-in" — sixty seconds with a phone — rather than handing the
-- highest-privilege account in the system another thirty days unprotected.
--------------------------------------------------------------------------------
ALTER TABLE "users" ADD COLUMN "created_by_setup" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "first_signin_at" timestamp with time zone;--> statement-breakpoint

--------------------------------------------------------------------------------
-- two_factor_challenges — the ticket between the two sign-in screens.
--
-- Shaped deliberately like `password_resets`: 32 random bytes, base64url in the
-- response, SHA-256 in the row, single-use by conditional UPDATE. It is NOT a
-- JWT and is NOT signed with AUTH_SECRET, for the same reason invite and reset
-- tokens are not (design §7.4) — a `kind`-confusion bug in a signed token would
-- become "this reset link is also a session".
--
-- Its existence is the architecture: password verification returns one of these
-- and NO session row. A session appears only once a code has been checked, so a
-- half-authenticated session cannot exist to be mistakenly honoured — the api
-- already refuses any token whose `sid` resolves to nothing.
--------------------------------------------------------------------------------
CREATE TABLE "two_factor_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "two_factor_challenges" ADD CONSTRAINT "two_factor_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "two_factor_challenges_token_hash_idx" ON "two_factor_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "two_factor_challenges_user_idx" ON "two_factor_challenges" USING btree ("user_id");
