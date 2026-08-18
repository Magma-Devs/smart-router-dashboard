import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { maybeSeedAdmin } from "../plugins/db.js";
import {
  completeSetup,
  countActiveUsers,
  needsSetup,
  resetSetupTokenForTests,
  resolveSetupToken,
  setupTokenMatches,
} from "../services/setup.js";

const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

const quietLog = { warn: () => {}, error: () => {} };

describe("the setup token", () => {
  beforeEach(() => resetSetupTokenForTests());
  afterEach(() => {
    resetSetupTokenForTests();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses SETUP_TOKEN when the chart supplies one", () => {
    setEnv({ SETUP_TOKEN: "from-the-helm-secret", SETUP_TOKEN_FILE: undefined });
    expect(resolveSetupToken(quietLog)).toBe("from-the-helm-secret");
  });

  it("generates one when nothing is configured, rather than disabling setup", () => {
    // An operator who forgot to configure a token should still be able to
    // finish the install — from a value only log or filesystem access reveals.
    setEnv({ SETUP_TOKEN: undefined, SETUP_TOKEN_FILE: undefined });
    const token = resolveSetupToken(quietLog);
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("is stable for the life of the process", () => {
    setEnv({ SETUP_TOKEN: undefined, SETUP_TOKEN_FILE: undefined });
    expect(resolveSetupToken(quietLog)).toBe(resolveSetupToken(quietLog));
  });

  it("writes a generated token to SETUP_TOKEN_FILE, owner-only", () => {
    const file = join(mkdtempSync(join(tmpdir(), "sr-setup-")), "token");
    setEnv({ SETUP_TOKEN: undefined, SETUP_TOKEN_FILE: file });

    const token = resolveSetupToken(quietLog);
    expect(readFileSync(file, "utf8").trim()).toBe(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("still yields a token when the file can't be written", () => {
    // A bad mount path must not be the reason an install can't be completed.
    setEnv({ SETUP_TOKEN: undefined, SETUP_TOKEN_FILE: "/nope/definitely/not/writable" });
    expect(resolveSetupToken(quietLog)).toBeTruthy();
  });
});

describe("setupTokenMatches", () => {
  it("accepts the right token and rejects everything else", () => {
    expect(setupTokenMatches("abc123", "abc123")).toBe(true);
    expect(setupTokenMatches("abc124", "abc123")).toBe(false);
    // Different lengths must not throw — timingSafeEqual requires equal buffers.
    expect(setupTokenMatches("", "abc123")).toBe(false);
    expect(setupTokenMatches("abc123extra", "abc123")).toBe(false);
  });
});

describe("first-run state", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("a fresh install needs setting up", async () => {
    expect(await needsSetup(t.db)).toBe(true);
  });

  it("stops needing it once there is an active account", async () => {
    await t.db.insert(users).values({ email: "admin@example.com", role: "admin" });
    expect(await needsSetup(t.db)).toBe(false);
  });

  it("is derived from the table, not a flag — so a restored backup opens again", async () => {
    // The reason this is a count rather than a one-time marker: a deployment
    // restored from a backup taken before its first account would carry the
    // marker and refuse to open, permanently. The token is what protects the
    // window that this leaves.
    const [u] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", role: "admin" })
      .returning();
    expect(await needsSetup(t.db)).toBe(false);

    await t.db.execute(`delete from users where id = '${u!.id}'`);
    expect(await needsSetup(t.db)).toBe(true);
  });

  it("does not count suspended or removed accounts as able to sign in", async () => {
    await t.db.insert(users).values({ email: "gone@example.com", status: "removed" });
    await t.db.insert(users).values({ email: "paused@example.com", status: "suspended" });
    expect(await countActiveUsers(t.db)).toBe(0);
    expect(await needsSetup(t.db)).toBe(true);
  });
});

describe("completeSetup", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("creates an admin who can sign in", async () => {
    const outcome = await completeSetup(t.db, {
      email: "Dana@Example.com",
      password: "correct horse battery staple",
      name: "Dana Levi",
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.user.role).toBe("admin");
    expect(outcome.user.status).toBe("active");
    expect(outcome.user.email).toBe("dana@example.com");
    expect(outcome.user.passwordHash).toBeTruthy();
    expect(outcome.user.passwordUpdatedAt).toBeInstanceOf(Date);
  });

  it("never hashes the password into the row in the clear", async () => {
    const password = "correct horse battery staple";
    const outcome = await completeSetup(t.db, { email: "a@example.com", password });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.user.passwordHash).not.toContain(password);
    expect(outcome.user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("refuses a second run — the check inside the transaction is the real one", async () => {
    // pglite is single-connection, so this exercises the in-transaction
    // re-check rather than true concurrency. The advisory lock around it is
    // what makes the same check hold when two processes race; that part is not
    // observable here, only in a multi-connection Postgres.
    const first = await completeSetup(t.db, { email: "one@example.com", password: "x".repeat(12) });
    expect(first.ok).toBe(true);

    const second = await completeSetup(t.db, {
      email: "two@example.com",
      password: "y".repeat(12),
    });
    expect(second).toEqual({ ok: false, reason: "already_set_up" });

    const rows = await t.db.select().from(users);
    expect(rows).toHaveLength(1);
  });

  it("re-opens for a deployment whose accounts are all removed", async () => {
    await t.db
      .insert(users)
      .values({ email: "gone@example.com", status: "removed", role: "admin" });
    const outcome = await completeSetup(t.db, {
      email: "new@example.com",
      password: "correct horse battery staple",
    });
    expect(outcome.ok).toBe(true);

    // The removed row survives — their name stays in the audit trail.
    const rows = await t.db.select().from(users).where(eq(users.status, "removed"));
    expect(rows).toHaveLength(1);
  });
});

describe("the ADMIN_EMAIL seed", () => {
  /**
   * The seed does three things the ticket forbids: creates the first admin with
   * no setup token, sets a password for somebody, and leaves a standing admin
   * account in a customer's deployment. It survives for development only, so
   * the production guard is the whole feature — and a guard with no test is a
   * guard that comes back.
   */
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };
  const log = { info: () => {}, warn: () => {} };
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
    process.env.ADMIN_EMAIL = "seeded@example.com";
    process.env.ADMIN_PASSWORD = "a-seeded-password-1";
  });
  afterEach(async () => {
    await t.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("does nothing in production, leaving /setup as the only way in", async () => {
    process.env.NODE_ENV = "production";
    await maybeSeedAdmin({ log } as never, t.db);

    expect(await countActiveUsers(t.db)).toBe(0);
    expect(await needsSetup(t.db)).toBe(true);
  });

  it("still seeds outside production, so `make dev-auth` keeps working", async () => {
    process.env.NODE_ENV = "development";
    await maybeSeedAdmin({ log } as never, t.db);

    expect(await needsSetup(t.db)).toBe(false);
    const [seeded] = await t.db.select().from(users).where(eq(users.email, "seeded@example.com"));
    expect(seeded?.role).toBe("admin");
  });

  it("is inert when the variables are unset, in either environment", async () => {
    delete process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_PASSWORD;
    process.env.NODE_ENV = "development";
    await maybeSeedAdmin({ log } as never, t.db);

    expect(await needsSetup(t.db)).toBe(true);
  });
});
