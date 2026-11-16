import { Auth, raw, setEnvDefaults, skipCSRFCheck } from "@auth/core";
import Google from "@auth/core/providers/google";
import { describe, expect, it } from "vitest";
import { handle, type ProxyEnv } from "../proxy.js";

/**
 * The redirect proxy, end to end at the @auth/core level: a dashboard's Auth.js
 * (the same core next-auth wraps, at the same version) starts a Google sign-in
 * with AUTH_REDIRECT_PROXY_URL set, and the proxy handles the callback Google
 * would answer. Nothing is mocked: the state the proxy decodes is the one the
 * dashboard's Auth.js encoded.
 */

const SECRET = "test-only-secret-forty-four-characters-long-aaaa";
const PROXY = "https://auth.example.com/api/auth";
const env: ProxyEnv = {
  AUTH_SECRET: SECRET,
  AUTH_REDIRECT_PROXY_URL: PROXY,
  CALLBACK_HOST_PATTERN: "^dashboard\\.[a-z0-9-]+\\.example\\.com$",
  GOOGLE_CLIENT_ID: "fleet-google-client",
};

/** What a dashboard does when its Google button is clicked. */
/** `proxyUrl: null` is a dashboard without the setting (a default parameter
 *  would read `undefined` as "use the default", which is the opposite). */
async function dashboardSignIn(origin: string, secret = SECRET, proxyUrl: string | null = PROXY) {
  const response = await Auth(
    new Request(`${origin}/api/auth/signin/google`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    }),
    {
      secret,
      trustHost: true,
      basePath: "/api/auth",
      redirectProxyUrl: proxyUrl ?? undefined,
      skipCSRFCheck,
      raw,
      providers: [
        Google({
          clientId: "fleet-google-client",
          clientSecret: "the-dashboard-holds-this-the-proxy-does-not",
          // A static authorization endpoint: the real provider discovers it
          // over the network, which a test does not do.
          authorization: "https://accounts.google.com/o/oauth2/v2/auth",
        }),
      ],
    },
  );
  const authorize = new URL(response.redirect!);
  return {
    redirectUri: authorize.searchParams.get("redirect_uri"),
    state: authorize.searchParams.get("state")!,
  };
}

function callback(provider: string, query: Record<string, string>, init?: RequestInit) {
  const url = new URL(`${PROXY}/callback/${provider}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, init);
}

describe("a dashboard behind the proxy", () => {
  it("names the proxy's callback to Google and keeps its own in the state", async () => {
    const { redirectUri, state } = await dashboardSignIn("https://dashboard.acme.example.com");
    expect(redirectUri).toBe(`${PROXY}/callback/google`);
    expect(state).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it("without the setting, is its own callback", async () => {
    const { redirectUri } = await dashboardSignIn(
      "https://dashboard.acme.example.com",
      SECRET,
      null,
    );
    expect(redirectUri).toBe("https://dashboard.acme.example.com/api/auth/callback/google");
  });

  it("gets the setting from AUTH_REDIRECT_PROXY_URL, so no dashboard code changes", () => {
    // next-auth calls this on its config at start; the chart renders the env.
    const config = { providers: [] };
    setEnvDefaults({ AUTH_SECRET: SECRET, AUTH_REDIRECT_PROXY_URL: PROXY }, config);
    expect((config as { redirectProxyUrl?: string }).redirectProxyUrl).toBe(PROXY);
  });
});

describe("the proxy", () => {
  it("sends Google's answer on to the dashboard named in the state, query intact", async () => {
    const { state } = await dashboardSignIn("https://dashboard.acme.example.com");
    const response = await handle(
      callback("google", { code: "4/0Ab-code", state, scope: "openid email" }),
      env,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://dashboard.acme.example.com/api/auth/callback/google",
    );
    expect(location.searchParams.get("code")).toBe("4/0Ab-code");
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("scope")).toBe("openid email");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves every dashboard on the pattern, each to its own callback", async () => {
    for (const tenant of ["acme", "nimrod-test", "playground-prod"]) {
      const { state } = await dashboardSignIn(`https://dashboard.${tenant}.example.com`);
      const response = await handle(callback("google", { code: "c", state }), env);
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!).hostname).toBe(
        `dashboard.${tenant}.example.com`,
      );
    }
  });

  it("refuses a state signed with another secret", async () => {
    const { state } = await dashboardSignIn(
      "https://dashboard.acme.example.com",
      "another-secret-of-forty-four-characters-bbbb",
    );
    const response = await handle(callback("google", { code: "c", state }), env);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("refuses a dashboard outside the fleet's hostnames, however good its state", async () => {
    for (const origin of [
      "https://evil.example.org",
      "https://dashboard.acme.example.org",
      "https://acme.example.com",
      "https://dashboard.acme.example.com.evil.net",
    ]) {
      const { state } = await dashboardSignIn(origin);
      const response = await handle(callback("google", { code: "c", state }), env);
      expect(response.status, origin).toBe(400);
      expect(response.headers.get("location"), origin).toBeNull();
    }
  });

  it("refuses a plain-http dashboard", async () => {
    const { state } = await dashboardSignIn("http://dashboard.acme.example.com");
    const response = await handle(callback("google", { code: "c", state }), env);
    expect(response.status).toBe(400);
  });

  it("refuses a callback with no state, a forged state, or none it can read", async () => {
    const queries: Record<string, string>[] = [
      { code: "c" },
      { code: "c", state: "not-a-state" },
      { code: "c", state: "" },
      { error: "access_denied" },
    ];
    for (const query of queries) {
      const response = await handle(callback("google", query), env);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  it("serves only the callback routes, and only GET", async () => {
    const { state } = await dashboardSignIn("https://dashboard.acme.example.com");
    expect((await handle(new Request(`${PROXY}/signin/google`), env)).status).toBe(404);
    expect((await handle(new Request(`${PROXY}/callback/facebook?code=c`), env)).status).toBe(404);
    expect((await handle(new Request("https://auth.example.com/"), env)).status).toBe(404);
    expect(
      (await handle(callback("google", { code: "c", state }, { method: "POST" }), env)).status,
    ).toBe(405);
  });

  it("serves a provider only when its client id is configured", async () => {
    const { state } = await dashboardSignIn("https://dashboard.acme.example.com");
    // The state is a Google one; the point is that /callback/github with no
    // GITHUB_CLIENT_ID is not a route the proxy answers with a forward.
    const response = await handle(callback("github", { code: "c", state }), env);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("never names the code or the state in what it logs", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      const { state } = await dashboardSignIn("https://dashboard.acme.example.com");
      await handle(callback("google", { code: "4/0Ab-secret-code", state }), env);
      await handle(callback("google", { code: "4/0Ab-secret-code", state: "forged" }), env);
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain("secret-code");
      expect(line).not.toContain("forged");
    }
    expect(JSON.parse(lines[0]!)).toEqual({
      event: "auth-proxy.forwarded",
      provider: "google",
      host: "dashboard.acme.example.com",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: "auth-proxy.refused",
      provider: "google",
    });
  });
});
