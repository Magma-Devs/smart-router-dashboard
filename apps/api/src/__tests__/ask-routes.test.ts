import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { askRoutes } from "../routes/ask.js";
import { authPlugin, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession, revokeSession } from "../services/sessions.js";

const SECRET = "ask-session-secret-with-at-least-32-chars";
let app: FastifyInstance;
let t: TestDb;

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "enabled");
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("INTERNAL_AUTH_SECRET", "ask-internal-test-secret");
  vi.stubEnv("TOTP_ENCRYPTION_KEY", "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=");
  vi.stubEnv("ASK_DATA_ENABLED", "true");
  vi.stubEnv("DEPLOYMENT_MODE", "managed");
  t = await createTestDb();
  app = Fastify();
  app.decorate("db", t.db);
  await app.register(authPlugin);
  await app.register(askRoutes);
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
    client: { ip: "127.0.0.1", userAgent: "Ask tests" },
  });
  const token = await new SignJWT({ sub: user!.id, sid: session.id, role, email: user!.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { headers: { authorization: `Bearer ${token}` }, session };
}

describe("Ask foundation capability route", () => {
  it.each(["read_only", "admin"] as const)(
    "admits a live %s session without invoking providers or exposing secrets",
    async (role) => {
      const { headers } = await signedIn(role);
      const fetchImpl = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", fetchImpl);
      try {
        const response = await app.inject({ url: "/api/ask/capabilities", headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          enabled: true,
          acceptingQuestions: false,
          contractVersion: 1,
        });
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("requires a live session and immediately respects revocation", async () => {
    expect((await app.inject({ url: "/api/ask/capabilities" })).statusCode).toBe(401);
    const { headers, session } = await signedIn();
    expect((await app.inject({ url: "/api/ask/capabilities", headers })).statusCode).toBe(200);
    await revokeSession(t.db, session.id, { reason: "self" });
    expect((await app.inject({ url: "/api/ask/capabilities", headers })).statusCode).toBe(401);
  });

  it.each([{ ASK_DATA_ENABLED: "false" }, { DEPLOYMENT_MODE: "onprem" }])(
    "refuses disabled/self-hosted deployments",
    async (overrides) => {
      const { headers } = await signedIn();
      for (const [name, value] of Object.entries(overrides)) vi.stubEnv(name, value);
      const response = await app.inject({ url: "/api/ask/capabilities", headers });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("ASK_DISABLED");
    },
  );

  it("refuses submission until budget admission is installed", async () => {
    const { headers } = await signedIn();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/ask/chats/b4deca46-c815-4bc1-8075-10dc981ffbf1/runs",
          headers,
          payload: { question: "spend" },
        })
      ).statusCode,
    ).toBe(503);
  });
});
