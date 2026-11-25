import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { auditEventChanges, auditEvents, customerNames, users } from "@sr/db";
import { CUSTOMER_REQUESTS_24H, customerRoutes } from "../routes/customers.js";
import { authPlugin, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import { readCustomerNames } from "../services/customer-names.js";

const SECRET = "customer-names-secret-with-at-least-32-chars";
const BUSY = "a1".repeat(32);
const QUIET = "b2".repeat(32);
const SLASHED = "team/eu+prod";

let app: FastifyInstance;
let t: TestDb;
/** What the store answers for the counted ids; null is a store that does not answer. */
let counted: { customer: string; requests: number }[] | null;
let queries: string[];

beforeEach(async () => {
  vi.stubEnv("AUTH_MODE", "enabled");
  vi.stubEnv("AUTH_SECRET", SECRET);
  vi.stubEnv("INTERNAL_AUTH_SECRET", "customer-names-internal-secret");
  vi.stubEnv("TOTP_ENCRYPTION_KEY", "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=");
  t = await createTestDb();
  counted = [
    { customer: BUSY, requests: 1200 },
    { customer: QUIET, requests: 30 },
    { customer: SLASHED, requests: 7 },
  ];
  queries = [];
  app = Fastify();
  app.decorate("db", t.db);
  app.decorate("prom", {
    queryAtOrNull: async (query: string) => {
      queries.push(query);
      return (
        counted?.map(({ customer, requests }) => ({
          metric: { customer },
          value: [0, String(requests)],
        })) ?? null
      );
    },
  } as never);
  await app.register(authPlugin);
  await app.register(customerRoutes);
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
    client: { ip: "127.0.0.1", userAgent: "customer names tests" },
  });
  const token = await new SignJWT({ sub: user!.id, sid: session.id, role, email: user!.email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
  return { id: user!.id, headers: { authorization: `Bearer ${token}` } };
}

const name = (headers: Record<string, string>, customer: unknown, value: unknown) =>
  app.inject({
    method: "POST",
    url: "/api/customers/name",
    headers,
    payload: { customer, name: value },
  });

describe("customer names", () => {
  it("lists the counted ids busiest first, with their names", async () => {
    const admin = await signedIn("admin");
    expect((await name(admin.headers, QUIET, "  Beta   Wallet ")).json()).toEqual({
      customer: QUIET,
      name: "Beta Wallet",
    });
    const member = await signedIn();
    const list = await app.inject({ url: "/api/customers", headers: member.headers });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.window).toBe("24h");
    expect(body.requestsUnavailable).toBe(false);
    expect(body.customers.map((c: { id: string }) => c.id)).toEqual([BUSY, QUIET, SLASHED]);
    expect(body.customers[1]).toMatchObject({ name: "Beta Wallet", requests: 30 });
    expect(body.customers[0]).toMatchObject({ name: null, changedAt: null });
    expect(queries[0]).toBe(CUSTOMER_REQUESTS_24H);
    expect(CUSTOMER_REQUESTS_24H).toContain('customer!~"DefaultDappID|other|magma-serving-probe"');
    expect(
      (await app.inject({ url: "/api/customers/names", headers: member.headers })).json(),
    ).toEqual({ names: { [QUIET]: "Beta Wallet" } });
  });

  it("still lists the named ids, without counts, when the store does not answer", async () => {
    const admin = await signedIn("admin");
    await name(admin.headers, BUSY, "Acme");
    counted = null;
    const body = (await app.inject({ url: "/api/customers", headers: admin.headers })).json();
    expect(body.requestsUnavailable).toBe(true);
    expect(body.customers).toEqual([
      expect.objectContaining({ id: BUSY, name: "Acme", requests: null }),
    ]);
  });

  it("is an admin's to change: a member reads and cannot write", async () => {
    const member = await signedIn();
    expect((await name(member.headers, BUSY, "Acme")).statusCode).toBe(403);
    expect(await readCustomerNames(t.db)).toEqual(new Map());
    expect((await app.inject({ url: "/api/customers" })).statusCode).toBe(401);
  });

  it("takes an id holding a slash in the body", async () => {
    const admin = await signedIn("admin");
    expect((await name(admin.headers, SLASHED, "Team EU")).statusCode).toBe(200);
    expect(await readCustomerNames(t.db)).toEqual(new Map([[SLASHED, "Team EU"]]));
  });

  it("renames and clears, one audit row per change and none for a no-op", async () => {
    const admin = await signedIn("admin");
    await name(admin.headers, BUSY, "Acme");
    await name(admin.headers, BUSY, "Acme");
    await name(admin.headers, BUSY, "Acme Pay");
    expect((await name(admin.headers, BUSY, null)).json()).toEqual({ customer: BUSY, name: null });
    await name(admin.headers, BUSY, null);
    expect(await readCustomerNames(t.db)).toEqual(new Map());
    const rows = await t.db
      .select({
        action: auditEvents.action,
        field: auditEventChanges.field,
        from: auditEventChanges.fromValue,
        to: auditEventChanges.toValue,
        target: auditEvents.targetId,
        actor: auditEvents.actorUserId,
      })
      .from(auditEvents)
      .innerJoin(auditEventChanges, eq(auditEventChanges.eventSeq, auditEvents.seq))
      .where(eq(auditEvents.targetType, "customer"))
      .orderBy(auditEvents.occurredAt);
    expect(rows.map(({ action, from, to }) => [action, from, to])).toEqual([
      ["customer.named", "(none)", "Acme"],
      ["customer.named", "Acme", "Acme Pay"],
      ["customer.name_cleared", "Acme Pay", "(none)"],
    ]);
    expect(rows.every((r) => r.target === BUSY && r.actor === admin.id && r.field === "name")).toBe(
      true,
    );
  });

  it("refuses a name another id holds, in any case", async () => {
    const admin = await signedIn("admin");
    await name(admin.headers, BUSY, "Acme");
    const clash = await name(admin.headers, QUIET, "  ACME ");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().message).toContain("already named");
    expect(await readCustomerNames(t.db)).toEqual(new Map([[BUSY, "Acme"]]));
  });

  it("refuses a name that is a counted or named customer-id, since Ask reads ids first", async () => {
    const admin = await signedIn("admin");
    const counted = await name(admin.headers, BUSY, SLASHED.toUpperCase());
    expect(counted.statusCode).toBe(409);
    expect(counted.json().message).toContain("is a customer-id itself");
    await t.db.insert(customerNames).values({ customer: "named-only", name: "Gamma" });
    expect((await name(admin.headers, BUSY, "Named-Only")).statusCode).toBe(409);
    // An id may carry its own value as its name.
    expect((await name(admin.headers, SLASHED, SLASHED)).statusCode).toBe(200);
  });

  it.each([
    ["a reserved value", "DefaultDappID", "Acme"],
    ["an id longer than the router counts", "x".repeat(129), "Acme"],
    ["a missing id", undefined, "Acme"],
    ["a name with a table bar", BUSY, "Acme | Pay"],
    ["a name past the cap", BUSY, "a".repeat(65)],
    ["a name that is a reserved value", BUSY, "other"],
    ["a name that is not text", BUSY, 5],
  ])("refuses %s", async (_, customer, value) => {
    const admin = await signedIn("admin");
    expect((await name(admin.headers, customer, value)).statusCode).toBe(400);
    expect(await readCustomerNames(t.db)).toEqual(new Map());
  });

  it("answers 503 until the database is ready", async () => {
    const bare = Fastify();
    bare.decorate("db", undefined as never);
    bare.decorateRequest("authUser", null as never);
    bare.addHook("onRequest", async (request) => {
      (request as { authUser: unknown }).authUser = { id: "x", role: "admin" };
    });
    await bare.register(customerRoutes);
    expect((await bare.inject({ url: "/api/customers/names" })).statusCode).toBe(503);
    await bare.close();
  });
});
