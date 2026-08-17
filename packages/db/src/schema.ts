import { sql } from "drizzle-orm";
import {
  index,
  inet,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Cumulative roles — each includes everything below it, so callers compare
 * ordinals (`roleAtLeast` in `@sr/shared`) rather than expanding a permission
 * matrix. `read_only` sees the dashboard and the audit log; `requester`
 * proposes config changes; `approver` approves others'; `admin` also manages
 * people and may self-approve.
 *
 * `requester` / `approver` are enforced by the config-approval flow (MAG-2731);
 * this package only defines the vocabulary and the ordering.
 */
export const userRoleEnum = pgEnum("user_role", [
  "read_only",
  "requester",
  "approver",
  "admin",
]);

/**
 * Account state. Replaces the old `is_suspended` boolean — two overlapping
 * "can this person sign in" concepts is a bug factory.
 *
 *  - `active`    — normal.
 *  - `suspended` — can't sign in; reversible.
 *  - `removed`   — the person left. **A state change, not a row deletion**: their
 *                  sessions die immediately, their name stays in the audit log
 *                  permanently, and the partial unique index below frees their
 *                  email so it can be invited again under a new account.
 */
export const userStatusEnum = pgEnum("user_status", ["active", "suspended", "removed"]);

/**
 * users — the canonical account record for AUTH_MODE=enabled. Identity plus
 * lifecycle: email + bcrypt hash for credentials sign-in, one nullable
 * provider-id column per supported OAuth provider, role, status, and the two
 * timestamps the member list reads.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §4.1.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    /** Display name. Pulled from the OAuth profile, the invite, or the seed. */
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
    role: userRoleEnum("role").notNull().default("read_only"),
    status: userStatusEnum("status").notNull().default("active"),
    /** Who removed this person and when. Set together with `status='removed'`;
     *  `removed_by` is intentionally not a foreign key so the record survives
     *  the remover's own removal. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    /** Last time the password was set (by the holder — an admin never sets
     *  someone else's). Displayed on the account page; drives nothing, because
     *  there is deliberately no forced expiry. */
    passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
    /** Newest `sessions.last_seen_at` across the person's sessions, denormalised
     *  so the member list is one query. Written at most once a minute per
     *  session — see `services/sessions.ts`. */
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
    /** Bulk revocation cutoff: any JWT with `iat` at or before this is refused.
     *  Stamped on password change/reset, sign-out-everywhere, and removal.
     *
     *  This coexists with `sessions.revoked_at` deliberately — the cutoff kills
     *  every outstanding token in one write without enumerating rows, while a
     *  session row is what makes per-device revoke and the sessions list
     *  possible. Neither replaces the other (design §5.3). */
    signedOutAllAt: timestamp("signed_out_all_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (table) => [
    /** Functional unique index on `lower(email)`, **scoped to active accounts**.
     *  Unconditional would make "a removed person's email can be invited again"
     *  impossible; case-variant duplicates still can't coexist among the living
     *  even if a code path forgets to normalize. */
    uniqueIndex("users_email_lower_idx")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.status} = 'active'`),
  ],
);

/**
 * sessions — one row per sign-in. The session id travels in the JWT's `sid`
 * claim and the api resolves this row on every authenticated request, which is
 * what makes revocation immediate rather than "at next sign-in".
 *
 * Rows are **not** deleted on revoke: a revoked session is evidence, and
 * MAG-2770's access events reference it. Expired rows are pruned on a schedule.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §4.2 and §5.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Heartbeat, throttled to one write per minute per session. Feeds
     *  `users.last_active_at` and the "last active" column. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** 30 days from creation. No idle timeout — people use this dashboard all
     *  day and shouldn't be retyping passwords. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Null when the holder revoked it themselves or the system did. */
    revokedBy: uuid("revoked_by"),
    /** `self` · `sign_out_all` · `password_change` · `member_removed` · `admin`.
     *  A varchar rather than an enum so later slices can add reasons without a
     *  migration; the closed set lives in `services/sessions.ts`. */
    revokedReason: varchar("revoked_reason", { length: 32 }),
    /** The browser's address, not the web pod's — see design §5.2. */
    ip: inet("ip"),
    userAgent: text("user_agent"),
    /** Parsed once at creation ("Chrome 141 / macOS"), never on read: this is
     *  what the audit log records, and it must not shift if the parser changes. */
    client: varchar("client", { length: 128 }),
    /** `password` · `google` · `github` · `discord` · `invite`. */
    authMethod: varchar("auth_method", { length: 32 }).notNull(),
  },
  (table) => [
    /** The hot path: "this user's live sessions". */
    index("sessions_user_active_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
    /** For the prune job. */
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

/**
 * invitations — the only way an account comes into existence, apart from
 * first-run setup.
 *
 * The raw token exists **only inside the link**; the row stores its SHA-256, so
 * a database read can't be turned into a working invitation. Single-use is a
 * conditional UPDATE rather than a read-then-write (see `services/invitations.ts`),
 * and the redemption runs in one transaction with the account insert — a crash
 * between them can't leave a redeemed invite with no account, or an account
 * with a still-live invite.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §4.3 and §6.2.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercased. The account is created with **this** address, never
     *  the one the redeemer submits — that is what makes "redeemable only by
     *  the address it was sent to" structural rather than a check someone can
     *  forget to write. */
    email: varchar("email", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull(),
    /** SHA-256 of the raw token. */
    tokenHash: text("token_hash").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Managed 7 days · on-prem 24 hours, where the link travels over a channel
     *  we don't control. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedUserId: uuid("redeemed_user_id"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    /** Stamped the first time an expired invite is observed, so `invite.expired`
     *  fires exactly once without needing a sweeper to notice. */
    expiredNotedAt: timestamp("expired_noted_at", { withTimezone: true }),
    resendCount: integer("resend_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_idx").on(table.tokenHash),
    /** "is this address already invited?" — the pending set only. */
    index("invitations_pending_email_idx")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.redeemedAt} is null and ${table.revokedAt} is null`),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;

/**
 * password_resets — a single-use link that lets someone set their own password.
 *
 * `created_by` is the column an auditor looks for: null means the holder asked
 * for it themselves (managed, "forgot password"), set means an admin generated
 * it (on-prem, where there is no mail server). An admin generating a *link* is
 * the whole design — **nobody ever sets somebody else's password**, so an admin
 * cannot take an account over silently.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the raw token; the raw value exists only in the link. */
    tokenHash: text("token_hash").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Managed 1 hour · on-prem 24 hours. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("password_resets_token_hash_idx").on(table.tokenHash),
    index("password_resets_user_idx").on(table.userId),
  ],
);

export type PasswordReset = typeof passwordResets.$inferSelect;

/**
 * login_attempts — per-account sign-in lockout.
 *
 * The per-IP limit is not the control that matters: a distributed attacker
 * rotating addresses walks straight past it. This counts failures against the
 * *identity* being targeted, so the wall is in front of the account rather than
 * in front of one network path.
 *
 * Keyed on the submitted address whether or not it exists, so being locked out
 * reveals nothing about whether an account is there.
 */
export const loginAttempts = pgTable("login_attempts", {
  email: varchar("email", { length: 255 }).primaryKey(),
  failedCount: integer("failed_count").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export type LoginAttempt = typeof loginAttempts.$inferSelect;

/** MAG-2770 audit log — kept in its own module, re-exported so
 *  `import * as schema` still sees every table. */
export * from "./schema-audit.js";
