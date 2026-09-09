import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { sessions, users, type User } from "@sr/db";
import { parseArgs, runRecovery } from "../recover.js";
import { createSession } from "../services/sessions.js";
import { issueChallenge, consumeChallenge, resetTotpKeyForTests } from "../services/two-factor.js";

/**
 * Recovery from the host — MAG-2730's "when nobody can get in".
 *
 * The commands themselves are thin; what these pin is the part that makes them
 * worth having over a `psql` prompt: every one of them leaves a `host.recovery`
 * row naming the command and the operator, and none of them sets anybody's
 * password.
 */

let t: TestDb;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  t = await createTestDb();
  resetTotpKeyForTests();
  setEnv({ TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") });
});

afterEach(async () => {
  await t.close();
  resetTotpKeyForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

let seq = 0;
async function seedUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const [created] = await t.db
    .insert(users)
    .values({
      email: `dana+${++seq}@example.com`,
      name: "Dana Levi",
      role: "read_only",
      passwordHash: "$2a$12$notarealhash",
      ...overrides,
    })
    .returning();
  return created!;
}

async function auditRows() {
  const rows = await t.db.execute<{
    action: string;
    action_group: string;
    source: string;
    actor_kind: string;
    actor_name: string;
    note: string | null;
    ip: string | null;
    client: string | null;
    session_id: string | null;
  }>(
    sql`select action, action_group, source, actor_kind, actor_name, note,
               ip::text, client, session_id::text
          from audit_events order by occurred_at`,
  );
  return rows.rows;
}

const ONPREM = { mode: "onprem" as const, webOrigin: "https://dash.example.com" };

describe("parseArgs", () => {
  it("reads a command and an address", () => {
    expect(parseArgs(["reset-2fa", "--email", "a@b.c"])).toEqual({
      command: "reset-2fa",
      email: "a@b.c",
      by: undefined,
    });
  });

  it("takes an explicit operator", () => {
    expect(parseArgs(["promote-admin", "--email", "a@b.c", "--by", "victoria"])).toMatchObject({
      by: "victoria",
    });
  });

  it("refuses what it does not understand rather than guessing", () => {
    expect(parseArgs([])).toEqual({ error: "No command given." });
    expect(parseArgs(["delete-everything", "--email", "a@b.c"])).toEqual({
      error: "Unknown command: delete-everything",
    });
    expect(parseArgs(["reset-2fa"])).toEqual({ error: "--email is required." });
    expect(parseArgs(["reset-2fa", "--user", "a@b.c"])).toEqual({
      error: "Unknown option: --user",
    });
  });
});

describe("reset-2fa", () => {
  it("destroys the secret, kills the sessions, and retires a challenge in flight", async () => {
    const user = await seedUser(enrolledTwoFactor());
    const session = await createSession(t.db, {
      userId: user.id,
      authMethod: "password+totp",
      client: { ip: "84.229.11.6", userAgent: "Chrome/141" },
    });
    const stale = await issueChallenge(t.db, user.id);

    const out = await runRecovery(
      t.db,
      { command: "reset-2fa", email: user.email, by: "victoria" },
      ONPREM,
    );
    expect(out.message).toContain(user.email);

    const after = (await t.db.select().from(users).where(eq(users.id, user.id)))[0]!;
    expect(after.totpSecret).toBeNull();
    expect(after.totpEnrolledAt).toBeNull();
    expect(after.totpLastStep).toBeNull();
    expect(await consumeChallenge(t.db, stale.token)).toEqual({ ok: false, reason: "used" });

    const live = (await t.db.select().from(sessions).where(eq(sessions.id, session.id)))[0]!;
    expect(live.revokedAt).not.toBeNull();
  });

  it("says so rather than pretending, when there is nothing to reset", async () => {
    const user = await seedUser();
    await expect(
      runRecovery(t.db, { command: "reset-2fa", email: user.email }, ONPREM),
    ).rejects.toThrow(/no authenticator/i);
  });
});

describe("reset-password", () => {
  it("prints a link and does not set a password", async () => {
    const user = await seedUser();
    const before = (await t.db.select().from(users).where(eq(users.id, user.id)))[0]!.passwordHash;

    const out = await runRecovery(t.db, { command: "reset-password", email: user.email }, ONPREM);
    expect(out.message).toContain("https://dash.example.com/reset/");

    // The whole rule, in one assertion: nobody ever sets somebody else's
    // password. An admin — or an operator with root — generates a link; the
    // account holder chooses the value.
    const after = (await t.db.select().from(users).where(eq(users.id, user.id)))[0]!;
    expect(after.passwordHash).toBe(before);
  });

  it("refuses rather than printing a link to a host it guessed", async () => {
    const user = await seedUser();
    await expect(
      runRecovery(t.db, { command: "reset-password", email: user.email }, { mode: "onprem" }),
    ).rejects.toThrow(/PUBLIC_WEB_ORIGIN/);
  });
});

describe("promote-admin", () => {
  it("promotes, and reactivates a suspended account with it", async () => {
    // The commonest way to reach "no admin is left" is the last one being
    // suspended, so a promotion that fixed the role and left them unable to
    // sign in would not fix the problem.
    const user = await seedUser({ role: "requester", status: "suspended" });

    await runRecovery(t.db, { command: "promote-admin", email: user.email }, ONPREM);

    const after = (await t.db.select().from(users).where(eq(users.id, user.id)))[0]!;
    expect(after.role).toBe("admin");
    expect(after.status).toBe("active");
  });

  it("does nothing when the account is already an active admin", async () => {
    const user = await seedUser({ role: "admin" });
    await expect(
      runRecovery(t.db, { command: "promote-admin", email: user.email }, ONPREM),
    ).rejects.toThrow(/already an active admin/);
  });
});

describe("the audit row", () => {
  it("names the command and the operator, and carries no browser context", async () => {
    const user = await seedUser(enrolledTwoFactor());
    await runRecovery(t.db, { command: "reset-2fa", email: user.email, by: "victoria" }, ONPREM);

    const [row] = await auditRows();
    expect(row).toMatchObject({
      action: "host.recovery",
      action_group: "recovery",
      source: "host",
      actor_kind: "host",
      actor_name: "victoria",
    });
    expect(row!.note).toContain("reset-2fa");
    expect(row!.note).toContain(user.email);
    // There is no browser, so there is nothing to record. The catalog marks
    // host.recovery as carrying no access context and a CHECK constraint backs
    // it up; this is the assertion that the CLI agrees.
    expect(row!.ip).toBeNull();
    expect(row!.client).toBeNull();
    expect(row!.session_id).toBeNull();
  });

  it("says the attribution is what the shell reported, not who it proved", async () => {
    const user = await seedUser();
    await runRecovery(
      t.db,
      { command: "reset-password", email: user.email, by: "victoria" },
      ONPREM,
    );
    const [row] = await auditRows();
    // Nothing here authenticates anybody. The row must not read as if it did.
    expect(row!.note).toContain("not an authenticated identity");
  });

  it("marks a managed deployment's recovery as Magma's", async () => {
    const user = await seedUser();
    await runRecovery(
      t.db,
      { command: "promote-admin", email: user.email, by: "victoria" },
      { mode: "managed", webOrigin: "https://dash.example.com" },
    );
    const [row] = await auditRows();
    // On a deployment we host, shell access is ours by definition — and the
    // customer's own log has to say so.
    expect(row!.actor_name).toBe("Magma Devs (victoria)");
  });

  it("writes one row per command, and nothing when the command fails", async () => {
    const user = await seedUser();
    await expect(
      runRecovery(t.db, { command: "reset-2fa", email: user.email }, ONPREM),
    ).rejects.toThrow();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("finding the account", () => {
  it("sees a suspended account — recovery is for when the state is already wrong", async () => {
    const user = await seedUser({ status: "suspended" });
    const out = await runRecovery(t.db, { command: "promote-admin", email: user.email }, ONPREM);
    expect(out.message).toContain("active again");
  });

  it("refuses a removed one with a reason, not with 'no such address'", async () => {
    const user = await seedUser({ status: "removed" });
    await expect(
      runRecovery(t.db, { command: "promote-admin", email: user.email }, ONPREM),
    ).rejects.toThrow(/invite the address again/);
  });

  it("says plainly when there is no such account", async () => {
    await expect(
      runRecovery(t.db, { command: "reset-2fa", email: "nobody@example.com" }, ONPREM),
    ).rejects.toThrow(/No account for nobody@example.com/);
  });

  it("matches the address case-insensitively", async () => {
    const user = await seedUser({ email: "Dana.Levi@Example.com" });
    const out = await runRecovery(
      t.db,
      { command: "promote-admin", email: "dana.levi@example.com" },
      ONPREM,
    );
    expect(out.message).toContain(user.email);
  });
});
