import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { and, eq } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { askRuns, auditEvents, users } from "@sr/db";
import { askRoutes } from "../routes/ask.js";
import { authPlugin, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { AskStore } from "../services/ask/store.js";
import { AskBudget } from "../services/ask/budget.js";
import { AskSwitchState } from "../services/ask/switch.js";
import { readAskSettings } from "../config.js";

const SECRET = "ask-switch-secret-with-at-least-32-chars";
const env = {
  AUTH_MODE: "enabled",
  DEPLOYMENT_MODE: "managed",
  ASK_DATA_ENABLED: "true",
  ASK_DATA_CUSTOMER_ID: "acme",
  ASK_DATA_MCP_TOKEN: "fixture-token",
  AWS_BEARER_TOKEN_BEDROCK: "fixture-provider",
  ASK_DATA_BEDROCK_MODEL: "fixture-model",
};
let app: FastifyInstance;
let t: TestDb;
let switched: boolean[];
const settings = () => readAskSettings(env);
const store = () => new AskStore(t.db, "acme", 90);

beforeEach(async () => {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("INTERNAL_AUTH_SECRET", "ask-internal-test-secret");
  vi.stubEnv("TOTP_ENCRYPTION_KEY", "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=");
  t = await createTestDb();
  switched = [];
  app = Fastify();
  app.decorate("db", t.db);
  await app.register(authPlugin);
  await app.register(askRoutes, {
    settings: settings(),
    admit: async () => undefined,
    ready: () => true,
    switched: (off) => switched.push(off),
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  await t?.close();
  vi.unstubAllEnvs();
});

async function signedIn(role: "read_only" | "admin" = "read_only") {
  const [user] = await t.db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, role, ...enrolledTwoFactor() })
    .returning();
  const session = await createSession(t.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "127.0.0.1", userAgent: "Ask switch tests" },
  });
  const token = await new SignJWT({ sub: user!.id, sid: session.id, role, email: user!.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { id: user!.id, sessionId: session.id, headers: { authorization: `Bearer ${token}` } };
}

const turn = (headers: Record<string, string>, off: boolean) =>
  app.inject({ method: "POST", url: "/api/ask/switch", headers, payload: { off } });

async function queued(person: Awaited<ReturnType<typeof signedIn>>) {
  const chat = await store().createChat(person.id);
  return store().submit(
    person.id,
    person.sessionId,
    chat.id,
    { idempotencyKey: crypto.randomUUID(), question: "How is my fleet?" },
    async () => undefined,
  );
}

describe("the admins' Ask switch", () => {
  it("is an admin's: a member sees it and cannot turn it", async () => {
    const member = await signedIn("read_only");
    const admin = await signedIn("admin");
    const caps = await app.inject({ url: "/api/ask/capabilities", headers: member.headers });
    expect(caps.json()).toMatchObject({ off: false, canSwitch: false, acceptingQuestions: true });
    expect(
      (await app.inject({ url: "/api/ask/capabilities", headers: admin.headers })).json(),
    ).toMatchObject({ canSwitch: true });
    const refused = await turn(member.headers, true);
    expect(refused.statusCode).toBe(403);
    expect(
      (await app.inject({ url: "/api/ask/capabilities", headers: member.headers })).json().off,
    ).toBe(false);
  });

  it("turns Ask off for everyone at once, audited once per change", async () => {
    const admin = await signedIn("admin");
    const member = await signedIn();
    const off = await turn(admin.headers, true);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ off: true });
    expect(switched).toEqual([true]);
    expect(
      (await app.inject({ url: "/api/ask/capabilities", headers: member.headers })).json(),
    ).toMatchObject({ off: true, acceptingQuestions: false });

    // A second click changes nothing and records nothing.
    expect((await turn(admin.headers, true)).statusCode).toBe(200);
    expect((await turn(admin.headers, false)).json()).toEqual({ off: false });
    const rows = await t.db
      .select({ action: auditEvents.action, actor: auditEvents.actorUserId })
      .from(auditEvents)
      .where(eq(auditEvents.targetType, "ask"));
    expect(rows.map((r) => r.action).sort()).toEqual(["ask.turned_off", "ask.turned_on"]);
    expect(rows.every((r) => r.actor === admin.id)).toBe(true);
    expect(
      (await app.inject({ url: "/api/ask/capabilities", headers: member.headers })).json(),
    ).toMatchObject({ off: false, acceptingQuestions: true });
  });

  it("cancels queued questions and stops running ones when turned off", async () => {
    const admin = await signedIn("admin");
    const waiting = await queued(await signedIn());
    const working = await queued(await signedIn());
    const claimed = await store().claim(15_000);
    expect(claimed?.id).toBe(waiting.id);
    expect((await turn(admin.headers, true)).statusCode).toBe(200);

    const [running] = await t.db.select().from(askRuns).where(eq(askRuns.id, waiting.id));
    expect(running!.status).toBe("cancelling");
    expect(await store().leaseState(claimed!.id, claimed!.leaseToken!)).toBe("cancelling");
    const [cancelled] = await t.db.select().from(askRuns).where(eq(askRuns.id, working.id));
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "ASK_CANCELLED" });
  });

  it("claims no queued question while off, and resumes when turned on", async () => {
    const admin = await signedIn("admin");
    await turn(admin.headers, true);
    // A question admitted in the instant before the switch committed.
    const late = await queued(await signedIn());
    expect(await store().claim(15_000)).toBeNull();
    await turn(admin.headers, false);
    expect((await store().claim(15_000))?.id).toBe(late.id);
  });

  it("refuses admission while off", async () => {
    const admin = await signedIn("admin");
    const person = await signedIn();
    const budget = new AskBudget(t.db, settings(), null);
    const admitOnce = async () => {
      const chat = await store().createChat(person.id);
      return store().submit(
        person.id,
        person.sessionId,
        chat.id,
        { idempotencyKey: crypto.randomUUID(), question: "Spend?" },
        budget.admit,
      );
    };
    await turn(admin.headers, true);
    await expect(admitOnce()).rejects.toMatchObject({ code: "ASK_TURNED_OFF" });
    await turn(admin.headers, false);
    // Past the switch, this budget has no rate card and refuses for that.
    await expect(admitOnce()).rejects.toMatchObject({ code: "ASK_UNAVAILABLE" });
    const rows = await t.db
      .select()
      .from(askRuns)
      .where(and(eq(askRuns.customerId, "acme"), eq(askRuns.ownerId, person.id)));
    expect(rows).toHaveLength(0);
  });

  it("is answered 404 where Ask is not enabled", async () => {
    const admin = await signedIn("admin");
    const disabled = Fastify();
    disabled.decorate("db", t.db);
    await disabled.register(authPlugin);
    await disabled.register(askRoutes, {
      settings: readAskSettings({ ...env, ASK_DATA_ENABLED: "false" }),
    });
    try {
      const response = await disabled.inject({
        method: "POST",
        url: "/api/ask/switch",
        headers: admin.headers,
        payload: { off: true },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("ASK_DISABLED");
    } finally {
      await disabled.close();
    }
  });

  it("refuses a body that is not exactly { off }", async () => {
    const admin = await signedIn("admin");
    for (const payload of [{}, { off: "yes" }, { off: true, customerId: "other" }]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/ask/switch",
        headers: admin.headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it("reads as off on a replica until its first read answers", async () => {
    const state = new AskSwitchState(t.db, "acme");
    expect(state.off).toBe(true);
    await state.refresh();
    expect(state.off).toBe(false);
    const admin = await signedIn("admin");
    await turn(admin.headers, true);
    await state.refresh();
    expect(state.off).toBe(true);
  });
});
