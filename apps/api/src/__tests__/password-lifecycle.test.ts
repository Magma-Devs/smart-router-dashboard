import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { passwordResets, sessions, users, type User } from "@sr/db";
import {
  RESET_TTL_MS,
  changeOwnPassword,
  consumePasswordReset,
  createPasswordReset,
} from "../services/password-reset.js";
import {
  LOCKOUT_MAX_FAILURES,
  checkLock,
  clearFailures,
  recordFailure,
} from "../services/lockout.js";
import { createSession, listActiveSessions } from "../services/sessions.js";
import { hashPassword, verifyPassword } from "../services/password.js";

describe("password reset", () => {
  let t: TestDb;
  let user: User;

  beforeEach(async () => {
    t = await createTestDb();
    const [created] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", passwordHash: await hashPassword("the-old-one-1234") })
      .returning();
    user = created!;
  });
  afterEach(async () => {
    await t.close();
  });

  const openSession = () =>
    createSession(t.db, {
      userId: user.id,
      authMethod: "password",
      client: { ip: "10.0.0.1", userAgent: null },
    });

  it("stores only the hash of the link's token", async () => {
    const created = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    const [row] = await t.db.select().from(passwordResets);
    expect(row?.tokenHash).not.toContain(created.rawToken);
  });

  it("gives an on-prem link longer, because a person carries it", async () => {
    const managed = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    const onprem = await createPasswordReset(t.db, { userId: user.id, mode: "onprem" });
    expect(onprem.expiresAt.getTime()).toBeGreaterThan(managed.expiresAt.getTime());
    expect(managed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(RESET_TTL_MS.managed);
  });

  it("records who started it — null for self-serve, set for an admin", async () => {
    await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    const [selfServe] = await t.db.select().from(passwordResets);
    expect(selfServe?.createdBy).toBeNull();

    await createPasswordReset(t.db, { userId: user.id, mode: "onprem", createdBy: user.id });
    const rows = await t.db.select().from(passwordResets);
    expect(rows.some((r) => r.createdBy === user.id)).toBe(true);
  });

  it("invalidates an earlier unused link, so asking twice leaves one way in", async () => {
    const first = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    await createPasswordReset(t.db, { userId: user.id, mode: "managed" });

    expect(await consumePasswordReset(t.db, first.rawToken, "a-brand-new-passphrase")).toEqual({
      ok: false,
      reason: "used",
    });
  });

  it("sets the password and kills every session", async () => {
    // The whole point: a reset is what you do when you think you're
    // compromised. Leaving the attacker's session alive would defeat it.
    await openSession();
    await openSession();
    const created = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });

    const outcome = await consumePasswordReset(t.db, created.rawToken, "a-brand-new-passphrase");
    expect(outcome.ok).toBe(true);

    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(await verifyPassword("a-brand-new-passphrase", row!.passwordHash!)).toBe(true);
    expect(await verifyPassword("the-old-one-1234", row!.passwordHash!)).toBe(false);
    expect(row?.signedOutAllAt).toBeInstanceOf(Date);
    expect(await listActiveSessions(t.db, user.id)).toHaveLength(0);
  });

  it("is single-use", async () => {
    const created = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    expect((await consumePasswordReset(t.db, created.rawToken, "a-brand-new-passphrase")).ok).toBe(true);
    expect(await consumePasswordReset(t.db, created.rawToken, "another-passphrase-here")).toEqual({
      ok: false,
      reason: "used",
    });
  });

  it("refuses an expired link", async () => {
    const created = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    await t.db.update(passwordResets).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await consumePasswordReset(t.db, created.rawToken, "a-brand-new-passphrase")).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a link for an account that has since been removed", async () => {
    const created = await createPasswordReset(t.db, { userId: user.id, mode: "managed" });
    await t.db.update(users).set({ status: "removed" }).where(eq(users.id, user.id));
    expect(await consumePasswordReset(t.db, created.rawToken, "a-brand-new-passphrase")).toEqual({
      ok: false,
      reason: "user_inactive",
    });
  });

  it("does not resolve a token that was never issued", async () => {
    expect(await consumePasswordReset(t.db, "invented", "a-brand-new-passphrase")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});

describe("changing your own password", () => {
  let t: TestDb;
  let user: User;

  beforeEach(async () => {
    t = await createTestDb();
    const [created] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", passwordHash: await hashPassword("the-old-one-1234") })
      .returning();
    user = created!;
  });
  afterEach(async () => {
    await t.close();
  });

  it("keeps the tab you're in and signs out the rest", async () => {
    // Logging someone out of the window they just used is hostile; logging out
    // the other devices is the security value.
    const mine = await createSession(t.db, {
      userId: user.id,
      authMethod: "password",
      client: { ip: null, userAgent: null },
    });
    await createSession(t.db, { userId: user.id, authMethod: "password", client: { ip: null, userAgent: null } });
    await createSession(t.db, { userId: user.id, authMethod: "password", client: { ip: null, userAgent: null } });

    await changeOwnPassword(t.db, user.id, "a-brand-new-passphrase", mine.id);

    const live = await listActiveSessions(t.db, user.id);
    expect(live.map((s) => s.id)).toEqual([mine.id]);
  });

  it("does not stamp the bulk cutoff, which would kill the surviving session too", async () => {
    const mine = await createSession(t.db, {
      userId: user.id,
      authMethod: "password",
      client: { ip: null, userAgent: null },
    });
    await changeOwnPassword(t.db, user.id, "a-brand-new-passphrase", mine.id);

    const [row] = await t.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.signedOutAllAt).toBeNull();
    expect(row?.passwordUpdatedAt).toBeInstanceOf(Date);
  });
});

describe("per-account lockout", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("locks after the threshold and says when it lifts", async () => {
    for (let i = 1; i < LOCKOUT_MAX_FAILURES; i++) {
      expect((await recordFailure(t.db, "dana@example.com")).locked, `attempt ${i}`).toBe(false);
    }
    const tripped = await recordFailure(t.db, "dana@example.com");
    expect(tripped.locked).toBe(true);
    expect(tripped.until).toBeInstanceOf(Date);

    expect((await checkLock(t.db, "dana@example.com")).locked).toBe(true);
  });

  it("counts an address that has no account, so lockout leaks nothing", async () => {
    // If only real addresses locked, the lockout itself would answer "is this
    // person a member?" — the exact question sign-in refuses to answer.
    for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) {
      await recordFailure(t.db, "nobody@example.com");
    }
    expect((await checkLock(t.db, "nobody@example.com")).locked).toBe(true);
  });

  it("is case-insensitive, so varying the capitals doesn't reset the count", async () => {
    for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) {
      await recordFailure(t.db, "dana@example.com");
    }
    expect((await recordFailure(t.db, "DANA@Example.com")).locked).toBe(true);
  });

  it("clears on a successful sign-in", async () => {
    await recordFailure(t.db, "dana@example.com");
    await recordFailure(t.db, "dana@example.com");
    await clearFailures(t.db, "dana@example.com");

    // Back to a clean slate, not one slip from a lockout for the rest of the
    // window.
    for (let i = 1; i < LOCKOUT_MAX_FAILURES; i++) {
      expect((await recordFailure(t.db, "dana@example.com")).locked).toBe(false);
    }
  });

  it("reports an untouched address as unlocked", async () => {
    expect(await checkLock(t.db, "stranger@example.com")).toEqual({ locked: false, until: null });
  });
});
