import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { exportJWK, exportPKCS8, generateKeyPair, importPKCS8, SignJWT, type JWTPayload } from "jose";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { auditEvents, sessions, users, type User } from "@sr/db";
import { buildApp } from "../app.js";
import { readDexConfig } from "../config.js";
import { SESSION_JWT_AUDIENCE, SESSION_JWT_ISSUER } from "../plugins/auth.js";
import { resetDexKeysForTests, verifyDexToken } from "../services/dex.js";
import { createInvitation } from "../services/invitations.js";
import { hashPassword } from "../services/password.js";
import { totpCodeAtStep, totpStepAt } from "../services/totp.js";
import { beginEnrolment, confirmEnrolment, resetTotpKeyForTests } from "../services/two-factor.js";

/**
 * Google and GitHub sign-in through the Dex broker (MAG-5238).
 *
 * Nothing is mocked above the network. Dex is played by a stubbed `fetch` that
 * serves a discovery document and a key set for a key pair made here, so every
 * token below goes through the real signature, issuer, audience and age checks
 * in `services/dex.ts` — the code that decides whether a brokered sign-in is
 * anybody at all.
 */

const ISSUER = "https://auth.example.com";
const CLIENT_ID = "sr-dashboard-acme";
const KID = "dex-key-1";
const GOOGLE_SUB = "110248495921238986420";
const GITHUB_ID = "5512345";

const SECRET = "test-secret-for-auth-tests-32-chars!";
const INTERNAL = "internal-secret-for-dex-tests";
const TOTP_KEY = Buffer.alloc(32, 7).toString("base64");
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";

const DEX_ENV = { DEX_ISSUER: ISSUER, DEX_CLIENT_ID: CLIENT_ID } as NodeJS.ProcessEnv;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let dexKeys: KeyPair;
let strangerKeys: KeyPair;

/** What the stubbed Dex serves. Tests swap a piece to break exactly one hop. */
const dex = {
  discovery: (): unknown => ({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` }),
  discoveryStatus: 200,
  /** Dex publishes `alg: RS256` on every key; a key set without it is where
   *  the api's own algorithm allowlist is the only thing left standing. */
  publishAlg: true,
  calls: [] as string[],
};

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

async function stubDex(): Promise<void> {
  const jwk = { ...(await exportJWK(dexKeys.publicKey)), kid: KID, use: "sig" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input);
      dex.calls.push(url);
      if (url === `${ISSUER}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify(dex.discovery()), {
          status: dex.discoveryStatus,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${ISSUER}/keys`) {
        const publicJwk = dex.publishAlg ? { ...jwk, alg: "RS256" } : jwk;
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not stubbed", { status: 404 });
    }),
  );
}

interface TokenOptions {
  claims?: Record<string, unknown>;
  /** Claims to drop from the defaults. */
  without?: string[];
  key?: KeyPair["privateKey"];
  iat?: number;
  exp?: number;
}

/** A token shaped like Dex's, for `connector`, signed with Dex's key unless told otherwise. */
async function dexToken(connector: "google" | "github" | string, opts: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const base: JWTPayload & Record<string, unknown> = {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: "CgVkZXgtdXNlchIGZ29vZ2xl",
    iat: opts.iat ?? now,
    exp: opts.exp ?? now + 3600,
    email: "dana@example.com",
    email_verified: true,
    name: "Dana Levi",
    federated_claims: {
      connector_id: connector,
      user_id: connector === "github" ? GITHUB_ID : GOOGLE_SUB,
    },
    ...opts.claims,
  };
  for (const k of opts.without ?? []) delete base[k];
  return new SignJWT(base)
    .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
    .sign(opts.key ?? dexKeys.privateKey);
}

beforeEach(async () => {
  dexKeys ??= await generateKeyPair("RS256", { extractable: true });
  strangerKeys ??= await generateKeyPair("RS256");
  dex.discovery = () => ({ issuer: ISSUER, jwks_uri: `${ISSUER}/keys` });
  dex.discoveryStatus = 200;
  dex.publishAlg = true;
  dex.calls = [];
  resetDexKeysForTests();
  await stubDex();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetDexKeysForTests();
});

describe("readDexConfig", () => {
  it("is off with neither half set", () => {
    expect(readDexConfig({})).toEqual({ state: "off" });
  });

  it("is on with both halves, keeping the issuer exactly as written", () => {
    expect(readDexConfig({ DEX_ISSUER: "https://auth.example.com/dex", DEX_CLIENT_ID: " sr-dashboard-acme " })).toEqual({
      state: "on",
      settings: { issuer: "https://auth.example.com/dex", clientId: "sr-dashboard-acme" },
    });
  });

  it.each([
    [{ DEX_ISSUER: ISSUER }, "without DEX_CLIENT_ID"],
    [{ DEX_CLIENT_ID: CLIENT_ID }, "without DEX_ISSUER"],
    [{ DEX_ISSUER: "auth.example.com", DEX_CLIENT_ID: CLIENT_ID }, "not a URL"],
    [{ DEX_ISSUER: "http://auth.example.com", DEX_CLIENT_ID: CLIENT_ID }, "https"],
    [{ DEX_ISSUER: "https://auth.example.com?x=1", DEX_CLIENT_ID: CLIENT_ID }, "query"],
    [{ DEX_ISSUER: "https://user:pw@auth.example.com", DEX_CLIENT_ID: CLIENT_ID }, "credentials"],
  ])("refuses %j (%s)", (env, problem) => {
    const result = readDexConfig(env);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.problem).toContain(problem);
  });

  it("allows plain http for a broker on this machine only", () => {
    expect(readDexConfig({ DEX_ISSUER: "http://localhost:5556/dex", DEX_CLIENT_ID: CLIENT_ID }).state).toBe("on");
    expect(readDexConfig({ DEX_ISSUER: "http://127.0.0.1:5556", DEX_CLIENT_ID: CLIENT_ID }).state).toBe("on");
  });
});

describe("verifyDexToken — what it accepts", () => {
  it("returns Google's subject as the google id", async () => {
    const result = await verifyDexToken(await dexToken("google"), DEX_ENV);
    expect(result).toEqual({
      provider: "google",
      profile: { providerId: GOOGLE_SUB, email: "dana@example.com", name: "Dana Levi", avatarUrl: null },
    });
  });

  it("returns GitHub's numeric id as the github id, with the avatar it addresses", async () => {
    const result = await verifyDexToken(await dexToken("github"), DEX_ENV);
    expect(result).toEqual({
      provider: "github",
      profile: {
        providerId: GITHUB_ID,
        email: "dana@example.com",
        name: "Dana Levi",
        avatarUrl: `https://avatars.githubusercontent.com/u/${GITHUB_ID}`,
      },
    });
  });

  it("accepts an audience list that includes this client", async () => {
    const token = await dexToken("google", { claims: { aud: [CLIENT_ID, "another"], azp: CLIENT_ID } });
    await expect(verifyDexToken(token, DEX_ENV)).resolves.toMatchObject({ provider: "google" });
  });

  it("drops an address the broker does not call verified, without refusing the token", async () => {
    const result = await verifyDexToken(await dexToken("google", { claims: { email_verified: false } }), DEX_ENV);
    expect(result.profile.email).toBeNull();
    const missing = await verifyDexToken(await dexToken("google", { without: ["email_verified"] }), DEX_ENV);
    expect(missing.profile.email).toBeNull();
  });

  it("reads discovery and the keys once, then serves later tokens from memory", async () => {
    await verifyDexToken(await dexToken("google"), DEX_ENV);
    await verifyDexToken(await dexToken("github"), DEX_ENV);
    expect(dex.calls.filter((u) => u.endsWith("/.well-known/openid-configuration"))).toHaveLength(1);
    expect(dex.calls.filter((u) => u.endsWith("/keys"))).toHaveLength(1);
  });

  it("retries a discovery that failed instead of failing every sign-in until a restart", async () => {
    dex.discoveryStatus = 503;
    await expect(verifyDexToken(await dexToken("google"), DEX_ENV)).rejects.toThrow(/503/);
    dex.discoveryStatus = 200;
    await expect(verifyDexToken(await dexToken("google"), DEX_ENV)).resolves.toMatchObject({ provider: "google" });
  });
});

describe("verifyDexToken — what it refuses", () => {
  const refused: Array<[string, () => Promise<string>, RegExp?]> = [
    ["another issuer", () => dexToken("google", { claims: { iss: "https://evil.example.com" } })],
    ["another tenant's audience", () => dexToken("google", { claims: { aud: "sr-dashboard-other" } })],
    [
      "an authorized party that is not this client",
      () => dexToken("google", { claims: { aud: [CLIENT_ID, "sr-dashboard-other"], azp: "sr-dashboard-other" } }),
      /another client/,
    ],
    ["an expired token", () => dexToken("google", { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 })],
    [
      "a token older than ten minutes, though Dex has not expired it",
      () => dexToken("google", { iat: Math.floor(Date.now() / 1000) - 11 * 60 }),
    ],
    ["a token with no issue time", () => dexToken("google", { without: ["iat"] })],
    ["a signature from a key that is not Dex's", () => dexToken("google", { key: strangerKeys.privateKey })],
    ["no federated_claims (the federated:id scope was not asked for)", () => dexToken("google", { without: ["federated_claims"] }), /federated_claims/],
    ["a connector this api does not know", () => dexToken("ldap"), /connector/],
    [
      "a GitHub login where the numeric id belongs",
      () => dexToken("github", { claims: { federated_claims: { connector_id: "github", user_id: "dana-levi" } } }),
      /numeric/,
    ],
    [
      "an empty federated user id",
      () => dexToken("google", { claims: { federated_claims: { connector_id: "google", user_id: "" } } }),
      /user id/,
    ],
  ];

  it.each(refused)("refuses %s", async (_name, make, message) => {
    await expect(verifyDexToken(await make(), DEX_ENV)).rejects.toThrow(message);
  });

  it("refuses an HMAC token, whatever key it claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 600,
      federated_claims: { connector_id: "google", user_id: GOOGLE_SUB },
    })
      .setProtectedHeader({ alg: "HS256", kid: KID })
      .sign(new TextEncoder().encode(CLIENT_ID));
    await expect(verifyDexToken(forged, DEX_ENV)).rejects.toThrow();
  });

  it("refuses an algorithm other than RS256 even from Dex's own key, when the key set does not pin one", async () => {
    dex.publishAlg = false;
    const now = Math.floor(Date.now() / 1000);
    // The same RSA key, put to RS384: a signature Dex's key really made, under
    // an algorithm Dex never uses.
    const rs384Key = await importPKCS8(await exportPKCS8(dexKeys.privateKey), "RS384");
    const other = await new SignJWT({
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: now,
      exp: now + 600,
      federated_claims: { connector_id: "google", user_id: GOOGLE_SUB },
    })
      .setProtectedHeader({ alg: "RS384", kid: KID })
      .sign(rs384Key);
    await expect(verifyDexToken(other, DEX_ENV)).rejects.toThrow(/alg/);
    // The same key set still verifies a real RS256 token.
    await expect(verifyDexToken(await dexToken("google"), DEX_ENV)).resolves.toMatchObject({ provider: "google" });
  });

  it("refuses everything while Dex is not configured, or only half of it", async () => {
    const token = await dexToken("google");
    await expect(verifyDexToken(token, {})).rejects.toThrow(/not configured/);
    await expect(verifyDexToken(token, { DEX_ISSUER: ISSUER })).rejects.toThrow(/not configured/);
    expect(dex.calls).toHaveLength(0);
  });

  it("refuses a discovery document that names a different issuer", async () => {
    dex.discovery = () => ({ issuer: "https://evil.example.com", jwks_uri: `${ISSUER}/keys` });
    await expect(verifyDexToken(await dexToken("google"), DEX_ENV)).rejects.toThrow(/different issuer/);
  });

  it("refuses a discovery document that points its keys at another origin", async () => {
    dex.discovery = () => ({ issuer: ISSUER, jwks_uri: "https://evil.example.com/keys" });
    await expect(verifyDexToken(await dexToken("google"), DEX_ENV)).rejects.toThrow(/origin/);
    expect(dex.calls).not.toContain("https://evil.example.com/keys");
  });
});

// ── Over HTTP: what the routes do with a brokered token ──────────────────────

let app: FastifyInstance | null = null;
let t: TestDb | null = null;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function start(env: Record<string, string | undefined> = DEX_ENV): Promise<FastifyInstance> {
  t = await createTestDb();
  resetTotpKeyForTests();
  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    INTERNAL_AUTH_SECRET: INTERNAL,
    TOTP_ENCRYPTION_KEY: TOTP_KEY,
    PASSWORD_BREACH_CHECK: "off",
    DEX_ISSUER: undefined,
    DEX_CLIENT_ID: undefined,
    ...env,
  });
  app = await buildApp();
  app.db = t.db;
  return app;
}

afterEach(async () => {
  await app?.close();
  app = null;
  await t?.close();
  t = null;
  resetTotpKeyForTests();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

async function seedUser(values: Partial<typeof users.$inferInsert> = {}): Promise<User> {
  const [created] = await t!.db
    .insert(users)
    .values({
      email: "dana@example.com",
      name: "Dana Levi",
      role: "read_only",
      passwordHash: await hashPassword("correct horse battery staple"),
      ...values,
    })
    .returning();
  return created!;
}

async function enrol(user: User): Promise<string> {
  const offer = await beginEnrolment(t!.db, user);
  const [pending] = await t!.db.select().from(users).where(eq(users.id, user.id));
  const outcome = await confirmEnrolment(t!.db, pending!, totpCodeAtStep(offer.secret, totpStepAt())!);
  expect(outcome.ok).toBe(true);
  return offer.secret;
}

const dexSignIn = (token: string) =>
  app!.inject({ method: "POST", url: "/auth/oauth/dex", payload: { token } });

describe("POST /auth/oauth/dex", () => {
  it("signs in an account linked to Google, and records Google — not the broker — as the way in", async () => {
    await start();
    const user = await seedUser({ googleId: GOOGLE_SUB, email: "someone-else@example.com" });

    const res = await dexSignIn(await dexToken("google"));

    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(user.id);
    const [session] = await t!.db.select().from(sessions);
    expect(session?.id).toBe(res.json().sessionId);
    expect(session?.authMethod).toBe("google");
    const actions = (await t!.db.select().from(auditEvents)).map((r) => r.action);
    expect(actions).toContain("signin.succeeded");
  });

  it("links GitHub to the account with the verified address, by its numeric id", async () => {
    await start();
    const user = await seedUser();

    const res = await dexSignIn(await dexToken("github"));

    expect(res.statusCode).toBe(200);
    const [after] = await t!.db.select().from(users).where(eq(users.id, user.id));
    expect(after?.githubId).toBe(GITHUB_ID);
    expect(after?.avatarUrl).toBe(`https://avatars.githubusercontent.com/u/${GITHUB_ID}`);
    const [session] = await t!.db.select().from(sessions);
    expect(session?.authMethod).toBe("github");
  });

  it("is the same account whichever way it came: linked directly, signed in through Dex", async () => {
    await start();
    const user = await seedUser({ githubId: GITHUB_ID });
    const res = await dexSignIn(await dexToken("github", { claims: { email: "changed@example.com" } }));
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(user.id);
  });

  it("creates nobody: an address with no account is told to ask for an invitation", async () => {
    await start();
    const res = await dexSignIn(await dexToken("google"));
    expect(res.statusCode).toBe(403);
    expect(await t!.db.select().from(users)).toHaveLength(0);
  });

  it("does not link by an address the broker did not call verified", async () => {
    await start();
    const user = await seedUser();
    const res = await dexSignIn(await dexToken("google", { claims: { email_verified: false } }));
    expect(res.statusCode).toBe(403);
    const [after] = await t!.db.select().from(users).where(eq(users.id, user.id));
    expect(after?.googleId).toBeNull();
  });

  it("asks an enrolled account for its code, opening no session until the code is right", async () => {
    await start();
    const user = await seedUser({ googleId: GOOGLE_SUB });
    const secret = await enrol(user);

    const first = await dexSignIn(await dexToken("google"));

    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      twoFactorRequired: true,
      challenge: expect.any(String),
      email: "dana@example.com",
      provider: "google",
    });
    expect(first.json().sessionId).toBeUndefined();
    expect(await t!.db.select().from(sessions)).toHaveLength(0);

    const wrong = await app!.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: first.json().challenge, code: "000000" },
    });
    expect(wrong.statusCode).toBe(401);
    expect(await t!.db.select().from(sessions)).toHaveLength(0);

    const second = await dexSignIn(await dexToken("google"));
    const done = await app!.inject({
      method: "POST",
      url: "/auth/2fa/verify",
      payload: { challenge: second.json().challenge, code: totpCodeAtStep(secret, totpStepAt() + 1)! },
    });
    expect(done.statusCode).toBe(200);
    const [session] = await t!.db.select().from(sessions);
    expect(session?.authMethod).toBe("google+totp");
  });

  it("keeps an unenrolled member out of the dashboard until they set up an authenticator", async () => {
    await start();
    const user = await seedUser({ googleId: GOOGLE_SUB });
    const res = await dexSignIn(await dexToken("google"));
    expect(res.statusCode).toBe(200);

    const bearer = await new SignJWT({ sub: user.id, email: user.email, role: user.role, sid: res.json().sessionId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(SESSION_JWT_ISSUER)
      .setAudience(SESSION_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const blocked = await app!.inject({
      method: "GET",
      url: "/api/metrics/specs",
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("TWO_FACTOR_REQUIRED");
  });

  it.each<[string, () => Promise<string>]>([
    ["another tenant's audience", () => dexToken("google", { claims: { aud: "sr-dashboard-other" } })],
    ["a key that is not Dex's", () => dexToken("google", { key: strangerKeys.privateKey })],
  ])("answers 401 and opens nothing for %s", async (_name, make) => {
    await start();
    await seedUser({ googleId: GOOGLE_SUB });
    const res = await dexSignIn(await make());
    expect(res.statusCode).toBe(401);
    expect(await t!.db.select().from(sessions)).toHaveLength(0);
  });

  it("answers 401 while the deployment has no Dex configured", async () => {
    await start({});
    await seedUser({ googleId: GOOGLE_SUB });
    const res = await dexSignIn(await dexToken("google"));
    expect(res.statusCode).toBe(401);
    expect(dex.calls).toHaveLength(0);
  });
});

describe("POST /auth/invite/accept through Dex", () => {
  async function invite(email = "dana@example.com"): Promise<string> {
    const admin = await seedUser({ email: "admin@example.com", role: "admin", name: "Admin" });
    const result = await createInvitation(t!.db, { email, role: "approver", createdBy: admin.id, mode: "onprem" });
    if (!result.ok) throw new Error(`could not invite: ${result.reason}`);
    return result.created.rawToken;
  }

  const accept = (payload: Record<string, unknown>) =>
    app!.inject({ method: "POST", url: "/auth/invite/accept", payload });

  it("creates the account with the invited address, links GitHub's id, and records GitHub", async () => {
    await start();
    const token = await invite();

    const res = await accept({ token, oauthProvider: "dex", oauthToken: await dexToken("github") });

    expect(res.statusCode).toBe(201);
    const [created] = await t!.db.select().from(users).where(eq(users.email, "dana@example.com"));
    expect(created?.githubId).toBe(GITHUB_ID);
    expect(created?.googleId).toBeNull();
    const [session] = await t!.db.select().from(sessions).where(eq(sessions.id, res.json().sessionId));
    expect(session?.authMethod).toBe("github");
  });

  it("refuses an address that is not the invited one, naming the one to use", async () => {
    await start();
    const token = await invite();

    const res = await accept({
      token,
      oauthProvider: "dex",
      oauthToken: await dexToken("google", { claims: { email: "dana.personal@example.com" } }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("dana@example.com");
    expect(await t!.db.select().from(users).where(eq(users.email, "dana.personal@example.com"))).toHaveLength(0);
  });

  it("refuses a redemption with no verified address", async () => {
    await start();
    const token = await invite();
    const res = await accept({
      token,
      oauthProvider: "dex",
      oauthToken: await dexToken("google", { claims: { email_verified: false } }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toBe("Google or GitHub sign-in could not be verified.");
  });

  it("refuses a token minted for another tenant's dashboard", async () => {
    await start();
    const token = await invite();
    const res = await accept({
      token,
      oauthProvider: "dex",
      oauthToken: await dexToken("google", { claims: { aud: "sr-dashboard-other" } }),
    });
    expect(res.statusCode).toBe(401);
  });
});
