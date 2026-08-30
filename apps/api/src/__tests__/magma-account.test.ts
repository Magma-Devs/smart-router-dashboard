import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createInvitation } from "../services/invitations.js";
import { createSession } from "../services/sessions.js";
import { hashPassword } from "../services/password.js";
import { resetSetupTokenForTests } from "../services/setup.js";

/**
 * The Magma Devs account marker (MAG-2729, decided 26 Aug 2026).
 *
 * On a managed deployment a Magma operator runs first-run setup and that
 * account **stays** after handover. The rule it answers to was rewritten with
 * it: not "no standing admin account inside a customer's deployment" but "no
 * hidden Magma account, and none the customer can't see in their member list".
 *
 * So the properties worth holding are all about visibility and its limits —
 * the account is marked on managed and only there, only first-run can mark one,
 * the mark reaches every read surface, and it buys the account nothing: a
 * customer admin removes it by the ordinary route.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const TOKEN = "setup-token-from-the-installer";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const PASSWORD = "thistle-cobalt-marina-7781";

let app: FastifyInstance | null = null;
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
  resetSetupTokenForTests();
});

afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  resetSetupTokenForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function buildFor(mode: "managed" | "onprem"): Promise<FastifyInstance> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    SETUP_TOKEN: TOKEN,
    DEPLOYMENT_MODE: mode,
    PUBLIC_WEB_ORIGIN: "http://localhost:3000",
    PASSWORD_BREACH_CHECK: "off",
  });
  const instance = await buildApp();
  instance.db = t.db;
  return instance;
}

/** Run first-run setup over HTTP and hand back the account it created. */
async function firstRun(email = "ops.admin@magmadevs.com") {
  const res = await app!.inject({
    method: "POST",
    url: "/auth/setup",
    payload: { token: TOKEN, email, password: PASSWORD, name: "Ops Admin" },
  });
  expect(res.statusCode).toBe(201);
  const [row] = await t.db.select().from(users).where(eq(users.email, email.toLowerCase()));
  return row!;
}

/** A signed-in admin, created directly — this is the customer's own person, so
 *  it must never be marked. */
async function customerAdmin(email = "dana@dfns.co") {
  const [admin] = await t.db
    .insert(users)
    .values({ email, role: "admin", name: "Dana Levi", passwordHash: await hashPassword(PASSWORD) })
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
  return { user: admin!, token };
}

describe("who gets marked", () => {
  it("marks the managed first-run account — it is ours and it stays", async () => {
    app = await buildFor("managed");
    expect((await firstRun()).isMagmaAccount).toBe(true);
  });

  it("marks nothing on-prem, where the first admin is the customer's own", async () => {
    app = await buildFor("onprem");
    expect((await firstRun("admin@dfns.co")).isMagmaAccount).toBe(false);
  });

  it("never marks an invited account, even one invited on managed", async () => {
    // Per the rollout: one Magma account per managed deployment, created by
    // `/setup`. Everyone else — including whoever the operator invites as the
    // customer's admin — is the customer's. If invitations could inherit the
    // flag, the label would drift into meaning "created by Magma", which is a
    // different and much less useful claim.
    app = await buildFor("managed");
    const magma = await firstRun();

    // The invitation is created through the service rather than the route: on
    // managed the route withholds the link (it is emailed), so there would be
    // no token to redeem here. Redemption itself is the same code either way,
    // and that is the half this test is about.
    const invite = await createInvitation(t.db, {
      email: "dana@dfns.co",
      role: "admin",
      createdBy: magma.id,
      mode: "managed",
    });
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;

    const accepted = await app.inject({
      method: "POST",
      url: "/auth/invite/accept",
      payload: {
        token: invite.created.rawToken,
        password: "mixed-case-passphrase-31",
        name: "Dana Levi",
      },
    });
    expect(accepted.statusCode).toBe(201);

    const [row] = await t.db.select().from(users).where(eq(users.email, "dana@dfns.co"));
    expect(row?.isMagmaAccount).toBe(false);
  });
});

describe("the member list shows it", () => {
  it("labels the row in the JSON every role can read", async () => {
    app = await buildFor("managed");
    const magma = await firstRun();
    const { token } = await customerAdmin();

    const res = await app.inject({
      method: "GET",
      url: "/api/team/members",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const rows = res.json().members as Array<{ email: string; isMagmaAccount: boolean }>;
    // Both people are listed. Nothing is filtered out — an account the customer
    // can't see in their own member list is the thing this forbids.
    expect(rows.map((r) => r.email).sort()).toEqual(["dana@dfns.co", magma.email]);
    expect(rows.find((r) => r.email === magma.email)?.isMagmaAccount).toBe(true);
    expect(rows.find((r) => r.email === "dana@dfns.co")?.isMagmaAccount).toBe(false);
  });

  it("carries it into the CSV, which is the artifact an auditor reads", async () => {
    app = await buildFor("managed");
    const magma = await firstRun();
    const { token } = await customerAdmin();

    const res = await app.inject({
      method: "GET",
      url: "/api/team/members.csv",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const [header, ...rows] = res.body.trim().split("\n");
    expect(header?.trim().endsWith("magma_account")).toBe(true);
    const magmaRow = rows.find((r) => r.includes(magma.email));
    const customerRow = rows.find((r) => r.includes("dana@dfns.co"));
    expect(magmaRow?.trim().endsWith("yes")).toBe(true);
    expect(customerRow?.trim().endsWith("no")).toBe(true);
  });
});

describe("what the mark does not buy it", () => {
  it("lets a customer admin remove it by the ordinary route", async () => {
    // "A customer admin can remove it like any other member. No special
    // handling." Nothing branches on the flag here — this test exists to catch
    // the day somebody adds a guard that feels protective and isn't.
    app = await buildFor("managed");
    const magma = await firstRun();
    const { token } = await customerAdmin();

    const res = await app.inject({
      method: "DELETE",
      url: `/api/team/members/${magma.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await t.db.select().from(users).where(eq(users.id, magma.id));
    expect(row?.status).toBe("removed");
    // And the mark survives on the removed row: it is a fact about the account,
    // not a live permission, and the audit log's names are snapshots too.
    expect(row?.isMagmaAccount).toBe(true);
  });

  it("grants no role of its own — the account is admin because setup made it one", async () => {
    app = await buildFor("managed");
    const magma = await firstRun();
    const { token } = await customerAdmin();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/team/members/${magma.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: "read_only" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await t.db.select().from(users).where(eq(users.id, magma.id));
    expect(row?.role).toBe("read_only");
    expect(row?.isMagmaAccount).toBe(true);
  });
});
