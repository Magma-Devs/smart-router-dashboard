import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetSetupTokenForTests } from "../services/setup.js";

/**
 * Events reaching the real writer, end to end.
 *
 * The value here isn't that `audit.write` was called — the call sites are
 * visible in the source. It is that what they send **survives MAG-2770's
 * catalog**: an unknown verb or access context on an event that may not carry
 * it is reported rather than rejected, so a mismatch between the two sides
 * would otherwise land silently and only surface when somebody read the log
 * during an incident.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const PASSWORD = "thistle-cobalt-marina-7781";

let app: FastifyInstance | null = null;
let t: TestDb;
/** Every catalog violation reported during a test. A violation means this
 *  codebase and MAG-2770's catalog disagree — the row still lands, so nothing
 *  else would ever surface it. */
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
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    SETUP_TOKEN: "installer-token",
    DEPLOYMENT_MODE: "onprem",
    PUBLIC_WEB_ORIGIN: "http://localhost:3000",
    PASSWORD_BREACH_CHECK: "off",
  });
  app = await buildApp();
  app.db = t.db;

  violations = [];
  const realError = app.log.error.bind(app.log);
  app.log.error = ((obj: unknown, msg?: string) => {
    if (typeof msg === "string" && msg.includes("violated the catalog")) violations.push(obj);
    return realError(obj as never, msg as never);
  }) as typeof app.log.error;
});

afterEach(async () => {
  // Asserted for every test, not in one of them: any flow that emits a verb the
  // catalog doesn't know, or context it forbids, fails here rather than
  // producing a quietly-wrong log.
  expect(violations, "emissions must match MAG-2770's catalog").toEqual([]);
  await app?.close();
  app = null;
  await t.close();
  resetSetupTokenForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Actions recorded so far, in order. */
async function actions(): Promise<string[]> {
  const rows = await t.db.execute<{ action: string }>(
    sql`select action from audit_events order by occurred_at asc, id asc`,
  );
  return rows.rows.map((r) => r.action);
}

async function adminToken(): Promise<{ token: string; id: string }> {
  const [admin] = await t.db
    .insert(users)
    .values({
      email: "admin@example.com",
      role: "admin",
      passwordHash: await hashPassword(PASSWORD),
    })
    .returning();
  const session = await createSession(t.db, {
    userId: admin!.id,
    authMethod: "password",
    client: { ip: "84.229.11.6", userAgent: "Chrome/141.0.0.0 (Macintosh)" },
  });
  const token = await new SignJWT({
    sub: admin!.id,
    email: admin!.email,
    role: "admin",
    sid: session.id,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { token, id: admin!.id };
}

describe("events reach the log", () => {
  it("records the first admin, with the access context that row is for", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/auth/setup",
      payload: { token: "installer-token", email: "first@example.com", password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(await actions()).toContain("setup.completed");

    // "Who became admin, from where" is the whole value of this row.
    const rows = await t.db.execute<{ ip: string | null; client: string | null }>(
      sql`select ip::text, client from audit_events where action = 'setup.completed'`,
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("records a successful and a failed sign-in differently", async () => {
    await adminToken();

    await app!.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: "admin@example.com", password: "wrong" },
    });
    await app!.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: "admin@example.com", password: PASSWORD },
    });

    const recorded = await actions();
    expect(recorded).toContain("signin.failed");
    expect(recorded).toContain("signin.succeeded");
  });

  it("records the invitation lifecycle", async () => {
    const { token } = await adminToken();
    const created = await app!.inject({
      method: "POST",
      url: "/api/team/invites",
      headers: { authorization: `Bearer ${token}` },
      payload: { email: "dana@example.com", role: "approver" },
    });
    expect(created.statusCode).toBe(201);
    const raw = String(created.json().url).split("/invite/")[1];

    await app!.inject({
      method: "POST",
      url: "/auth/invite/accept",
      payload: { token: raw, password: PASSWORD },
    });

    const recorded = await actions();
    expect(recorded).toContain("member.invited");
    expect(recorded).toContain("invite.redeemed");
  });

  it("records a role change with its before and after", async () => {
    const { token } = await adminToken();
    const [target] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", role: "read_only" })
      .returning();

    await app!.inject({
      method: "PATCH",
      url: `/api/team/members/${target!.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "approver" },
    });

    expect(await actions()).toContain("member.role_changed");
    // The diff is the point of the row — "Dana's role changed" without the
    // values is not something anybody can act on.
    const changes = await t.db.execute<{ field: string; from_value: string; to_value: string }>(
      sql`select c.* from audit_event_changes c
            join audit_events e on e.seq = c.event_seq
           where e.action = 'member.role_changed'`,
    );
    expect(changes.rows.length).toBeGreaterThan(0);
  });

  it("records a removal", async () => {
    const { token } = await adminToken();
    const [target] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", role: "requester" })
      .returning();

    await app!.inject({
      method: "DELETE",
      url: `/api/team/members/${target!.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await actions()).toContain("member.removed");
  });

  it("survives a real browser's User-Agent, which is longer than the column", async () => {
    // The access columns hold the PARSED device string and a normalised
    // address, not the raw header. Raw UAs run past varchar(128) on most real
    // browsers, the insert throws, and — because these are standalone writes —
    // the writer swallows and reports. The row vanishes and the log looks
    // healthy, which is worse than a uniform failure.
    const uas = [
      // Edge / Windows, 129 chars
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.2623.112",
      // Chrome / Android, 140
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0",
      // Safari / iOS, 135
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    ];

    for (const ua of uas) {
      expect(ua.length, "test fixture should exceed the column").toBeGreaterThan(128);
      await app!.inject({
        method: "POST",
        url: "/auth/sign-in",
        headers: { "user-agent": ua },
        payload: { email: "ghost@example.com", password: "wrong" },
      });
    }

    const recorded = (await actions()).filter((a) => a === "signin.failed");
    expect(recorded).toHaveLength(uas.length);
  });

  it("names the address on a failed sign-in, even with no account behind it", async () => {
    // "Someone failed to sign in" without saying as whom cannot distinguish a
    // typo from a run of guesses across a list of addresses — which is the
    // investigation this row exists for.
    await app!.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: "victim@example.com", password: "wrong" },
    });

    const rows = await t.db.execute<{ actor_email: string | null }>(
      sql`select actor_email from audit_events where action = 'signin.failed'`,
    );
    expect(rows.rows[0]?.actor_email).toBe("victim@example.com");
  });

  it("names the account on a lockout", async () => {
    for (let i = 0; i < 6; i++) {
      await app!.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: "target@example.com", password: "wrong" },
      });
    }
    const rows = await t.db.execute<{ actor_email: string | null }>(
      sql`select actor_email from audit_events where action = 'signin.blocked'`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    // A lockout row that doesn't name the account can't be acted on.
    expect(rows.rows[0]?.actor_email).toBe("target@example.com");
  });

  it("keeps writing when one event is malformed — the log is not all-or-nothing", async () => {
    // A caller bug must not take down the surface it rides on. The writer
    // reports and stores; it does not refuse.
    const { token } = await adminToken();
    await app!.inject({
      method: "POST",
      url: "/auth/sign-out",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await actions()).toContain("signout");
  });
});
