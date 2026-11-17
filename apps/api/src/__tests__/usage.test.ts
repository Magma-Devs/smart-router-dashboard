import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { USAGE_VIEWS, type Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { readUsageSettings } from "../config.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { usageRoutes } from "../routes/usage.js";
import { createSession } from "../services/sessions.js";
import { toMixpanel, viewerOf } from "../services/usage.js";

/* Usage data (MAG-5373): the web's events go to POST /api/usage, and only what
   the catalog allows reaches Mixpanel, server side, tagged with the tenant.
   Only with accounts on, and only for a signed-in user. */

const VISIT = "3f2c9a1e-7b4d-4c3e-9a1f-0d2e5b6c7a8f";
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

let app: FastifyInstance | null = null;
let t: TestDb | null = null;
let sent: { url: string; body: unknown }[];

async function boot(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  sent = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/track")) sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("1", { status: 200 });
  });
  app = await buildApp();
  if (env.AUTH_MODE === "enabled") {
    t = await createTestDb();
    app.db = t.db;
  }
  await app.ready();
}

/** A session of a user with this address, as the web presents it. */
async function signedIn(email: string, role: Role = "read_only"): Promise<Record<string, string>> {
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
  return { authorization: `Bearer ${jwt}` };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const post = (body: unknown, headers: Record<string, string> = {}) =>
  app!.inject({ method: "POST", url: "/api/usage", payload: body as object, headers });
const get = (headers: Record<string, string> = {}) => app!.inject({ method: "GET", url: "/api/usage/config", headers });
const pageView = () => ({ visit: VISIT, events: [{ name: "page_view", at: Date.now(), seq: 0, props: { page: "metrics" } }] });

afterEach(async () => {
  await app?.close();
  app = null;
  await t?.close();
  t = null;
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("POST /api/usage on a deployment we host, accounts on", () => {
  beforeEach(() => boot({ ...ACCOUNTS, DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, TENANT_ID: "tenant-a", APP_VERSION: "0.69.9" }));

  it("says it is on, to a signed-in user", async () => {
    expect((await get(await signedIn("ops@client.example"))).json()).toEqual({ enabled: true });
  });

  it("refuses a caller with no session, and sends nothing", async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await post(pageView())).statusCode).toBe(401);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("forwards the catalog's fields to Mixpanel's EU track endpoint, tagged with the tenant and who sent it, without the client's address", async () => {
    const now = Date.now();
    const res = await post({
      visit: VISIT,
      events: [
        { name: "search", at: now, seq: 0, props: { kind: "hash", from: "top-bar", result: "found", seconds: 4.2, value: "0xabc", email: "a@b.c" } },
        { name: "password_typed", at: now, seq: 1, props: {} },
        { name: "tab_change", at: now, seq: 2, props: { from: "metrics", to: "errors" } },
      ],
    }, await signedIn("ops@client.example", "admin"));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2 });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api-eu.mixpanel.com/track?ip=0&strict=1");
    const [search, tab] = sent[0]!.body as { event: string; properties: Record<string, unknown> }[];
    expect(search).toEqual({
      event: "search",
      properties: expect.objectContaining({
        kind: "hash", from: "top-bar", result: "found", seconds: 4.2, token: TOKEN, distinct_id: VISIT,
        tenant: "tenant-a", deployment_mode: "managed", dashboard_version: "0.69.9", time: now, staff: false, role: "admin",
      }),
    });
    expect(search!.properties).not.toHaveProperty("value");
    expect(search!.properties).not.toHaveProperty("email");
    expect(JSON.stringify(sent[0]!.body)).not.toContain("client.example");
    expect(String(search!.properties.$insert_id)).toMatch(/^[0-9a-f]{32}$/);
    expect(tab!.event).toBe("tab_change");
  });

  it("marks anyone at magmadevs.com as staff", async () => {
    await post(pageView(), await signedIn("Someone@MagmaDevs.com"));
    await settle();
    const [e] = sent[0]!.body as { properties: Record<string, unknown> }[];
    expect(e!.properties).toMatchObject({ staff: true, role: "read_only" });
    expect(JSON.stringify(sent[0]!.body).toLowerCase()).not.toContain("magmadevs.com");
  });

  it("takes the api's time for a browser clock far off", async () => {
    await post({ visit: VISIT, events: [{ name: "load_older", at: 0, seq: 0, props: { list: "errors" } }] }, await signedIn("ops@client.example"));
    await settle();
    const time = (sent[0]!.body as { properties: { time: number } }[])[0]!.properties.time;
    expect(Math.abs(Date.now() - time)).toBeLessThan(5_000);
  });

  it("refuses a visit id that isn't random characters, and a batch over 50", async () => {
    const who = await signedIn("ops@client.example");
    expect((await post({ visit: "omer@example.com", events: [] }, who)).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({ name: "page_view", at: Date.now(), seq: i, props: {} }));
    expect((await post({ visit: VISIT, events: many }, who)).statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("where usage data is off", () => {
  it("with accounts off nothing is sent, hosted, switched on and with a token", async () => {
    await boot({ DEPLOYMENT_MODE: "managed", USAGE_ANALYTICS: "on", MIXPANEL_TOKEN: TOKEN });
    expect((await get()).json()).toEqual({ enabled: false });
    expect((await post(pageView())).statusCode).toBe(204);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("a self-hosted deployment sends nothing by default, accounts and token or not", async () => {
    await boot({ ...ACCOUNTS, DEPLOYMENT_MODE: "onprem", MIXPANEL_TOKEN: TOKEN });
    const who = await signedIn("ops@client.example");
    expect((await get(who)).json()).toEqual({ enabled: false });
    expect((await post(pageView(), who)).statusCode).toBe(204);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("a hosted deployment without a token sends nothing", async () => {
    await boot({ ...ACCOUNTS, DEPLOYMENT_MODE: "managed" });
    expect((await get(await signedIn("ops@client.example"))).json()).toEqual({ enabled: false });
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

describe("staff and role on each event", () => {
  const s = readUsageSettings({ AUTH_MODE: "enabled", DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, TENANT_ID: "t" });

  it("marks a signed-in user on our domain as staff, with the role, never the address", () => {
    const viewer = viewerOf({ email: "someone@magmadevs.com", role: "admin" }, s);
    expect(viewer).toEqual({ staff: true, role: "admin" });
    const [e] = toMixpanel(VISIT, [{ name: "page_view", at: Date.now(), seq: 0, props: { page: "metrics" } }], s, Date.now(), viewer);
    expect(e!.properties).toMatchObject({ staff: true, role: "admin" });
    expect(JSON.stringify(e)).not.toContain("magmadevs.com");
    expect(viewerOf({ email: "ops@client.example", role: "read_only" }, s)).toEqual({ staff: false, role: "read_only" });
  });

  it("is our domain exactly: not one that ends with it, not one that starts with it", () => {
    for (const email of ["a@notmagmadevs.com", "a@magmadevs.com.example", "a@sub.magmadevs.com", "magmadevs.com@client.example"]) {
      expect(viewerOf({ email, role: "admin" }, s)).toEqual({ staff: false, role: "admin" });
    }
  });

  it("is nobody without a signed-in user", () => {
    expect(viewerOf(null, s)).toBeNull();
  });
});

/** The route alone, with the caller the global gate would have put on the request. */
async function routeAlone(user: { email: string; role: string } | null, podBatchesPerMin?: number) {
  const forwarded: unknown[] = [];
  const fetchImpl = (async (_u: string, init?: RequestInit) => { forwarded.push(init?.body); return new Response("1"); }) as unknown as typeof fetch;
  const local = Fastify();
  local.decorateRequest("authUser", null);
  local.addHook("onRequest", async (request) => {
    (request as unknown as { authUser: unknown }).authUser = user;
  });
  await local.register(usageRoutes, {
    settings: readUsageSettings({ AUTH_MODE: "enabled", DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN }),
    fetchImpl,
    podBatchesPerMin,
  });
  return { local, forwarded };
}

describe("a batch with no signed-in user behind it", () => {
  it("is not forwarded, so no event is without its staff mark", async () => {
    const { local, forwarded } = await routeAlone(null);
    expect((await local.inject({ method: "POST", url: "/api/usage", payload: pageView() })).statusCode).toBe(204);
    await settle();
    expect(forwarded).toHaveLength(0);
    await local.close();
  });
});

describe("the process-wide cap on forwarded batches", () => {
  it("drops batches past the minute's budget, every caller together", async () => {
    const { local, forwarded } = await routeAlone({ email: "ops@client.example", role: "admin" }, 2);
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push((await local.inject({ method: "POST", url: "/api/usage", payload: pageView() })).json());
    await settle();
    expect(answers).toEqual([{ accepted: 1 }, { accepted: 1 }, { accepted: 0 }]);
    expect(forwarded).toHaveLength(2);
    await local.close();
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
