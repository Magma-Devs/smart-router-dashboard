import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { mintAuditToken, revokeAuditToken, users } from "@sr/db";
import type { Role } from "@sr/shared";
import { buildApp } from "../app.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";
import type { LokiClient, LokiLine } from "../services/loki-client.js";
import { CrossValidationRecordsService } from "../services/cross-validation-records.js";

/**
 * GET /api/audit/cross-validation/records - MAG-2788.
 *
 * The ticket's access rules: "A caller with a valid token sees only their own
 * records, never another customer's. An expired or revoked token is
 * rejected." Own-records is the Loki credential's job (one org per deployment,
 * enforced by the store); what is tested here is everything this api decides.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const URL_ = "/api/audit/cross-validation/records";

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
});
afterEach(async () => {
  await app?.close();
  app = null;
  await t.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const RECORD = {
  time: "2026-11-17T10:00:00Z",
  seq: 7,
  requestId: "req-7",
  chainId: "ETH1",
  apiInterface: "jsonrpc",
  method: "eth_call",
  status: "success",
  endpoints: [{ providerAddress: "alchemy", outcome: "agreed" }],
};

/** A Loki holding one record, a minute and a half ago; `down` answers nothing. */
function lokiWithOneRecord(down = false): LokiClient {
  const ns = (BigInt(Date.now() - 90_000) * 1_000_000n).toString();
  const line = JSON.stringify({ level: "info", crossValidationRecord: RECORD, message: "cross-validation record" });
  return {
    async queryRangeNs(_q: string, start: string, end: string): Promise<LokiLine[] | null> {
      if (down) return null;
      return BigInt(ns) >= BigInt(start) && BigInt(ns) < BigInt(end)
        ? [{ tsMs: Number(ns) / 1e6, ns, line, labels: { service_name: "kraken-eth", pod: "router-0" } }]
        : [];
    },
    async volume() {
      return 0;
    },
  } as unknown as LokiClient;
}

async function buildAuthedApp(opts: { loki?: LokiClient | null } = {}): Promise<FastifyInstance> {
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    TOTP_ENCRYPTION_KEY: "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=",
    INTERNAL_AUTH_SECRET: "test-internal-secret-32-characters!",
    LOKI_URL: opts.loki === null ? undefined : "http://loki.test:3100",
  });
  const instance = await buildApp();
  instance.db = t.db;
  if (opts.loki !== null) {
    instance.crossValidationRecords = new CrossValidationRecordsService(opts.loki ?? lokiWithOneRecord(), '{component="router"}');
  }
  return instance;
}

let seq = 0;
async function signedIn(role: Role): Promise<string> {
  const [user] = await t.db
    .insert(users)
    .values({ ...enrolledTwoFactor(), email: `cv+${++seq}@example.com`, name: "Dana Levi", role })
    .returning();
  const session = await createSession(t.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "203.0.113.64", userAgent: "Chrome/141 (Macintosh)" },
  });
  return new SignJWT({ sub: user!.id, email: user!.email, role, sid: session.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function mint(expiresAt: Date | null = null): Promise<{ id: string; secret: string }> {
  const m = await mintAuditToken(t.db, { name: "compliance pull", createdBy: null, createdByName: "Dana", expiresAt });
  return { id: m.row.id, secret: m.secret };
}

describe("who may read the records", () => {
  it("an audit token reads them - the token an admin already mints for the audit pull", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint();
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(secret) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].record).toEqual(RECORD);
    expect(body.items[0].source).toEqual({ service: "kraken-eth", pod: "router-0" });
    expect(typeof body.cursor).toBe("string");
    expect(body.has_more).toBe(false);
  });

  it("a token with an expiry still ahead reads them", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint(new Date(Date.now() + 3600_000));
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(secret) });
    expect(res.statusCode).toBe(200);
  });

  it("an expired token is rejected", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint(new Date(Date.now() - 1000));
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(secret) });
    expect(res.statusCode).toBe(401);
  });

  it("a revoked token is rejected", async () => {
    app = await buildAuthedApp();
    const { id, secret } = await mint();
    await revokeAuditToken(t.db, { id, revokedBy: null, revokedByName: "Dana" });
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(secret) });
    expect(res.statusCode).toBe(401);
  });

  it("no credential is rejected", async () => {
    app = await buildAuthedApp();
    const res = await app.inject({ method: "GET", url: URL_ });
    expect(res.statusCode).toBe(401);
  });

  it("every signed-in role reads them, as every role reads the audit log", async () => {
    app = await buildAuthedApp();
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(await signedIn("read_only")) });
    expect(res.statusCode).toBe(200);
  });

  it("a token still reaches nothing outside /api/audit", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint();
    const res = await app.inject({ method: "GET", url: "/api/error-requests", headers: auth(secret) });
    expect(res.statusCode).toBe(403);
  });
});

describe("never an empty page that means something else", () => {
  it("503 when this dashboard does not read the router's logs", async () => {
    app = await buildAuthedApp({ loki: null });
    const { secret } = await mint();
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(secret) });
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/LOKI_URL/);
  });

  it("503 when Loki does not answer", async () => {
    app = await buildAuthedApp({ loki: lokiWithOneRecord(true) });
    const { secret } = await mint();
    const res = await app.inject({ method: "GET", url: URL_, headers: auth(secret) });
    expect(res.statusCode).toBe(503);
  });

  it("400 for a REST path as the method: the log pipeline masks paths before they are stored", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint();
    const res = await app.inject({
      method: "GET",
      url: `${URL_}?method=${encodeURIComponent("/cosmos/bank/v1beta1/balances/{address}")}`,
      headers: auth(secret),
    });
    expect(res.statusCode).toBe(400);
  });

  it("400 for times that can't be read, or that run backwards", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint();
    for (const qs of ["from=yesterday", "to=nope", "from=2026-11-17T10:00:00Z&to=2026-11-17T09:00:00Z"]) {
      const res = await app.inject({ method: "GET", url: `${URL_}?${qs}`, headers: auth(secret) });
      expect(res.statusCode, qs).toBe(400);
    }
  });

  it("400 for an outcome the router never writes", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint();
    const res = await app.inject({ method: "GET", url: `${URL_}?provider_outcome=dissented`, headers: auth(secret) });
    expect(res.statusCode).toBe(400);
  });

  it("400 for a cursor resumed under other filters or the other order - it would skip records silently", async () => {
    app = await buildAuthedApp();
    const { secret } = await mint();
    const first = await app.inject({ method: "GET", url: `${URL_}?chain=ETH1`, headers: auth(secret) });
    const cursor = first.json().cursor as string;

    const same = await app.inject({ method: "GET", url: `${URL_}?chain=ETH1&after=${cursor}`, headers: auth(secret) });
    expect(same.statusCode).toBe(200);
    expect(same.json().items).toHaveLength(0);

    const other = await app.inject({ method: "GET", url: `${URL_}?chain=SOLANA&after=${cursor}`, headers: auth(secret) });
    expect(other.statusCode).toBe(400);
    const flipped = await app.inject({ method: "GET", url: `${URL_}?chain=ETH1&order=desc&after=${cursor}`, headers: auth(secret) });
    expect(flipped.statusCode).toBe(400);
    const junk = await app.inject({ method: "GET", url: `${URL_}?after=bm90LWEtY3Vyc29y`, headers: auth(secret) });
    expect(junk.statusCode).toBe(400);
  });
});
