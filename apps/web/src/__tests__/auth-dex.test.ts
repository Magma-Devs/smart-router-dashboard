import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeHandoff, TWO_FACTOR_HANDOFF_COOKIE } from "../lib/two-factor-handoff";
import { INVITE_HANDOFF_COOKIE } from "../lib/invite-handoff";

/**
 * The Auth.js half of signing in through Dex (MAG-5238): the provider it
 * registers, and what the `signIn` callback hands the api. Token verification
 * itself is the api's (`services/dex.ts`, tested there against real
 * signatures); what is pinned here is that the web asks Dex for the right
 * things and forwards the right token to the right route.
 */

// next-auth's runtime needs Next's server modules, which vitest cannot load.
vi.mock("next-auth", () => ({ CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: (o: object) => ({ id: "google", ...o }) }));
vi.mock("next-auth/providers/github", () => ({ default: (o: object) => ({ id: "github", ...o }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: (o: object) => ({ id: "credentials", ...o }) }));

/** The cookie jar the callback reaches through `next/headers`. */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "test" }),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const DEX_ENV = {
  DEX_ISSUER: "https://auth.example.com",
  DEX_CLIENT_ID: "sr-dashboard-acme",
  INTERNAL_AUTH_SECRET: "internal-secret-for-web-tests",
};
const ENV_KEYS = [
  "DEX_ISSUER",
  "DEX_CLIENT_ID",
  "DEX_CONNECTORS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "INTERNAL_AUTH_SECRET",
];
const saved: Record<string, string | undefined> = {};

interface Provider {
  id: string;
  type?: string;
  issuer?: string;
  clientId?: string;
  client?: Record<string, unknown>;
  checks?: string[];
  authorization?: { params?: Record<string, string> };
}

type SignInCallback = (params: {
  user: Record<string, unknown>;
  account: Record<string, unknown> | null;
  profile?: Record<string, unknown>;
}) => Promise<boolean | string>;

async function loadConfig(env: Record<string, string>) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  const { authConfig, oauthProviderFlags } = await import("../auth.config");
  return {
    providers: authConfig.providers as unknown as Provider[],
    signIn: authConfig.callbacks.signIn as unknown as SignInCallback,
    oauthProviderFlags,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
function answer(body: unknown, status = 200): void {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  jar.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SIGNED_IN = {
  user: { id: "user-1", email: "dana@example.com", name: "Dana Levi", role: "approver", avatarUrl: null },
  sessionId: "session-1",
};

describe("the dex provider", () => {
  it("is a public PKCE client asking for the federated identity", async () => {
    const { providers, oauthProviderFlags } = await loadConfig(DEX_ENV);
    const dex = providers.find((p) => p.id === "dex");
    expect(dex).toMatchObject({
      type: "oidc",
      issuer: "https://auth.example.com",
      clientId: "sr-dashboard-acme",
      client: { token_endpoint_auth_method: "none" },
      checks: ["pkce", "state", "nonce"],
      authorization: { params: { scope: "openid email profile federated:id" } },
    });
    expect(dex).not.toHaveProperty("clientSecret");
    expect(oauthProviderFlags).toEqual({ google: "dex", github: "dex" });
  });

  it("replaces the direct provider it covers and leaves the other alone", async () => {
    const { providers } = await loadConfig({
      ...DEX_ENV,
      DEX_CONNECTORS: "google",
      GOOGLE_CLIENT_ID: "g-id",
      GOOGLE_CLIENT_SECRET: "g-secret",
      GITHUB_CLIENT_ID: "gh-id",
      GITHUB_CLIENT_SECRET: "gh-secret",
    });
    expect(providers.map((p) => p.id).sort()).toEqual(["credentials", "dex", "github"]);
  });

  it("is not registered without the Dex settings", async () => {
    const { providers } = await loadConfig({ GOOGLE_CLIENT_ID: "g-id", GOOGLE_CLIENT_SECRET: "g-secret" });
    expect(providers.map((p) => p.id).sort()).toEqual(["credentials", "google"]);
  });
});

describe("signIn() after a Dex round-trip", () => {
  it("hands Dex's ID token to /auth/oauth/dex and takes the account the api resolved", async () => {
    const { signIn } = await loadConfig(DEX_ENV);
    answer(SIGNED_IN);
    const user: Record<string, unknown> = { email: "dana@example.com" };

    const ok = await signIn({
      user,
      account: { provider: "dex", id_token: "dex-id-token", access_token: "dex-access-token" },
      profile: { federated_claims: { connector_id: "google", user_id: "1" } },
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/auth/oauth/dex")).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({ token: "dex-id-token" });
    expect(user).toMatchObject({ id: "user-1", role: "approver", sessionId: "session-1" });
  });

  it("refuses a round-trip that brought back no ID token", async () => {
    const { signIn } = await loadConfig(DEX_ENV);
    expect(await signIn({ user: {}, account: { provider: "dex", access_token: "only-this" } })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the api refuses the token", async () => {
    const { signIn } = await loadConfig(DEX_ENV);
    answer({ message: "dex token verification failed" }, 401);
    expect(await signIn({ user: {}, account: { provider: "dex", id_token: "t" } })).toBe(false);
  });

  it("parks the code challenge under the provider the api names, and opens nothing", async () => {
    const { signIn } = await loadConfig(DEX_ENV);
    answer({ twoFactorRequired: true, challenge: "c".repeat(43), email: "dana@example.com", provider: "github" });

    const next = await signIn({
      user: { email: "dana@example.com" },
      account: { provider: "dex", id_token: "t" },
      profile: { federated_claims: { connector_id: "google", user_id: "1" } },
    });

    expect(next).toBe("/login?step=code");
    expect(decodeHandoff(jar.get(TWO_FACTOR_HANDOFF_COOKIE))).toEqual({
      challenge: "c".repeat(43),
      email: "dana@example.com",
      provider: "github",
    });
  });

  it("redeems a parked invitation through Dex, naming the broker as the route", async () => {
    const { signIn } = await loadConfig(DEX_ENV);
    jar.set(INVITE_HANDOFF_COOKIE, "invite-token-1");
    answer(SIGNED_IN, 201);

    const ok = await signIn({
      user: { email: "dana@example.com", name: "Dana Levi" },
      account: { provider: "dex", id_token: "dex-id-token" },
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/auth/invite/accept")).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({
      token: "invite-token-1",
      oauthProvider: "dex",
      oauthToken: "dex-id-token",
    });
    expect(jar.has(INVITE_HANDOFF_COOKIE)).toBe(false);
  });

  it("still hands GitHub's access token, not an ID token, on the direct path", async () => {
    const { signIn } = await loadConfig({ GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" });
    answer(SIGNED_IN);
    await signIn({ user: {}, account: { provider: "github", access_token: "gh-token", id_token: "nope" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/auth/oauth/github")).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({ token: "gh-token" });
  });
});
