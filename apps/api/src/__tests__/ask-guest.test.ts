import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { askChats, sessions, users } from "@sr/db";
import { askGuestMode, readAskSettings } from "../config.js";
import { askRoutes } from "../routes/ask.js";
import { authPlugin } from "../plugins/auth.js";
import { afterMigrate } from "../plugins/db.js";
import {
  ASK_GUEST_SESSION_ID,
  ASK_GUEST_USER_ID,
  ensureAskGuest,
  retireAskGuest,
} from "../services/ask/guest.js";
import { listMembers } from "../services/members.js";
import { needsSetup } from "../services/setup.js";

const GUEST_ENV = {
  AUTH_MODE: "disabled",
  ASK_DATA_GUEST: "true",
  ASK_DATA_ENABLED: "true",
  DEPLOYMENT_MODE: "managed",
  ASK_DATA_CUSTOMER_ID: "acme",
  ASK_DATA_MCP_TOKEN: "fixture-token",
  AWS_BEARER_TOKEN_BEDROCK: "fixture-provider",
  ASK_DATA_BEDROCK_MODEL: "fixture-model",
};

describe("askGuestMode", () => {
  it("is on only with ASK_DATA_GUEST, accounts off, Ask on and a managed deployment", () => {
    expect(askGuestMode(GUEST_ENV)).toBe(true);
    expect(askGuestMode({ ...GUEST_ENV, AUTH_MODE: undefined })).toBe(true);
    for (const overrides of [
      { ASK_DATA_GUEST: undefined },
      { ASK_DATA_GUEST: "1" },
      { AUTH_MODE: "enabled" },
      { ASK_DATA_ENABLED: "false" },
      { DEPLOYMENT_MODE: "onprem" },
    ])
      expect(askGuestMode({ ...GUEST_ENV, ...overrides })).toBe(false);
  });

  it("turns Ask on with accounts off only through the guest", () => {
    expect(readAskSettings(GUEST_ENV)).toMatchObject({ enabled: true, guest: true, problem: null });
    expect(readAskSettings({ ...GUEST_ENV, ASK_DATA_GUEST: undefined })).toMatchObject({
      enabled: false,
      guest: false,
    });
    expect(readAskSettings({ ...GUEST_ENV, AUTH_MODE: "enabled" })).toMatchObject({
      enabled: true,
      guest: false,
    });
  });
});

describe("the guest's rows", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const guestRow = async () =>
    (await t.db.select().from(users).where(eq(users.id, ASK_GUEST_USER_ID)))[0];
  const guestSession = async () =>
    (await t.db.select().from(sessions).where(eq(sessions.id, ASK_GUEST_SESSION_ID)))[0];

  it("guest mode makes it active with a live session, and stays idempotent", async () => {
    await ensureAskGuest(t.db);
    await ensureAskGuest(t.db);
    expect(await guestRow()).toMatchObject({
      status: "active",
      role: "read_only",
      passwordHash: null,
    });
    const session = await guestSession();
    expect(session?.revokedAt).toBeNull();
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 365 * 86_400_000);
  });

  it("accounts mode removes it, so it is no member and first-run setup still runs", async () => {
    await ensureAskGuest(t.db);
    await retireAskGuest(t.db);
    expect((await guestRow())?.status).toBe("removed");
    expect((await guestSession())?.revokedAt).not.toBeNull();
    expect(await needsSetup(t.db)).toBe(true);
    expect((await listMembers(t.db)).map((m) => m.id)).not.toContain(ASK_GUEST_USER_ID);
    // And guest mode brings it back.
    await ensureAskGuest(t.db);
    expect((await guestRow())?.status).toBe("active");
    expect((await guestSession())?.revokedAt).toBeNull();
  });

  it("each boot takes its mode's step after the migrations", async () => {
    const app = Fastify();
    await afterMigrate(app, t.db, true);
    expect((await guestRow())?.status).toBe("active");
    await afterMigrate(app, t.db, false);
    expect((await guestRow())?.status).toBe("removed");
    expect(await needsSetup(t.db)).toBe(true);
    await app.close();
  });

  it("accounts mode with no guest changes nothing", async () => {
    await retireAskGuest(t.db);
    expect(await guestRow()).toBeUndefined();
  });
});

describe("Ask routes with accounts off", () => {
  let app: FastifyInstance;
  let t: TestDb;

  beforeEach(async () => {
    for (const [name, value] of Object.entries(GUEST_ENV)) vi.stubEnv(name, value);
    t = await createTestDb();
    await ensureAskGuest(t.db);
    app = Fastify();
    app.decorate("db", t.db);
    await app.register(askRoutes, {
      settings: readAskSettings(GUEST_ENV),
      admit: async () => undefined,
      ready: () => true,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    await t?.close();
    vi.unstubAllEnvs();
  });

  it("answers capabilities with no session, and nobody holds the switch", async () => {
    const response = await app.inject({ url: "/api/ask/capabilities" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: true,
      acceptingQuestions: true,
      canSwitch: false,
    });
    const off = await app.inject({
      method: "POST",
      url: "/api/ask/switch",
      payload: { off: true },
    });
    expect(off.statusCode).toBe(403);
  });

  it("every visitor reads and writes one shared history, and a question queues", async () => {
    const created = await app.inject({ method: "POST", url: "/api/ask/chats", payload: {} });
    expect(created.statusCode).toBe(200);
    const chatId = created.json().id as string;
    const listed = await app.inject({ url: "/api/ask/chats" });
    expect(listed.json().chats.map((c: { id: string }) => c.id)).toEqual([chatId]);
    const [row] = await t.db.select().from(askChats).where(eq(askChats.id, chatId));
    expect(row?.ownerId).toBe(ASK_GUEST_USER_ID);
    const run = await app.inject({
      method: "POST",
      url: `/api/ask/chats/${chatId}/runs`,
      payload: {
        question: "How many errors in the last hour?",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe("queued");
  });

  it("a retired guest can queue nothing", async () => {
    const chatId = (await app.inject({ method: "POST", url: "/api/ask/chats", payload: {} })).json()
      .id as string;
    await retireAskGuest(t.db);
    const run = await app.inject({
      method: "POST",
      url: `/api/ask/chats/${chatId}/runs`,
      payload: { question: "Anything?", idempotencyKey: crypto.randomUUID() },
    });
    expect(run.statusCode).toBe(404);
  });
});

describe("ASK_DATA_GUEST with accounts on", () => {
  it("changes nothing: Ask still needs a signed-in person", async () => {
    vi.stubEnv("AUTH_MODE", "enabled");
    vi.stubEnv("AUTH_SECRET", "ask-session-secret-with-at-least-32-chars");
    vi.stubEnv("INTERNAL_AUTH_SECRET", "ask-internal-test-secret");
    vi.stubEnv("TOTP_ENCRYPTION_KEY", "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=");
    const t = await createTestDb();
    const app = Fastify();
    try {
      app.decorate("db", t.db);
      await app.register(authPlugin);
      await app.register(askRoutes, {
        settings: readAskSettings({ ...GUEST_ENV, AUTH_MODE: "enabled" }),
      });
      await app.ready();
      expect((await app.inject({ url: "/api/ask/capabilities" })).statusCode).toBe(401);
      expect(
        (await app.inject({ method: "POST", url: "/api/ask/chats", payload: {} })).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
      await t.close();
      vi.unstubAllEnvs();
    }
  });
});

describe("buildApp with ASK_DATA_GUEST and accounts off", () => {
  it("opens the database for Ask alone: Ask's routes, no sign-in, team or audit route", async () => {
    for (const [name, value] of Object.entries(GUEST_ENV)) vi.stubEnv(name, value);
    vi.stubEnv("DATABASE_URL", "postgres://sr:x@192.0.2.1:5432/na");
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    try {
      await app.ready();
      expect(app.hasDecorator("db")).toBe(true);
      expect(app.hasRoute({ method: "GET", url: "/api/ask/capabilities" })).toBe(true);
      expect(app.hasRoute({ method: "POST", url: "/api/ask/chats" })).toBe(true);
      expect(app.hasRoute({ method: "POST", url: "/auth/setup" })).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/api/team/invites" })).toBe(false);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });

  it("without ASK_DATA_GUEST, accounts off still opens no database", async () => {
    for (const [name, value] of Object.entries(GUEST_ENV)) vi.stubEnv(name, value);
    vi.stubEnv("ASK_DATA_GUEST", "");
    const { buildApp } = await import("../app.js");
    const app = await buildApp();
    try {
      await app.ready();
      expect(app.hasDecorator("db")).toBe(false);
      expect(app.hasRoute({ method: "GET", url: "/api/ask/capabilities" })).toBe(false);
    } finally {
      await app.close();
      vi.unstubAllEnvs();
    }
  });
});
