import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { eq } from "drizzle-orm";
import { USAGE_VIEWS, type Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { readUsageSettings } from "../config.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { usageRoutes } from "../routes/usage.js";
import { createSession } from "../services/sessions.js";
import { viewerOf } from "../services/usage.js";

/* Usage data (MAG-5373): the browser runs Mixpanel's SDK itself, started with
   what GET /api/usage/config answers. The answer is on, with the project
   token, only with accounts on, the deployment's switch on, a token, and a
   signed-in user; the api never sends anything to Mixpanel. */

const TOKEN = "test-project-token";
const SECRET = "test-secret-for-auth-tests-32-chars!";
const ACCOUNTS = {
  AUTH_MODE: "enabled",
  AUTH_SECRET: SECRET,
  DATABASE_URL: "postgres://sr:x@192.0.2.1:5432/na",
  TOTP_ENCRYPTION_KEY: "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=",
  INTERNAL_AUTH_SECRET: "test-internal-secret-32-characters!",
};
const KEYS = [
  ...Object.keys(ACCOUNTS),
  "DEPLOYMENT_MODE", "USAGE_ANALYTICS", "MIXPANEL_TOKEN", "MIXPANEL_API_HOST", "USAGE_TENANT", "USAGE_STAFF_DOMAINS", "TENANT_ID", "APP_VERSION",
];
const HOSTED = { ...ACCOUNTS, DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, TENANT_ID: "tenant-a", APP_VERSION: "0.71.0" };

let app: FastifyInstance | null = null;
let t: TestDb | null = null;

async function boot(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  app = await buildApp();
  if (env.AUTH_MODE === "enabled") {
    t = await createTestDb();
    app.db = t.db;
  }
  await app.ready();
}

/** A session of a user with this address, as the web presents it, and the user's id. */
async function signedIn(email: string, role: Role = "read_only"): Promise<{ headers: Record<string, string>; id: string }> {
  const [user] = await t!.db.insert(users).values({ ...enrolledTwoFactor(), email, name: "Noa Cohen", role }).returning();
  const session = await createSession(t!.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "203.0.113.64", userAgent: "Chrome/141 (Macintosh)" },
  });
  const jwt = await new SignJWT({ sub: user!.id, email: user!.email, role, sid: session.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { headers: { authorization: `Bearer ${jwt}` }, id: user!.id };
}

const get = (headers: Record<string, string> = {}) => app!.inject({ method: "GET", url: "/api/usage/config", headers });
const MONTH = expect.stringMatching(/^\d{4}-\d{2}$/);
const opaque = (tenant: string, userId: string) => createHash("sha256").update(`${tenant}:${userId}`).digest("hex").slice(0, 32);

afterEach(async () => {
  await app?.close();
  app = null;
  await t?.close();
  t = null;
  for (const k of KEYS) delete process.env[k];
});

describe("GET /api/usage/config on a deployment we host, accounts on", () => {
  beforeEach(() => boot(HOSTED));

  it("answers on, with what the browser starts the SDK with, to a signed-in user", async () => {
    const who = await signedIn("ops@client.example", "admin");
    const res = await get(who.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      enabled: true,
      token: TOKEN,
      apiHost: "https://api-eu.mixpanel.com",
      tenant: "tenant-a",
      deploymentMode: "managed",
      version: "0.71.0",
      viewer: { id: opaque("tenant-a", who.id), staff: false, role: "admin", created: MONTH, twoFactor: true, signIn: "password" },
    });
  });

  it("says the account's month, whether 2FA is set up and how the session signed in - never more of the date", async () => {
    const who = await signedIn("ops@client.example");
    const viewer = (await get(who.headers)).json().viewer;
    expect(viewer.created).toMatch(/^\d{4}-\d{2}$/);
    expect(viewer).toMatchObject({ twoFactor: true, signIn: "password" });
  });

  it("names the viewer by an opaque id: never the address or the account id, the same on every visit", async () => {
    const who = await signedIn("ops@client.example");
    const first = (await get(who.headers)).json();
    const again = (await get(who.headers)).json();
    expect(first.viewer.id).toMatch(/^[0-9a-f]{32}$/);
    expect(again.viewer.id).toBe(first.viewer.id);
    const body = JSON.stringify(first);
    expect(body).not.toContain("client.example");
    expect(body).not.toContain(who.id);
    const other = await signedIn("someone@client.example");
    expect((await get(other.headers)).json().viewer.id).not.toBe(first.viewer.id);
  });

  it("marks anyone at magmadevs.com as staff, and names them by their address", async () => {
    const who = await signedIn("Someone@MagmaDevs.com");
    const body = (await get(who.headers)).json();
    expect(body.viewer).toMatchObject({ staff: true, role: "read_only", email: "someone@magmadevs.com" });
  });

  it("never sends a customer's address", async () => {
    const who = await signedIn("ops@client.example");
    const body = (await get(who.headers)).json();
    expect(body.viewer).not.toHaveProperty("email");
    expect(JSON.stringify(body)).not.toContain("client.example");
  });

  it("refuses a caller with no session", async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it("has no route that takes events: the api sends nothing to Mixpanel", async () => {
    const who = await signedIn("ops@client.example");
    const res = await app!.inject({ method: "POST", url: "/api/usage", headers: who.headers, payload: { visit: "x", events: [] } });
    expect(res.statusCode).toBe(404);
    const paths = (app!.swagger().paths ?? {}) as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).filter((p) => p.startsWith("/api/usage")).sort()).toEqual(["/api/usage/config", "/api/usage/viewers/{id}"]);
    expect(Object.keys(paths["/api/usage/config"]!)).toEqual(["get"]);
    expect(Object.keys(paths["/api/usage/viewers/{id}"]!)).toEqual(["get"]);
  });
});

describe("the same person on another tenant", () => {
  it("is another id: the tenant is part of it", async () => {
    await boot({ ...HOSTED, TENANT_ID: "tenant-b" });
    const who = await signedIn("ops@client.example");
    expect((await get(who.headers)).json().viewer.id).toBe(opaque("tenant-b", who.id));
    expect(opaque("tenant-b", who.id)).not.toBe(opaque("tenant-a", who.id));
  });
});

describe("where usage data is off, the answer is off and carries no token", () => {
  const off = async (headers: Record<string, string> = {}) => {
    const res = await get(headers);
    expect(res.json()).toEqual({ enabled: false });
    expect(res.body).not.toContain(TOKEN);
  };

  it("with accounts off, hosted, switched on and with a token", async () => {
    await boot({ DEPLOYMENT_MODE: "managed", USAGE_ANALYTICS: "on", MIXPANEL_TOKEN: TOKEN });
    await off();
  });

  it("on a self-hosted deployment by default, accounts and token or not", async () => {
    await boot({ ...ACCOUNTS, DEPLOYMENT_MODE: "onprem", MIXPANEL_TOKEN: TOKEN });
    await off((await signedIn("ops@client.example")).headers);
  });

  it("on a hosted deployment switched off", async () => {
    await boot({ ...HOSTED, USAGE_ANALYTICS: "off" });
    await off((await signedIn("ops@client.example")).headers);
  });

  it("on a hosted deployment without a token", async () => {
    await boot({ ...ACCOUNTS, DEPLOYMENT_MODE: "managed" });
    await off((await signedIn("ops@client.example")).headers);
  });
});

/** The route alone, with the caller the global gate would have put on the request. */
async function routeAlone(user: { id: string; email: string; role: Role } | null) {
  const local = Fastify();
  local.decorateRequest("authUser", null);
  local.addHook("onRequest", async (request) => {
    (request as unknown as { authUser: unknown }).authUser = user;
  });
  await local.register(usageRoutes, { settings: readUsageSettings({ AUTH_MODE: "enabled", DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN }) });
  return local;
}

describe("a request with no signed-in user behind it", () => {
  it("is answered off, so nothing is ever recorded without its staff mark", async () => {
    const local = await routeAlone(null);
    const res = await local.inject({ method: "GET", url: "/api/usage/config" });
    expect(res.json()).toEqual({ enabled: false });
    expect(res.body).not.toContain(TOKEN);
    await local.close();
    const signed = await routeAlone({ id: "u-1", email: "ops@client.example", role: "admin" });
    expect((await signed.inject({ method: "GET", url: "/api/usage/config" })).json()).toMatchObject({ enabled: true, token: TOKEN });
    await signed.close();
  });
});

describe("readUsageSettings", () => {
  const on = { AUTH_MODE: "enabled", MIXPANEL_TOKEN: TOKEN };

  it("is on for a hosted deployment with accounts and a token, off for a self-hosted one unless switched on", () => {
    expect(readUsageSettings({ ...on, DEPLOYMENT_MODE: "managed" }).enabled).toBe(true);
    expect(readUsageSettings({ ...on, DEPLOYMENT_MODE: "managed", USAGE_ANALYTICS: "off" }).enabled).toBe(false);
    expect(readUsageSettings(on).enabled).toBe(false);
    expect(readUsageSettings({ ...on, USAGE_ANALYTICS: "on" }).enabled).toBe(true);
  });

  it("is off with accounts off, whatever else is set, and says why only when switched on", () => {
    expect(readUsageSettings({ DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN })).toMatchObject({ enabled: false, problem: null });
    expect(readUsageSettings({ AUTH_MODE: "disabled", DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, USAGE_ANALYTICS: "on" }))
      .toMatchObject({ enabled: false, problem: "accounts are off (AUTH_MODE): usage data is sent only for signed-in users" });
  });

  it("names the tenant from USAGE_TENANT, else TENANT_ID", () => {
    expect(readUsageSettings({ TENANT_ID: "t1" }).tenant).toBe("t1");
    expect(readUsageSettings({ TENANT_ID: "t1", USAGE_TENANT: "t2" }).tenant).toBe("t2");
    expect(readUsageSettings({}).tenant).toBe("unnamed");
  });

  it("says why it is off when switched on without a token or with a plain-http host", () => {
    expect(readUsageSettings({ AUTH_MODE: "enabled", USAGE_ANALYTICS: "on" })).toMatchObject({ enabled: false, problem: "MIXPANEL_TOKEN is not set" });
    expect(readUsageSettings({ ...on, USAGE_ANALYTICS: "on", MIXPANEL_API_HOST: "http://evil.example" }))
      .toMatchObject({ enabled: false, problem: "MIXPANEL_API_HOST must be https" });
    expect(readUsageSettings({ ...on, USAGE_ANALYTICS: "on", MIXPANEL_API_HOST: "http://127.0.0.1:9999" }))
      .toMatchObject({ enabled: true, host: "http://127.0.0.1:9999" });
  });
});

describe("staff and role", () => {
  const s = readUsageSettings({ AUTH_MODE: "enabled", DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, TENANT_ID: "t" });

  it("marks a signed-in user on our domain as staff, with the role and the address; a customer without it", () => {
    const viewer = viewerOf({ id: "u-1", email: "Someone@magmadevs.com", role: "admin" }, s);
    expect(viewer).toEqual({ id: opaque("t", "u-1"), staff: true, role: "admin", email: "someone@magmadevs.com", created: null, twoFactor: null, signIn: null });
    const customer = viewerOf({ id: "u-2", email: "ops@client.example", role: "read_only" }, s);
    expect(customer).toEqual({ id: opaque("t", "u-2"), staff: false, role: "read_only", created: null, twoFactor: null, signIn: null });
    expect(JSON.stringify(customer)).not.toContain("client.example");
  });

  it("reads the month, 2FA and the first factor from the live row and session", () => {
    const base = { id: "u-1", email: "ops@client.example", role: "admin" as const };
    const user = { createdAt: new Date("2026-03-31T23:59:59Z"), totpEnrolledAt: null };
    expect(viewerOf({ ...base, user, session: { authMethod: "google+totp" } }, s)).toMatchObject({ created: "2026-03", twoFactor: false, signIn: "google" });
    expect(viewerOf({ ...base, user: { ...user, totpEnrolledAt: new Date() }, session: { authMethod: "password" } }, s)).toMatchObject({ twoFactor: true, signIn: "password" });
    expect(viewerOf({ ...base, user, session: { authMethod: "saml" } }, s)).toMatchObject({ signIn: "other" });
  });

  it("is our domain exactly: not one that ends with it, not one that starts with it", () => {
    for (const email of ["a@notmagmadevs.com", "a@magmadevs.com.example", "a@sub.magmadevs.com", "magmadevs.com@client.example"]) {
      const viewer = viewerOf({ id: "u-1", email, role: "admin" }, s);
      expect(viewer).toMatchObject({ staff: false, role: "admin" });
      expect(viewer).not.toHaveProperty("email");
    }
  });

  it("is nobody without a signed-in user", () => {
    expect(viewerOf(null, s)).toBeNull();
  });
});

describe("the views a usage event may name", () => {
  it("list every read the api registers, so a new one is added there and never passed through as written", async () => {
    await boot({});
    const paths = (app!.swagger().paths ?? {}) as Record<string, Record<string, unknown>>;
    const reads = Object.entries(paths)
      .filter(([path, methods]) => path.startsWith("/api/") && "get" in methods)
      .map(([path]) => path.replace(/\{[^}]+\}/g, ":id"));
    expect(reads.length).toBeGreaterThan(20);
    expect(reads.filter((path) => !(USAGE_VIEWS as readonly string[]).includes(path))).toEqual([]);
  });
});

describe("GET /api/usage/viewers/:id", () => {
  beforeEach(() => boot(HOSTED));
  const lookup = (id: string, headers: Record<string, string>) => app!.inject({ method: "GET", url: `/api/usage/viewers/${id}`, headers });

  it("names the member a usage id belongs to, for an admin", async () => {
    const admin = await signedIn("admin@client.example", "admin");
    const who = await signedIn("ops@client.example", "approver");
    const res = await lookup(opaque("tenant-a", who.id), admin.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({ member: { id: who.id, email: "ops@client.example", name: "Noa Cohen", role: "approver", status: "active" } });
    expect((await lookup(opaque("tenant-a", who.id).toUpperCase(), admin.headers)).json().member.id).toBe(who.id);
  });

  it("finds a removed member too, and says so", async () => {
    const admin = await signedIn("admin@client.example", "admin");
    const who = await signedIn("gone@client.example");
    await t!.db.update(users).set({ status: "removed" }).where(eq(users.id, who.id));
    expect((await lookup(opaque("tenant-a", who.id), admin.headers)).json().member).toMatchObject({ id: who.id, status: "removed" });
  });

  it("answers no member for an id of another tenant or nobody", async () => {
    const admin = await signedIn("admin@client.example", "admin");
    expect((await lookup(opaque("tenant-b", admin.id), admin.headers)).json()).toEqual({ member: null });
    expect((await lookup("0".repeat(32), admin.headers)).json()).toEqual({ member: null });
  });

  it("refuses anything but a usage id", async () => {
    const admin = await signedIn("admin@client.example", "admin");
    for (const id of ["abc", "g".repeat(32), "0".repeat(33)]) expect((await lookup(id, admin.headers)).statusCode).toBe(400);
  });

  it("refuses everyone but an admin", async () => {
    const who = await signedIn("ops@client.example", "approver");
    expect((await lookup(opaque("tenant-a", who.id), who.headers)).statusCode).toBe(403);
    expect((await lookup(opaque("tenant-a", who.id), {})).statusCode).toBe(401);
  });
});
