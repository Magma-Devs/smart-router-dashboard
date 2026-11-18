import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { askRuns, askStaffAccess, users } from "@sr/db";
import { readAskSettings } from "../config.js";
import { askInternalRoutes } from "../routes/ask-internal.js";
import { authPlugin, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { AskStore } from "../services/ask/store.js";
import { createSession } from "../services/sessions.js";

const secret = "internal-ask-session-fixture-minimum-32-characters";
const settings = readAskSettings({ ASK_DATA_CUSTOMER_ID: "customer-a" });
const staff = {
  access: "staff",
  subject: "staff-subject-fixture",
  scopes: ["read"],
  tenantIds: ["customer-a", "customer-b"],
};
let t: TestDb;
let app: FastifyInstance;
let identity: unknown;
let jwt: string;
beforeEach(async () => {
  vi.stubEnv("TOTP_ENCRYPTION_KEY", "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=");
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("INTERNAL_AUTH_SECRET", secret);
  vi.stubEnv("DEPLOYMENT_MODE", "managed");
  t = await createTestDb();
  const [user] = await t.db
    .insert(users)
    .values({ email: "admin@example.test", role: "admin", ...enrolledTwoFactor() })
    .returning();
  const session = await createSession(t.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "127.0.0.1", userAgent: "Staff fixture" },
  });
  jwt = await new SignJWT({ sub: user!.id, sid: session.id, role: "admin", email: user!.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(secret));
  for (const customer of ["customer-a", "customer-b"]) {
    const store = new AskStore(t.db, customer, 90);
    const chat = await store.createChat(user!.id);
    const run = await store.submit(
      user!.id,
      session.id,
      chat.id,
      { idempotencyKey: crypto.randomUUID(), question: `${customer} synthetic question` },
      async () => undefined,
    );
    await store.cancel(user!.id, run.id);
  }
  identity = staff;
  vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
  vi.spyOn(Client.prototype, "callTool").mockImplementation(async (_request) => {
    expect(_request.name).toBe("whoami");
    return { content: [{ type: "text", text: JSON.stringify(identity) }] };
  });
  app = Fastify();
  app.decorate("db", t.db);
  await app.register(authPlugin);
  await app.register(askInternalRoutes, { settings });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await t.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const request = (path = "records", token = "staff-fixture-token-123456") =>
  app.inject({ url: `/api/internal/ask/${path}`, headers: { authorization: `Bearer ${token}` } });
describe("independent internal staff record authorization", () => {
  it("exports only this deployment's retained records and records the actual staff subject", async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.json().records).toHaveLength(1);
    expect(response.body).toContain("customer-a synthetic");
    expect(response.body).not.toContain("customer-b synthetic");
    const exported = await request("export");
    expect(exported.headers["content-type"]).toContain("application/x-ndjson");
    expect(
      exported.body
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string })
        .map((row) => row.kind),
    ).toEqual(["run", "page"]);
    expect((await t.db.select().from(askStaffAccess)).map((a) => [a.subject, a.action])).toEqual([
      [staff.subject, "read"],
      [staff.subject, "export"],
    ]);
    expect(await t.db.select().from(askRuns)).toHaveLength(2);
  });
  it("does not turn a signed-in customer admin into internal staff", async () => {
    identity = {
      access: "customer",
      subject: "customer-admin",
      tenantId: "customer-a",
      tenantIds: ["customer-a"],
      scopes: ["read"],
    };
    expect((await request("records", jwt)).statusCode).toBe(403);
    expect((await request("export", jwt)).statusCode).toBe(403);
    expect(await t.db.select().from(askStaffAccess)).toHaveLength(0);
  });
  it.each([
    { ...staff, tenantIds: ["customer-b"] },
    { ...staff, scopes: ["read", "write"] },
    { ...staff, access: "customer" },
  ])("rechecks the grant on every read and refuses foreign/write principals", async (value) => {
    expect((await request()).statusCode).toBe(200);
    identity = value;
    expect((await request()).statusCode).toBe(403);
  });
  it("rejects missing credentials, customer overrides, writes and self-hosted deployments", async () => {
    expect((await app.inject({ url: "/api/internal/ask/records" })).statusCode).toBe(403);
    expect((await request("records?customerId=customer-b")).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/api/internal/ask/records" })).statusCode,
    ).toBe(401);
    vi.stubEnv("DEPLOYMENT_MODE", "onprem");
    expect((await request()).statusCode).toBe(404);
  });
  it("provides safe maintenance/accounting health separately from the customer API", async () => {
    const response = await request("health");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      customerId: "customer-a",
      maintenance: null,
      uncertainSteps: 0,
      months: [],
    });
  });
});
