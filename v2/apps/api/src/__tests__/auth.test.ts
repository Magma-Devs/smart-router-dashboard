import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";

/**
 * AUTH_MODE behaviour. The db plugin connects lazily in the background, so
 * `enabled` apps boot fine against an unreachable DATABASE_URL — exactly
 * the property these tests rely on: the JWT gate works without a database;
 * only /auth/* flows need one (and 503 until it's up).
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
// Unroutable per RFC 5737 (TEST-NET) — connect fails fast, no retries hang.
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";

let app: FastifyInstance | null = null;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(async () => {
  await app?.close();
  app = null;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function mintToken(overrides: { iss?: string; aud?: string; secret?: string } = {}): Promise<string> {
  return new SignJWT({ sub: "00000000-0000-4000-8000-000000000001", email: "t@example.com", role: "member" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(overrides.iss ?? SESSION_JWT_ISSUER)
    .setAudience(overrides.aud ?? SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(overrides.secret ?? SECRET));
}

describe("AUTH_MODE=disabled (default)", () => {
  it("leaves /api/* open and does not mount /auth/*", async () => {
    setEnv({ AUTH_MODE: undefined, AUTH_SECRET: undefined, DATABASE_URL: undefined });
    app = await buildApp();

    const metrics = await app.inject({ method: "GET", url: "/api/metrics/specs" });
    expect(metrics.statusCode).not.toBe(401);

    const signIn = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { email: "a@b.c", password: "x" },
    });
    expect(signIn.statusCode).toBe(404);
  });
});

describe("AUTH_MODE=enabled", () => {
  it("refuses to boot without AUTH_SECRET", async () => {
    setEnv({ AUTH_MODE: "enabled", AUTH_SECRET: undefined, DATABASE_URL: DEAD_DB });
    await expect(buildApp()).rejects.toThrow(/AUTH_SECRET/);
  });

  it("refuses to boot without DATABASE_URL", async () => {
    setEnv({ AUTH_MODE: "enabled", AUTH_SECRET: SECRET, DATABASE_URL: undefined });
    await expect(buildApp()).rejects.toThrow(/DATABASE_URL/);
  });

  describe("with secret + (unreachable) database", () => {
    async function enabledApp(): Promise<FastifyInstance> {
      setEnv({ AUTH_MODE: "enabled", AUTH_SECRET: SECRET, DATABASE_URL: DEAD_DB });
      return buildApp();
    }

    it("keeps /health and /version public", async () => {
      app = await enabledApp();
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/version" })).statusCode).toBe(200);
    });

    it("401s /api/* without a token", async () => {
      app = await enabledApp();
      const res = await app.inject({ method: "GET", url: "/api/metrics/specs" });
      expect(res.statusCode).toBe(401);
    });

    it("admits /api/* with a valid Bearer", async () => {
      app = await enabledApp();
      const token = await mintToken();
      const res = await app.inject({
        method: "GET",
        url: "/api/metrics/specs",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).not.toBe(401);
    });

    it("rejects a token signed with the wrong secret", async () => {
      app = await enabledApp();
      const token = await mintToken({ secret: "another-secret-entirely-32-chars!!" });
      const res = await app.inject({
        method: "GET",
        url: "/api/metrics/specs",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects a token with the wrong issuer/audience", async () => {
      app = await enabledApp();
      const badIss = await mintToken({ iss: "someone-else" });
      const badAud = await mintToken({ aud: "some-other-api" });
      for (const token of [badIss, badAud]) {
        const res = await app.inject({
          method: "GET",
          url: "/api/metrics/specs",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("503s /auth/sign-in while the database is unreachable", async () => {
      app = await enabledApp();
      const res = await app.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { email: "a@b.c", password: "irrelevant" },
      });
      expect(res.statusCode).toBe(503);
    });
  });
});
