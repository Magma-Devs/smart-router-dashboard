/**
 * `POST /api/incidents` — a report from the dashboard to our on-call system.
 *
 * The values dir points at a temp mount BEFORE the app is imported, so the
 * chain and router checks run against a values file these tests control. IRM is
 * a stubbed `fetch`: every call to the webhook URL is recorded and answered by
 * `irmAnswer`.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { auditEvents, users, type User } from "@sr/db";
import type { Role } from "@sr/shared";

const VALUES = `
routers:
  - id: "eth-prod"
    network: "eth1"
    nodes:
      - name: "eth-publicnode"
        endpoints:
          - url: "https://ethereum-rpc.publicnode.com"
            interface: "jsonrpc"
  - id: "sol-main"
    network: "solana"
    nodes:
      - name: "sol-publicnode"
        endpoints:
          - url: "https://solana-rpc.publicnode.com"
            interface: "jsonrpc"
`;

const dir = mkdtempSync(join(tmpdir(), "srdash-incidents-"));
mkdirSync(join(dir, "core"), { recursive: true });
writeFileSync(join(dir, "core", "values.yml"), VALUES);
process.env.HELM_VALUES_DIR = dir;

const { buildApp } = await import("../app.js");
const { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } = await import("../plugins/auth.js");
const { createSession } = await import("../services/sessions.js");

const WEBHOOK = "https://oncall.example/integrations/v1/formatted_webhook/SECRETID/";
const ID = "3f2b6c1e-8a4d-4f0e-9b7a-2c5d8e1f4a6b";
const SECRET = "test-secret-for-auth-tests-32-chars!";

let app: FastifyInstance | null = null;
const savedEnv: Record<string, string | undefined> = {};
let irmCalls: Array<Record<string, unknown>> = [];
let irmAnswer: () => Promise<Response> = async () => new Response("Ok.", { status: 200 });

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  irmCalls = [];
  irmAnswer = async () => new Response("Ok.", { status: 200 });
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === WEBHOOK) {
      irmCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return irmAnswer();
    }
    return new Response(JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(async () => {
  await app?.close();
  app = null;
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function openApp(env: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  setEnv({ AUTH_MODE: "disabled", INCIDENTS_ENABLED: "true", INCIDENT_WEBHOOK_URL: WEBHOOK, ...env });
  app = await buildApp();
  await app.ready();
  return app;
}

const report = (over: Record<string, unknown> = {}) => ({
  id: ID,
  severity: "high",
  title: "ETH reads failing",
  description: "Half our eth_call requests return 502 since 14:00.",
  reporter: { name: "Dana Levi", email: "dana@example.com", phone: "+972 50 000 0000" },
  ...over,
});

function post(instance: FastifyInstance, payload: unknown, headers: Record<string, string> = {}) {
  return instance.inject({ method: "POST", url: "/api/incidents", payload: payload as object, headers });
}

function ethSpec(instance: FastifyInstance): string {
  const spec = instance.routerConfig.getRouters().find((r) => r.id === "eth-prod")?.spec;
  if (!spec) throw new Error("fixture router eth-prod not parsed");
  return spec;
}

describe("POST /api/incidents — switched off", () => {
  it("is off by default: 404, and nothing is sent", async () => {
    const a = await openApp({ INCIDENTS_ENABLED: undefined });
    const res = await post(a, report());
    expect(res.statusCode).toBe(404);
    expect(irmCalls).toHaveLength(0);
  });

  /** On, but nowhere to send: the dashboard keeps running and says so. */
  it("answers 503 when switched on without a webhook", async () => {
    const a = await openApp({ INCIDENT_WEBHOOK_URL: undefined });
    const res = await post(a, report());
    expect(res.statusCode).toBe(503);
    expect(irmCalls).toHaveLength(0);
  });
});

describe("POST /api/incidents — AUTH_MODE=disabled", () => {
  it("sends the report and answers with its id once IRM accepts it", async () => {
    const a = await openApp();
    const spec = ethSpec(a);
    const res = await post(a, report({ chain: spec, routerId: "eth-prod" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ID, severity: "high" });
    expect(Date.parse(res.json<{ sentAt: string }>().sentAt)).not.toBeNaN();

    expect(irmCalls).toHaveLength(1);
    expect(irmCalls[0]).toMatchObject({
      alert_uid: `report-${ID}`,
      title: "[High] ETH reads failing",
      state: "alerting",
      severity: "high",
      incident_id: ID,
      chain: spec,
      router_id: "eth-prod",
      reporter: { name: "Dana Levi", email: "dana@example.com", phone: "+972 50 000 0000", signed_in: false, role: null },
    });
    expect(irmCalls[0]).not.toHaveProperty("link_to_upstream_details");
  });

  it("files every Critical in one hour under one key, so the rota is called once", async () => {
    const a = await openApp();
    await post(a, report({ severity: "critical" }), { "cf-connecting-ip": "203.0.113.1" });
    await post(a, report({ severity: "critical", id: "9a1e0b2c-3d4f-4a5b-8c6d-7e8f9a0b1c2d" }), { "cf-connecting-ip": "203.0.113.2" });
    expect(irmCalls).toHaveLength(2);
    expect(irmCalls[0]!.alert_uid).toMatch(/^critical-\d{4}-\d{2}-\d{2}T\d{2}$/);
    expect(irmCalls[1]!.alert_uid).toBe(irmCalls[0]!.alert_uid);
  });

  it("requires a name and a complete email address", async () => {
    const a = await openApp({ INCIDENT_RATE_LIMIT_MAX: "50" });
    expect((await post(a, report({ reporter: undefined }))).statusCode).toBe(400);
    expect((await post(a, report({ reporter: { name: "Dana", email: "dana@nowhere" } }))).statusCode).toBe(400);
    expect((await post(a, report({ reporter: { name: " \u0007 ", email: "dana@example.com" } }))).statusCode).toBe(400);
    expect(irmCalls).toHaveLength(0);
  });

  it("refuses a malformed id, an unknown severity and an empty title", async () => {
    const a = await openApp({ INCIDENT_RATE_LIMIT_MAX: "50" });
    expect((await post(a, report({ id: "not-a-uuid" }))).statusCode).toBe(400);
    expect((await post(a, report({ severity: "urgent" }))).statusCode).toBe(400);
    expect((await post(a, report({ title: "\u0000\u001b" }))).statusCode).toBe(400);
    expect((await post(a, report({ title: "x".repeat(121) }))).statusCode).toBe(400);
    expect(irmCalls).toHaveLength(0);
  });

  /** The on-call would go looking for something this deployment does not run. */
  it("refuses a chain or router the values file does not declare", async () => {
    const a = await openApp({ INCIDENT_RATE_LIMIT_MAX: "50" });
    expect((await post(a, report({ chain: "NOPE1" }))).statusCode).toBe(400);
    expect((await post(a, report({ routerId: "eth-staging" }))).statusCode).toBe(400);
    expect((await post(a, report({ chain: "<!channel>" }))).statusCode).toBe(400);
    expect(irmCalls).toHaveLength(0);
  });

  it("answers 502, not 200, when IRM refuses or cannot be reached", async () => {
    const a = await openApp();
    irmAnswer = async () => new Response("rate limited", { status: 429 });
    const refused = await post(a, report(), { "cf-connecting-ip": "203.0.113.1" });
    expect(refused.statusCode).toBe(502);
    expect(refused.body).not.toContain("SECRETID");

    irmAnswer = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await post(a, report(), { "cf-connecting-ip": "203.0.113.2" })).statusCode).toBe(502);
  });

  it("limits each caller by the address Cloudflare saw", async () => {
    const a = await openApp({ INCIDENT_RATE_LIMIT_MAX: "2" });
    const from = (ip: string) => ({ "cf-connecting-ip": ip });
    expect((await post(a, report(), from("203.0.113.7"))).statusCode).toBe(200);
    expect((await post(a, report(), from("203.0.113.7"))).statusCode).toBe(200);
    expect((await post(a, report(), from("203.0.113.7"))).statusCode).toBe(429);
    // Someone else behind the same node is not locked out by it.
    expect((await post(a, report(), from("198.51.100.4"))).statusCode).toBe(200);
  });

  /** IRM's organisation budget is the one fleet alerts are delivered on. */
  it("caps what one process sends from every caller together", async () => {
    const a = await openApp({ INCIDENT_POD_MAX: "2" });
    expect((await post(a, report(), { "cf-connecting-ip": "203.0.113.1" })).statusCode).toBe(200);
    expect((await post(a, report(), { "cf-connecting-ip": "203.0.113.2" })).statusCode).toBe(200);
    const third = await post(a, report(), { "cf-connecting-ip": "203.0.113.3" });
    expect(third.statusCode).toBe(429);
    expect(irmCalls).toHaveLength(2);
  });
});

describe("POST /api/incidents — AUTH_MODE=enabled", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  async function openAuthedApp(): Promise<FastifyInstance> {
    setEnv({
      AUTH_MODE: "enabled",
      AUTH_SECRET: SECRET,
      DATABASE_URL: "postgres://sr:x@192.0.2.1:5432/na",
      TOTP_ENCRYPTION_KEY: "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=",
      INTERNAL_AUTH_SECRET: "test-internal-secret-32-characters!",
      INCIDENTS_ENABLED: "true",
      INCIDENT_WEBHOOK_URL: WEBHOOK,
    });
    app = await buildApp();
    app.db = t.db;
    await app.ready();
    return app;
  }

  async function signedIn(role: Role): Promise<{ user: User; token: string }> {
    const [user] = await t.db
      .insert(users)
      .values({ ...enrolledTwoFactor(), email: "ops@customer.example", name: "Noa Cohen", role })
      .returning();
    const session = await createSession(t.db, {
      userId: user!.id,
      authMethod: "password",
      client: { ip: "84.229.11.6", userAgent: "Chrome/141 (Macintosh)" },
    });
    const token = await new SignJWT({ sub: user!.id, email: user!.email, role, sid: session.id })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(SESSION_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    return { user: user!, token };
  }

  it("refuses a caller with no session", async () => {
    const a = await openAuthedApp();
    const res = await post(a, report());
    expect(res.statusCode).toBe(401);
    expect(irmCalls).toHaveLength(0);
  });

  /** Any role may report, and who reported is the account, not the body. */
  it("reports as the signed-in user, whatever the body says", async () => {
    const a = await openAuthedApp();
    const { token } = await signedIn("read_only");
    const res = await post(a, report({ reporter: { name: "Somebody Else", email: "else@example.com" } }), {
      authorization: `Bearer ${token}`,
    });
    expect(res.statusCode).toBe(200);
    expect(irmCalls[0]).toMatchObject({
      reporter: { name: "Noa Cohen", email: "ops@customer.example", phone: null, signed_in: true, role: "read_only" },
    });
  });

  it("needs no reporter in the body", async () => {
    const a = await openAuthedApp();
    const { token } = await signedIn("admin");
    const res = await post(a, report({ reporter: undefined }), { authorization: `Bearer ${token}` });
    expect(res.statusCode).toBe(200);
  });

  it("records incident.reported once IRM accepted it, and not before", async () => {
    const a = await openAuthedApp();
    const { user, token } = await signedIn("requester");

    irmAnswer = async () => new Response("down", { status: 503 });
    expect((await post(a, report(), { authorization: `Bearer ${token}` })).statusCode).toBe(502);
    const none = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "incident.reported"));
    expect(none).toHaveLength(0);

    irmAnswer = async () => new Response("Ok.", { status: 200 });
    expect((await post(a, report({ severity: "critical" }), { authorization: `Bearer ${token}` })).statusCode).toBe(200);
    const rows = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "incident.reported"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionGroup: "incidents",
      actorUserId: user.id,
      targetType: "incident",
      targetId: ID,
      targetName: "ETH reads failing",
      note: "Critical",
    });
  });
});
