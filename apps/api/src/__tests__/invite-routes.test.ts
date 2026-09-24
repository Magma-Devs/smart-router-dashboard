import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { sessions, users, type User } from "@sr/db";
import { buildApp } from "../app.js";
import { createInvitation } from "../services/invitations.js";

/**
 * Invitation redemption over HTTP.
 *
 * The service-level cases live in `invitations.test.ts`. What is pinned here is
 * everything the route decides on top of them: which paths open a session,
 * whether a dead link is distinguishable from an invented one, and the Google
 * branch — which had no caller and no coverage at all until the web was wired
 * to it.
 */

const SECRET = "test-secret-for-auth-tests-32-chars!";
const DEAD_DB = "postgres://sr:x@192.0.2.1:5432/na";
const GOOGLE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const GOOD_PASSWORD = "correct horse battery staple";
const INTERNAL = "internal-secret-for-invite-tests";
const FIREFOX =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";

let app: FastifyInstance | null = null;
let t: TestDb;
let admin: User;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * The provider itself is stubbed at the module boundary rather than at the
 * network: `verifyGoogle` compares the token's audience against
 * `config.auth.googleClientId`, and `config` snapshots the environment at
 * import time — before any `beforeEach` can set it. Token verification is
 * `services/oauth.ts`'s business in any case; what is under test here is what
 * the route does with a verified identity.
 */
const oauth = vi.hoisted(() => ({ email: "dana@example.com", verified: true }));

vi.mock("../services/oauth.js", () => ({
  verifyOAuthToken: async (provider: string) => ({
    providerId: `${provider}-subject-123`,
    email: oauth.verified ? oauth.email : null,
    name: "Dana Levi",
    avatarUrl: null,
  }),
}));

function stubOAuth(email: string, verified = true): void {
  oauth.email = email;
  oauth.verified = verified;
}

beforeEach(async () => {
  t = await createTestDb();
  const [created] = await t.db
    .insert(users)
    .values({ email: "admin@example.com", role: "admin", name: "Admin" })
    .returning();
  admin = created!;

  setEnv({
    AUTH_MODE: "enabled",
    AUTH_SECRET: SECRET,
    DATABASE_URL: DEAD_DB,
    GOOGLE_CLIENT_ID,
    PASSWORD_BREACH_CHECK: "off",
    INTERNAL_AUTH_SECRET: INTERNAL,
  });
  app = await buildApp();
  app.db = t.db;
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

async function freshInvite(email = "dana@example.com"): Promise<string> {
  const result = await createInvitation(t.db, {
    email,
    role: "approver",
    createdBy: admin.id,
    mode: "onprem",
  });
  if (!result.ok) throw new Error(`could not invite: ${result.reason}`);
  return result.created.rawToken;
}

const accept = (payload: Record<string, unknown>) =>
  app!.inject({ method: "POST", url: "/auth/invite/accept", payload });

const preview = (token: string) =>
  app!.inject({ method: "POST", url: "/auth/invite/preview", payload: { token } });

describe("POST /auth/invite/accept — password", () => {
  it("creates the account with the invited address", async () => {
    const token = await freshInvite();
    const res = await accept({ token, password: GOOD_PASSWORD, name: "Dana" });

    expect(res.statusCode).toBe(201);
    expect(res.json().user.email).toBe("dana@example.com");
    expect(res.json().user.role).toBe("approver");
  });

  it("opens no session — the web signs in on the credentials path straight after", async () => {
    // The stray-row case: a session minted here is one nobody ever presents,
    // because the browser is about to sign in with the password it just chose.
    const token = await freshInvite();
    const res = await accept({ token, password: GOOD_PASSWORD });

    expect(res.statusCode).toBe(201);
    expect(res.json().sessionId).toBeUndefined();
    expect(await t.db.select().from(sessions)).toHaveLength(0);
  });

  it("applies the password policy", async () => {
    const token = await freshInvite();
    const res = await accept({ token, password: "short" });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/at least 8/);
  });

  it("refuses with neither a password nor Google", async () => {
    const token = await freshInvite();
    expect((await accept({ token })).statusCode).toBe(400);
  });
});

describe("POST /auth/invite/accept — social", () => {
  // Every provider the deployment offers, not just Google. OAuth sign-in is
  // link-only, so redemption is the ONLY way a social account comes to exist:
  // a provider missing from this route is a provider nobody can ever sign in
  // with. Google-only coverage is exactly what let that gap through once.
  it.each([
    ["google", "googleId"],
    ["github", "githubId"],
  ] as const)("redeems with %s and links the provider id", async (provider, column) => {
    const token = await freshInvite();
    stubOAuth("dana@example.com");

    const res = await accept({ token, oauthProvider: provider, oauthToken: "a-token" });
    expect(res.statusCode).toBe(201);
    expect(res.json().sessionId).toBeTruthy();

    const [account] = await t.db.select().from(users).where(eq(users.email, "dana@example.com"));
    expect(account?.[column]).toBe(`${provider}-subject-123`);

    const rows = await t.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authMethod).toBe(provider);
  });

  it("refuses a token with no provider named", async () => {
    const token = await freshInvite();
    const res = await accept({ token, oauthToken: "a-token" });
    expect(res.statusCode).toBe(400);
  });

  it("refuses Discord, which is not a way in any more", async () => {
    // Email and password, Google and GitHub are the ways in. Refused at the
    // schema, before any token is sent anywhere, and the invitation stays live.
    const token = await freshInvite();
    stubOAuth("dana@example.com");
    const res = await accept({ token, oauthProvider: "discord", oauthToken: "a-token" });
    expect(res.statusCode).toBe(400);
    expect(await t.db.select().from(users).where(eq(users.email, "dana@example.com"))).toHaveLength(0);
  });

  it("creates the account and opens the session, because there is no second sign-in to fall back on", async () => {
    // The web reaches this through Auth.js, holding a one-shot id_token rather
    // than a password: it cannot start the round-trip again, so the session has
    // to come from here.
    const token = await freshInvite();
    stubOAuth("dana@example.com");

    const res = await accept({ token, oauthProvider: "google", oauthToken: "an-id-token" });
    expect(res.statusCode).toBe(201);

    const sessionId = res.json().sessionId as string;
    expect(sessionId).toBeTruthy();
    const rows = await t.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.authMethod).toBe("google");

    // And the provider is linked, so the next plain Google sign-in resolves.
    const [account] = await t.db.select().from(users).where(eq(users.email, "dana@example.com"));
    expect(account?.googleId).toBe("google-subject-123");
  });

  it("records the person's device, not the web server's, and logs the sign-in", async () => {
    // Auth.js makes this call from the web tier, so the api itself sees the
    // web pod and undici. The web forwards what the browser sent, as it does
    // for a plain sign-in, and the session opened here is a sign-in.
    const token = await freshInvite();
    stubOAuth("dana@example.com");

    const res = await app!.inject({
      method: "POST",
      url: "/auth/invite/accept",
      remoteAddress: "10.0.0.9",
      headers: { "user-agent": "undici", "x-internal-auth": INTERNAL },
      payload: {
        token,
        oauthProvider: "google",
        oauthToken: "an-id-token",
        clientContext: { ip: "84.229.11.6", userAgent: FIREFOX },
      },
    });
    expect(res.statusCode).toBe(201);

    const sessionId = res.json().sessionId as string;
    const [session] = await t.db.select().from(sessions);
    expect(session?.client).toBe("Firefox 131 / Windows");
    const rows = await t.db.execute<{ action: string; ip: string; client: string; session_id: string }>(
      sql`select action, host(ip) as ip, client, session_id from audit_events order by seq`,
    );
    const context = { ip: "84.229.11.6", client: "Firefox 131 / Windows", session_id: sessionId };
    expect(rows.rows).toEqual([
      { action: "invite.redeemed", ...context },
      { action: "signin.succeeded", ...context },
    ]);
  });

  it("refuses a Google account that is not the invited address", async () => {
    const token = await freshInvite("dana@example.com");
    stubOAuth("someone.else@example.com");

    const res = await accept({ token, oauthProvider: "google", oauthToken: "an-id-token" });
    expect(res.statusCode).toBe(403);
    // Named on purpose: the holder already has the link, and an honest person
    // who picked the wrong Google account needs to know which one to use.
    expect(res.json().message).toContain("dana@example.com");
    expect(await t.db.select().from(sessions)).toHaveLength(0);
  });

  it("refuses a provider account with no verified address", async () => {
    const token = await freshInvite();
    stubOAuth("dana@example.com", false);
    expect(
      (await accept({ token, oauthProvider: "github", oauthToken: "an-access-token" })).statusCode,
    ).toBe(401);
  });
});

describe("POST /auth/oauth/:provider", () => {
  it("refuses Discord at the schema — Google and GitHub are the social ways in", async () => {
    stubOAuth("dana@example.com");
    const res = await app!.inject({
      method: "POST",
      url: "/auth/oauth/discord",
      payload: { token: "a-token" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("a dead invitation is one answer, not four", () => {
  // The message was always uniform. The status was not — 404 for an invented
  // token and 410 for a real-but-dead one told a stranger precisely what the
  // uniform message was there to withhold.
  it("answers 410 for a token that never existed", async () => {
    expect((await preview("never-minted-anywhere")).statusCode).toBe(410);
    expect((await accept({ token: "never-minted-anywhere", password: GOOD_PASSWORD })).statusCode).toBe(410);
  });

  it("answers 410 for a token that has been used", async () => {
    const token = await freshInvite();
    expect((await accept({ token, password: GOOD_PASSWORD })).statusCode).toBe(201);

    expect((await preview(token)).statusCode).toBe(410);
    expect((await accept({ token, password: GOOD_PASSWORD })).statusCode).toBe(410);
  });

  it("says the same thing either way", async () => {
    const used = await freshInvite();
    await accept({ token: used, password: GOOD_PASSWORD });

    const invented = (await preview("never-minted-anywhere")).json();
    const spent = (await preview(used)).json();
    expect(invented).toEqual(spent);
  });
});

describe("POST /auth/invite/preview", () => {
  it("describes a live invitation without revealing anything else", async () => {
    const token = await freshInvite();
    const body = (await preview(token)).json();

    expect(body.email).toBe("dana@example.com");
    expect(body.role).toBe("approver");
    expect(typeof body.expiresAt).toBe("string");
    expect(Object.keys(body).sort()).toEqual(["email", "expiresAt", "role"]);
  });
});
