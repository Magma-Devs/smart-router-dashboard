import { sql } from "drizzle-orm";
import {
  boolean,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Role for future admin surfaces. `admin` is the seeded operator account;
 * `member` is everyone else. The dashboard has no per-role UI yet — the
 * enum exists so adding one later is a code change, not a migration.
 */
export const userRoleEnum = pgEnum("user_role", ["admin", "member"]);

/**
 * users — the canonical user record for AUTH_MODE=enabled. Identity only:
 * email + bcrypt password hash for credentials sign-in, and one nullable
 * provider-id column per supported OAuth provider (Google / GitHub /
 * Discord). Ported from lava-connect's users table, minus everything the
 * dashboard doesn't have (plans, billing, account states, notifications).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    /** Display name. Pulled from the OAuth profile or the seed. */
    name: varchar("name", { length: 255 }),
    /** Profile avatar URL, captured from the first linked OAuth provider
     *  that supplies one. Backfill-only: once set it is never overwritten. */
    avatarUrl: text("avatar_url"),
    /** bcrypt hash (cost 12). Null for OAuth-only accounts. */
    passwordHash: text("password_hash"),
    /** Google `sub` claim — null for accounts that haven't linked Google. */
    googleId: varchar("google_id", { length: 255 }).unique(),
    /** GitHub user id (numeric, stored as string). */
    githubId: varchar("github_id", { length: 255 }).unique(),
    /** Discord user id (snowflake). */
    discordId: varchar("discord_id", { length: 255 }).unique(),
    role: userRoleEnum("role").notNull().default("member"),
    /** Suspended users can't sign in. */
    isSuspended: boolean("is_suspended").notNull().default(false),
    /** Cutoff timestamp for session revocation. RESERVED — no api check
     *  reads it yet (lava-connect's requireAuthFresh pattern would reject
     *  JWTs with `iat` at or before this). Until that lands, force-expire
     *  every session by rotating AUTH_SECRET. See docs/AUTH.md → "Session
     *  lifetime & revocation". */
    signedOutAllAt: timestamp("signed_out_all_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (table) => [
    /** Functional unique index on `lower(email)` so case-variant duplicates
     *  can never coexist even if a code path forgets to normalize. */
    uniqueIndex("users_email_lower_idx").on(sql`lower(${table.email})`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
