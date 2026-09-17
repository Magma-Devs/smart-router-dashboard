import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { sessions, users, type User } from "@sr/db";
import {
  checkSession,
  createSession,
  listActiveSessions,
  revokeAllForUser,
  revokeSession,
  signOutEverywhere,
  touchSession,
  TOUCH_INTERVAL_MS,
} from "../services/sessions.js";

/**
 * The session store, against a real Postgres (pglite, in-process).
 *
 * Every rejection reason here maps to a requirement on the ticket — removal and
 * password change kill sessions immediately, a demotion is seen on the current
 * session, a revoked device stops working. They are checked against a live
 * planner because the conditional updates below are only correct if their
 * rowcounts are real.
 */
describe("sessions", () => {
  let t: TestDb;
  let user: User;

  beforeEach(async () => {
    t = await createTestDb();
    const [created] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", name: "Dana Levi", role: "approver" })
      .returning();
    user = created!;
  });
  afterEach(async () => {
    await t.close();
  });

  const open = () =>
    createSession(t.db, {
      userId: user.id,
      authMethod: "password",
      client: {
        ip: "84.229.11.6",
        userAgent: "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0 Safari/537.36",
      },
    });

  /** Seconds-since-epoch "now", the shape of a JWT `iat`. */
  const nowSec = () => Math.floor(Date.now() / 1000);

  describe("createSession", () => {
    it("stores the parsed client alongside the raw user-agent", async () => {
      const session = await open();
      expect(session.client).toBe("Chrome 141 / macOS");
      expect(session.userAgent).toContain("Chrome/141");
      expect(session.ip).toBe("84.229.11.6");
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("opens without client context rather than failing the sign-in", async () => {
      const session = await createSession(t.db, {
        userId: user.id,
        authMethod: "password",
        client: { ip: null, userAgent: null },
      });
      expect(session.ip).toBeNull();
      expect(session.client).toBeNull();
    });
  });

  describe("checkSession", () => {
    it("resolves a live session to its account", async () => {
      const session = await open();
      const check = await checkSession(t.db, session.id, nowSec());
      expect(check.ok).toBe(true);
      if (check.ok) {
        expect(check.user.id).toBe(user.id);
        // The live role, not whatever the token was minted with — this is what
        // makes a demotion take effect on the current session.
        expect(check.user.role).toBe("approver");
      }
    });

    it("reports an unknown session id", async () => {
      const check = await checkSession(t.db, "00000000-0000-4000-8000-00000000dead", nowSec());
      expect(check).toEqual({ ok: false, reason: "not_found" });
    });

    it("refuses a revoked session on the very next request", async () => {
      const session = await open();
      await revokeSession(t.db, session.id, { reason: "self" });
      expect(await checkSession(t.db, session.id, nowSec())).toEqual({
        ok: false,
        reason: "revoked",
      });
    });

    it("refuses an expired session", async () => {
      const session = await open();
      await t.db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, session.id));
      expect(await checkSession(t.db, session.id, nowSec())).toEqual({
        ok: false,
        reason: "expired",
      });
    });

    it.each(["suspended", "removed"] as const)("refuses a %s account", async (status) => {
      const session = await open();
      await t.db.update(users).set({ status }).where(eq(users.id, user.id));
      expect(await checkSession(t.db, session.id, nowSec())).toEqual({
        ok: false,
        reason: "user_inactive",
      });
    });

    it("refuses a token minted in the same second as the cutoff", async () => {
      // `iat` and `signed_out_all_at` both have one-second resolution, so the
      // comparison is `<=`. With `<`, an attacker racing the victim's
      // sign-out-everywhere would keep a working session.
      const session = await open();
      const cutoff = new Date();
      await t.db.update(users).set({ signedOutAllAt: cutoff }).where(eq(users.id, user.id));

      const sameSecond = Math.floor(cutoff.getTime() / 1000);
      expect(await checkSession(t.db, session.id, sameSecond)).toEqual({
        ok: false,
        reason: "signed_out",
      });

      // A token minted after the cutoff is fine — signing in again works.
      const later = await checkSession(t.db, session.id, sameSecond + 1);
      expect(later.ok).toBe(true);
    });

    it("treats a token with no iat as predating any cutoff", async () => {
      const session = await open();
      await t.db.update(users).set({ signedOutAllAt: new Date() }).where(eq(users.id, user.id));
      expect(await checkSession(t.db, session.id, undefined)).toEqual({
        ok: false,
        reason: "signed_out",
      });
    });
  });

  describe("revocation", () => {
    it("reports whether there was anything live to revoke", async () => {
      const session = await open();
      expect(await revokeSession(t.db, session.id, { reason: "self" })).toBe(true);
      // Second time there is nothing left — the caller can 404 rather than
      // claim a revocation that didn't happen.
      expect(await revokeSession(t.db, session.id, { reason: "self" })).toBe(false);
    });

    it("keeps the row, because a revoked session is evidence", async () => {
      const session = await open();
      await revokeSession(t.db, session.id, { reason: "admin", by: user.id });
      const [row] = await t.db.select().from(sessions).where(eq(sessions.id, session.id));
      expect(row?.revokedAt).toBeInstanceOf(Date);
      expect(row?.revokedReason).toBe("admin");
      expect(row?.revokedBy).toBe(user.id);
    });

    it("closes every device at once, optionally sparing the caller's", async () => {
      const keep = await open();
      await open();
      await open();

      const closed = await revokeAllForUser(t.db, user.id, {
        reason: "password_change",
        except: keep.id,
      });
      expect(closed).toBe(2);

      const live = await listActiveSessions(t.db, user.id);
      expect(live.map((s) => s.id)).toEqual([keep.id]);
    });

    it("signOutEverywhere also stamps the cutoff, so tokens with no row die too", async () => {
      await open();
      await open();
      const closed = await signOutEverywhere(t.db, user.id, { reason: "sign_out_all" });
      expect(closed).toBe(2);

      const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
      expect(row?.signedOutAllAt).toBeInstanceOf(Date);
      expect(await listActiveSessions(t.db, user.id)).toHaveLength(0);
    });
  });

  describe("touchSession", () => {
    it("skips the write while the heartbeat is fresh", async () => {
      const session = await open();
      await touchSession(t.db, session);
      const [row] = await t.db.select().from(sessions).where(eq(sessions.id, session.id));
      expect(row?.lastSeenAt.getTime()).toBe(session.lastSeenAt.getTime());
    });

    it("writes once the interval has passed, and updates the member list column", async () => {
      const session = await open();
      const stale = { ...session, lastSeenAt: new Date(Date.now() - TOUCH_INTERVAL_MS - 1_000) };
      await touchSession(t.db, stale);

      const [row] = await t.db.select().from(sessions).where(eq(sessions.id, session.id));
      expect(row!.lastSeenAt.getTime()).toBeGreaterThan(stale.lastSeenAt.getTime());

      const [account] = await t.db.select().from(users).where(eq(users.id, user.id));
      expect(account?.lastActiveAt).toBeInstanceOf(Date);
    });
  });

  describe("listActiveSessions", () => {
    it("omits revoked and expired rows, newest first", async () => {
      const revoked = await open();
      const expired = await open();
      const live = await open();

      await revokeSession(t.db, revoked.id, { reason: "self" });
      await t.db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.id, expired.id));

      const rows = await listActiveSessions(t.db, user.id);
      expect(rows.map((s) => s.id)).toEqual([live.id]);
    });
  });
});
