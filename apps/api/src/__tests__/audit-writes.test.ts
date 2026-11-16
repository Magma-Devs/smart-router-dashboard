import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import {
  auditTokens,
  invitations,
  loginAttempts,
  mintAuditToken,
  passwordResets,
  sessions,
  users,
  type User,
} from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetSetupTokenForTests } from "../services/setup.js";
import { createPasswordReset } from "../services/password-reset.js";
import { createInvitation } from "../services/invitations.js";
import { LOCKOUT_MAX_FAILURES } from "../services/lockout.js";

/**
 * What the audit log records about access and about the people who grant it,
 * and that the rows a takeover would need to be missing land in the same
 * transaction as the change they record.
 *
 * A failing write is injected with a trigger that refuses one action, so each
 * test fails one row and watches what happens to the change around it.
 */

const oauth = vi.hoisted(() => ({
  email: "stranger@example.com" as string | null,
  providerId: "google-subject-1",
  verifies: true,
}));
vi.mock("../services/oauth.js", () => ({
  verifyOAuthToken: async () => {
    if (!oauth.verifies) throw new Error("token rejected by the provider");
    return { providerId: oauth.providerId, email: oauth.email, name: null, avatarUrl: null };
  },
}));

const SECRET = "test-secret-for-auth-tests-32-chars!";
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const PASSWORD = "thistle-cobalt-marina-7781";
const NEW_PASSWORD = "an-entirely-new-passphrase";

let app: FastifyInstance | null = null;
let t: TestDb;
/** Catalog violations other than a failed write, which some tests cause on purpose. */
let violations: unknown[] = [];
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
  resetSetupTokenForTests();
  oauth.email = "stranger@example.com";
  oauth.providerId = "google-subject-1";
  oauth.verifies = true;
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    INTERNAL_AUTH_SECRET: "internal-secret-for-tests",
    DATABASE_URL: DEAD_DB,
    DEPLOYMENT_MODE: "onprem",
    PUBLIC_WEB_ORIGIN: "http://localhost:3000",
    PASSWORD_BREACH_CHECK: "off",
  });
  app = await buildApp();
  app.db = t.db;

  violations = [];
  const realError = app.log.error.bind(app.log);
  app.log.error = ((obj: unknown, msg?: string) => {
    const reason = (obj as { audit?: { reason?: string } } | null)?.audit?.reason;
    if (
      typeof msg === "string" &&
      msg.includes("violated the catalog") &&
      reason !== "write-failed"
    ) {
      violations.push(obj);
    }
    return realError(obj as never, msg as never);
  }) as typeof app.log.error;
});

afterEach(async () => {
  expect(violations, "emissions must match the catalog").toEqual([]);
  // The shared database is truncated between tests, not rebuilt, so a trigger
  // would outlive the test that made it.
  await t.db.execute(sql`drop trigger if exists test_refuse_audit on audit_events`);
  await t.db.execute(sql`drop function if exists test_refuse_audit()`);
  await app?.close();
  app = null;
  await t.close();
  resetSetupTokenForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Every later insert of `action` into the log fails. */
async function refuseAuditRows(action: string): Promise<void> {
  await t.db.execute(
    sql.raw(`create or replace function test_refuse_audit() returns trigger as $$
      begin
        if new.action = '${action}' then raise exception 'audit log unavailable'; end if;
        return new;
      end $$ language plpgsql`),
  );
  await t.db.execute(
    sql`create trigger test_refuse_audit before insert on audit_events
          for each row execute function test_refuse_audit()`,
  );
}

async function person(
  email: string,
  opts: { role?: User["role"]; name?: string; password?: boolean; status?: User["status"] } = {},
): Promise<User> {
  const [row] = await t.db
    .insert(users)
    .values({
      ...enrolledTwoFactor(),
      email,
      name: opts.name ?? null,
      role: opts.role ?? "read_only",
      status: opts.status ?? "active",
      passwordHash: opts.password === false ? null : await hashPassword(PASSWORD),
    })
    .returning();
  return row!;
}

async function bearer(user: User): Promise<{ token: string; sessionId: string }> {
  const session = await createSession(t.db, {
    userId: user.id,
    authMethod: "password",
    client: { ip: null, userAgent: null },
  });
  const token = await new SignJWT({
    sub: user.id,
    email: user.email,
    role: user.role,
    sid: session.id,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { token, sessionId: session.id };
}

interface Row {
  action: string;
  actor_user_id: string | null;
  actor_name: string;
  actor_email: string | null;
  target_type: string | null;
  target_id: string | null;
  note: string | null;
  session_id: string | null;
  occurred_at: Date;
}

async function rows(action: string): Promise<Row[]> {
  const res = await t.db.execute<Row>(
    sql`select action, actor_user_id, actor_name, actor_email, target_type, target_id, note,
               session_id, occurred_at
          from audit_events where action = ${action} order by seq`,
  );
  return res.rows;
}

describe("rows that land with the change they record", () => {
  it("issues no reset link when its row cannot be written", async () => {
    const admin = await person("admin@example.com", { role: "admin" });
    const dana = await person("dana@example.com");
    await refuseAuditRows("password.reset_link_generated");

    const res = await app!.inject({
      method: "POST",
      url: `/api/team/members/${dana.id}/reset-link`,
      headers: { authorization: `Bearer ${(await bearer(admin)).token}` },
    });

    expect(res.statusCode).toBe(500);
    expect(await t.db.select().from(passwordResets)).toEqual([]);
  });

  it("resets nothing when the reset's row cannot be written", async () => {
    const dana = await person("dana@example.com");
    const { sessionId } = await bearer(dana);
    const link = await createPasswordReset(t.db, { userId: dana.id, mode: "onprem" });
    await refuseAuditRows("password.reset_completed");

    const res = await app!.inject({
      method: "POST",
      url: "/auth/password/reset",
      payload: { token: link.rawToken, password: NEW_PASSWORD },
    });

    expect(res.statusCode).toBe(500);
    const [after] = await t.db.select().from(users).where(eq(users.id, dana.id));
    expect(await bcrypt.compare(PASSWORD, after!.passwordHash!)).toBe(true);
    const [reset] = await t.db.select().from(passwordResets);
    expect(reset?.usedAt).toBeNull();
    const [session] = await t.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(session?.revokedAt).toBeNull();
  });

  it("creates no account when the redemption's row cannot be written", async () => {
    const admin = await person("admin@example.com", { role: "admin" });
    const created = await createInvitation(t.db, {
      email: "new@example.com",
      role: "approver",
      createdBy: admin.id,
      mode: "onprem",
    });
    if (!created.ok) throw new Error(created.reason);
    await refuseAuditRows("invite.redeemed");

    const accept = () =>
      app!.inject({
        method: "POST",
        url: "/auth/invite/accept",
        payload: { token: created.created.rawToken, password: PASSWORD },
      });
    expect((await accept()).statusCode).toBe(500);
    expect(await t.db.select().from(users).where(eq(users.email, "new@example.com"))).toEqual([]);
    const [invite] = await t.db.select().from(invitations);
    expect(invite?.redeemedAt).toBeNull();

    // The link is still good once the log is.
    await t.db.execute(sql`drop trigger test_refuse_audit on audit_events`);
    expect((await accept()).statusCode).toBe(201);
    expect(await rows("invite.redeemed")).toHaveLength(1);
  });

  it("does not answer a refused sign-in until its row is written, and still counts it", async () => {
    await person("dana@example.com");
    await refuseAuditRows("signin.failed");

    const res = await app!.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: "dana@example.com", password: "not the password" },
    });

    expect(res.statusCode).toBe(500);
    const [attempts] = await t.db.select().from(loginAttempts);
    expect(attempts?.failedCount).toBe(1);
  });

  it("writes a lockout's row in the transaction that counted the attempt", async () => {
    await person("dana@example.com");
    const attempt = () =>
      app!.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: "dana@example.com", password: "not the password" },
      });
    for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) await attempt();
    await refuseAuditRows("signin.blocked");

    expect((await attempt()).statusCode).toBe(500);
    const [attempts] = await t.db.select().from(loginAttempts);
    expect(attempts?.failedCount).toBe(LOCKOUT_MAX_FAILURES);
  });
});

describe("removing or demoting an admin revokes what they handed out", () => {
  /** Bea is the admin who goes; Ada is the one acting. */
  async function beaHandsThingsOut() {
    const ada = await person("ada@example.com", { role: "admin", name: "Ada" });
    const bea = await person("bea@example.com", { role: "admin", name: "Bea" });
    const carl = await person("carl@example.com");

    const invite = await createInvitation(t.db, {
      email: "new@example.com",
      role: "approver",
      createdBy: bea.id,
      mode: "onprem",
    });
    if (!invite.ok) throw new Error(invite.reason);
    const link = await createPasswordReset(t.db, {
      userId: carl.id,
      mode: "onprem",
      createdBy: bea.id,
    });
    const token = await mintAuditToken(t.db, {
      name: "SIEM pull",
      createdBy: bea.id,
      createdByName: "Bea",
    });
    // Ada's own token stays: only what Bea created goes.
    const adasToken = await mintAuditToken(t.db, {
      name: "Ada's",
      createdBy: ada.id,
      createdByName: "Ada",
    });

    return {
      ada,
      bea,
      carl,
      invite: invite.created,
      link,
      token: token.row,
      adasToken: adasToken.row,
    };
  }

  async function assertRevoked(
    s: Awaited<ReturnType<typeof beaHandsThingsOut>>,
    note: string,
  ): Promise<void> {
    const [invite] = await t.db
      .select()
      .from(invitations)
      .where(eq(invitations.id, s.invite.invitation.id));
    expect(invite?.revokedAt).not.toBeNull();
    expect(invite?.revokedBy).toBe(s.ada.id);
    const preview = await app!.inject({
      method: "POST",
      url: "/auth/password/reset/preview",
      payload: { token: s.link.rawToken },
    });
    expect(preview.statusCode).toBe(410);
    const [token] = await t.db.select().from(auditTokens).where(eq(auditTokens.id, s.token.id));
    expect(token?.revokedAt).not.toBeNull();
    expect(token?.revokedBy).toBe(s.ada.id);
    expect(token?.revokedByName).toBe("Ada");
    const [adas] = await t.db.select().from(auditTokens).where(eq(auditTokens.id, s.adasToken.id));
    expect(adas?.revokedAt).toBeNull();

    expect(
      (await rows("invite.revoked")).map((r) => [r.actor_user_id, r.target_id, r.note]),
    ).toEqual([[s.ada.id, s.invite.invitation.id, note]]);
    expect(
      (await rows("password.reset_link_revoked")).map((r) => [
        r.actor_user_id,
        r.target_id,
        r.note,
      ]),
    ).toEqual([[s.ada.id, s.carl.id, note]]);
    expect(
      (await rows("apikey.deleted")).map((r) => [
        r.actor_user_id,
        r.target_type,
        r.target_id,
        r.note,
      ]),
    ).toEqual([[s.ada.id, "audit_token", s.token.id, note]]);
  }

  it("on removal", async () => {
    const s = await beaHandsThingsOut();
    const res = await app!.inject({
      method: "DELETE",
      url: `/api/team/members/${s.bea.id}`,
      headers: { authorization: `Bearer ${(await bearer(s.ada)).token}` },
    });
    expect(res.statusCode).toBe(200);
    await assertRevoked(s, "created by Bea, who was removed");
  });

  it("on a demotion below admin", async () => {
    const s = await beaHandsThingsOut();
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/team/members/${s.bea.id}`,
      headers: { authorization: `Bearer ${(await bearer(s.ada)).token}` },
      payload: { role: "approver" },
    });
    expect(res.statusCode).toBe(200);
    await assertRevoked(s, "created by Bea, who is no longer an admin");
  });

  it("not on a promotion, or a change between other roles", async () => {
    const s = await beaHandsThingsOut();
    // Carl is no admin, but holds a token from when he was one.
    const carls = await mintAuditToken(t.db, {
      name: "Carl's",
      createdBy: s.carl.id,
      createdByName: "Carl",
    });
    const auth = { authorization: `Bearer ${(await bearer(s.ada)).token}` };
    for (const role of ["approver", "admin"]) {
      const res = await app!.inject({
        method: "PATCH",
        url: `/api/team/members/${s.carl.id}`,
        headers: auth,
        payload: { role },
      });
      expect(res.statusCode).toBe(200);
    }

    const [token] = await t.db.select().from(auditTokens).where(eq(auditTokens.id, carls.row.id));
    expect(token?.revokedAt).toBeNull();
    expect(await rows("apikey.deleted")).toEqual([]);
  });

  it("removes nobody when a revocation's row cannot be written", async () => {
    const s = await beaHandsThingsOut();
    await refuseAuditRows("apikey.deleted");

    const res = await app!.inject({
      method: "DELETE",
      url: `/api/team/members/${s.bea.id}`,
      headers: { authorization: `Bearer ${(await bearer(s.ada)).token}` },
    });

    expect(res.statusCode).toBe(500);
    const [bea] = await t.db.select().from(users).where(eq(users.id, s.bea.id));
    expect(bea?.status).toBe("active");
    const [token] = await t.db.select().from(auditTokens).where(eq(auditTokens.id, s.token.id));
    expect(token?.revokedAt).toBeNull();
  });
});

describe("a removed person's sign-in", () => {
  it("is recorded as blocked against their account, in the reply every address gets", async () => {
    const dana = await person("dana@example.com", { status: "removed" });
    const signIn = (email: string) =>
      app!.inject({ method: "POST", url: "/auth/sign-in", payload: { email, password: PASSWORD } });

    const removed = await signIn("dana@example.com");
    const unknown = await signIn("nobody@example.com");

    expect(removed.statusCode).toBe(401);
    expect(removed.json()).toEqual(unknown.json());
    const [blocked] = await rows("signin.blocked");
    expect(blocked).toMatchObject({
      actor_user_id: dana.id,
      actor_email: "dana@example.com",
      target_id: dana.id,
      note: "account removed",
    });
    expect((await rows("signin.failed")).map((r) => r.actor_email)).toEqual(["nobody@example.com"]);
  });
});

describe("a refused Google or GitHub sign-in", () => {
  const signIn = () =>
    app!.inject({
      method: "POST",
      url: "/auth/oauth/google",
      payload: { token: "provider-token" },
    });

  it("records an address with no account", async () => {
    expect((await signIn()).statusCode).toBe(403);
    expect(await rows("signin.failed")).toMatchObject([
      {
        actor_user_id: null,
        actor_email: "stranger@example.com",
        note: "Google sign-in, no account with this address",
      },
    ]);
  });

  it("records a token the provider would not verify", async () => {
    oauth.verifies = false;
    expect((await signIn()).statusCode).toBe(401);
    expect(await rows("signin.failed")).toMatchObject([
      {
        actor_user_id: null,
        actor_name: "(unknown)",
        note: "Google sign-in could not be verified",
      },
    ]);
  });

  it("records an account with no verified address", async () => {
    oauth.email = null;
    expect((await signIn()).statusCode).toBe(403);
    expect(await rows("signin.failed")).toMatchObject([
      { actor_user_id: null, note: "Google sign-in, no verified email address" },
    ]);
  });

  it("records a removed account as blocked, by its address or by its provider id", async () => {
    const byAddress = await person("stranger@example.com", { status: "removed" });
    expect((await signIn()).statusCode).toBe(403);

    const [byProvider] = await t.db
      .insert(users)
      .values({ email: "linked@example.com", status: "removed", googleId: "google-subject-2" })
      .returning();
    oauth.providerId = "google-subject-2";
    oauth.email = "linked@example.com";
    expect((await signIn()).statusCode).toBe(400);

    expect((await rows("signin.blocked")).map((r) => [r.actor_user_id, r.note])).toEqual([
      [byAddress.id, "Google sign-in, account removed"],
      [byProvider!.id, "Google sign-in, account removed"],
    ]);
    expect(await rows("signin.failed")).toEqual([]);
  });
});

describe("signing out everywhere", () => {
  it("records each session it ended", async () => {
    const dana = await person("dana@example.com");
    const here = await bearer(dana);
    const others = [await bearer(dana), await bearer(dana)].map((b) => b.sessionId);

    const res = await app!.inject({
      method: "DELETE",
      url: "/api/account/sessions",
      headers: { authorization: `Bearer ${here.token}` },
    });
    expect(res.statusCode).toBe(200);

    const revoked = await rows("session.revoked");
    expect(revoked.map((r) => r.target_id).sort()).toEqual([...others].sort());
    expect(revoked.every((r) => r.note === "signed out everywhere")).toBe(true);
    // This device is its holder signing out, as a sign-out from it would be.
    expect(await rows("signout")).toMatchObject([
      { session_id: here.sessionId, note: "signed out everywhere, 3 devices" },
    ]);
  });
});

describe("an invitation's expiry", () => {
  it("is recorded at the time it expired, not when it was noticed", async () => {
    const admin = await person("admin@example.com", { role: "admin" });
    const expiredAt = new Date(Date.now() - 2 * 86_400_000);
    for (const email of ["late@example.com", "later@example.com"]) {
      const created = await createInvitation(t.db, {
        email,
        role: "read_only",
        createdBy: admin.id,
        mode: "onprem",
      });
      if (!created.ok) throw new Error(created.reason);
      await t.db
        .update(invitations)
        .set({ expiresAt: expiredAt })
        .where(eq(invitations.email, email));
      if (email === "late@example.com") {
        // Noticed by the holder opening the link.
        await app!.inject({
          method: "POST",
          url: "/auth/invite/preview",
          payload: { token: created.created.rawToken },
        });
      }
    }
    // The other one is noticed by an admin's list.
    await app!.inject({
      method: "GET",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${(await bearer(admin)).token}` },
    });

    const expired = await rows("invite.expired");
    expect(expired).toHaveLength(2);
    for (const row of expired)
      expect(new Date(row.occurred_at).getTime()).toBe(expiredAt.getTime());
  });
});
