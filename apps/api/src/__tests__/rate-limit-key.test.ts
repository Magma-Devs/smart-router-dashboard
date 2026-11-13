import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { SignJWT } from "jose";
import { createTestDb, enrolledTwoFactor, type TestDb } from "@sr/db/testing";
import { users } from "@sr/db";
import { buildApp } from "../app.js";
import { config } from "../config.js";
import { ACCOUNTS_RATE_LIMIT_MAX, SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { createSession } from "../services/sessions.js";

/**
 * Whose allowance a request spends in the api's per-minute limits.
 *
 * The web asks `GET /api/account/me` from its own container on every page load,
 * to decide the two-factor gate before the page is drawn. Keyed on the
 * connection, those reads all came from the web pod, so every signed-in person
 * shared one bucket, and once a busy minute spent it each new page waited on
 * the browser's own read with nothing on screen.
 *
 * A call the web vouches for (`X-Internal-Auth`) now spends the reader's own
 * allowance. Everything else keys on the connection, exactly as before, and a
 * forwarded header without the secret changes nothing.
 *
 * Every request here comes from one connection (`inject` is always
 * 127.0.0.1), which is what the web pod looks like to the api.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const TOTP_KEY = "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=";
const INTERNAL = "internal-secret-for-tests";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36";

/** The limit a caller meets: with accounts on, two limiters count every
 *  request and the lower one refuses first. */
const LIMIT = Math.min(config.server.rateLimitMax, ACCOUNTS_RATE_LIMIT_MAX);
/** Past both limits, so either one still keyed on the connection would refuse. */
const PAST_BOTH = Math.max(config.server.rateLimitMax, ACCOUNTS_RATE_LIMIT_MAX) + 1;
/** What one reader sends in a case that must stay inside their own allowance. */
const EACH = Math.floor(LIMIT * 0.8);

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
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    DATABASE_URL: DEAD_DB,
    INTERNAL_AUTH_SECRET: INTERNAL,
  });
  app = await buildApp();
  app.db = t.db;
  // A case sends a few hundred requests; their access lines say nothing here.
  app.log.level = "warn";
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

let seq = 0;
/** A signed-in reader: an enrolled account, a live session, its Bearer. */
async function reader(): Promise<string> {
  const [user] = await t.db
    .insert(users)
    .values({ email: `reader+${++seq}@example.com`, name: "Dana Levi", role: "read_only", ...enrolledTwoFactor() })
    .returning();
  const session = await createSession(t.db, {
    userId: user!.id,
    authMethod: "password",
    client: { ip: "198.51.100.20", userAgent: UA },
  });
  return new SignJWT({ sub: user!.id, email: user!.email, role: "read_only", sid: session.id })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

/** What the web sends beside a page load's server-side read. With no proxy in
 *  front of the web it forwards the device and no address. */
function fromWeb(extra: Record<string, string> = {}): Record<string, string> {
  return { "x-internal-auth": INTERNAL, "x-forwarded-client-ua": UA, ...extra };
}

function readMe(token: string, headers: Record<string, string> = {}) {
  return app!.inject({
    method: "GET",
    url: "/api/account/me",
    headers: { authorization: `Bearer ${token}`, origin: "http://localhost:3000", ...headers },
  });
}

/** Status codes in order, so a failure says which request was refused. */
async function drive(n: number, send: (i: number) => Promise<LightMyRequestResponse>): Promise<number[]> {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await send(i)).statusCode);
  return codes;
}

describe("calls the web makes on a reader's behalf", () => {
  it("spend each reader's own allowance, so readers behind one web pod never exhaust each other", async () => {
    // Enough readers that together they are past both limits, each inside it.
    const tokens: string[] = [];
    while (tokens.length * EACH < PAST_BOTH) tokens.push(await reader());

    const codes: number[] = [];
    for (let i = 0; i < EACH; i++) {
      for (const token of tokens) codes.push((await readMe(token, fromWeb())).statusCode);
    }

    expect(codes.length).toBeGreaterThanOrEqual(PAST_BOTH);
    expect(codes.filter((c) => c !== 200)).toEqual([]);
  });

  it("key on the session, not on an address the web worked out", async () => {
    // Readers in one office share an address, and a hop count set too low
    // names the ingress for everybody. Neither decides whose allowance it is.
    const tokens = [await reader(), await reader()];
    const shared = fromWeb({ "x-forwarded-client-ip": "203.0.113.50" });

    const codes: number[] = [];
    for (let i = 0; i < EACH; i++) {
      for (const token of tokens) codes.push((await readMe(token, shared)).statusCode);
    }

    expect(codes.length).toBeGreaterThan(LIMIT);
    expect(codes.filter((c) => c !== 200)).toEqual([]);
  });

  it("still stop one reader who loads pages faster than the limit, and say when to come back", async () => {
    const token = await reader();

    const codes = await drive(LIMIT, () => readMe(token, fromWeb()));
    expect(codes.filter((c) => c !== 200)).toEqual([]);

    const over = await readMe(token, fromWeb());
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    // A cross-origin page can read it only if the api exposes it.
    expect(String(over.headers["access-control-expose-headers"]).toLowerCase()).toContain("retry-after");

    // Another reader behind the same pod is untouched.
    expect((await readMe(await reader(), fromWeb())).statusCode).toBe(200);
  });

  it("with no session, spend the visitor's forwarded address", async () => {
    const visit = (ip: string) =>
      app!.inject({ method: "GET", url: "/version", headers: fromWeb({ "x-forwarded-client-ip": ip }) });

    const codes: number[] = [];
    for (let i = 0; i < EACH; i++) {
      codes.push((await visit("198.51.100.7")).statusCode, (await visit("198.51.100.8")).statusCode);
    }
    expect(codes.length).toBeGreaterThan(LIMIT);
    expect(codes.filter((c) => c !== 200)).toEqual([]);
  });
});

describe("callers the web does not vouch for", () => {
  it("share their connection's allowance, signed in or not", async () => {
    const tokens = [await reader(), await reader()];

    const codes = await drive(LIMIT + 1, (i) => readMe(tokens[i % 2]!, { "user-agent": UA }));

    expect(codes.slice(0, LIMIT).filter((c) => c !== 200)).toEqual([]);
    expect(codes[LIMIT]).toBe(429);
  });

  it.each([
    ["without the internal secret", {}],
    ["with a wrong internal secret", { "x-internal-auth": "not-the-secret" }],
  ])("cannot pick a bucket with forwarded headers %s", async (_, auth: Record<string, string>) => {
    const tokens = [await reader(), await reader()];

    // A fresh forwarded address and device on every request: believed, each
    // would be a bucket of its own.
    const codes = await drive(LIMIT + 1, (i) =>
      readMe(tokens[i % 2]!, {
        ...auth,
        "x-forwarded-client-ip": `203.0.113.${i % 250}`,
        "x-forwarded-client-ua": `${UA} ${i}`,
      }),
    );

    expect(codes.slice(0, LIMIT).filter((c) => c !== 200)).toEqual([]);
    expect(codes[LIMIT]).toBe(429);
  });

  it("cannot pick a bucket on a public route either", async () => {
    const codes = await drive(LIMIT + 1, (i) =>
      app!.inject({
        method: "GET",
        url: "/version",
        headers: { "x-forwarded-client-ip": `203.0.113.${i % 250}`, "x-internal-auth": "not-the-secret" },
      }),
    );

    expect(codes.slice(0, LIMIT).filter((c) => c !== 200)).toEqual([]);
    expect(codes[LIMIT]).toBe(429);
  });
});
