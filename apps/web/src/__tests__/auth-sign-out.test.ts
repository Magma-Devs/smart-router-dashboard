import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jwtVerify } from "jose";

/**
 * Signing out of the browser has to close the api's session too.
 *
 * Auth.js only clears the cookie. Without `events.signOut` the api session
 * stays live until it expires: its token keeps working, the sessions list shows
 * the device, and the audit log gets no `signout` row.
 */

// next-auth's runtime needs Next's server modules, which vitest cannot load.
// Nothing here is about the providers, so they are stand-ins.
vi.mock("next-auth", () => ({ CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: (o: object) => ({ id: "google", ...o }) }));
vi.mock("next-auth/providers/github", () => ({ default: (o: object) => ({ id: "github", ...o }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: (o: object) => ({ id: "credentials", ...o }) }));

const SECRET = "test-secret-for-web-sign-out-32-chars!";
const token = { id: "user-1", sub: "user-1", email: "dana@example.com", role: "approver", sid: "session-1" };

type SignOutEvent = (message: { token: Record<string, unknown> | null }) => Promise<void>;

async function signOutEvent(): Promise<SignOutEvent> {
  const { authConfig } = await import("../auth.config");
  return authConfig.events.signOut as unknown as SignOutEvent;
}

let fetchMock: ReturnType<typeof vi.fn>;
const savedSecret = process.env.AUTH_SECRET;

beforeEach(() => {
  process.env.AUTH_SECRET = SECRET;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
});

describe("events.signOut", () => {
  it("closes the api session the cookie addressed", async () => {
    await (await signOutEvent())({ token });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith("/auth/sign-out")).toBe(true);
    expect(init.method).toBe("POST");

    // The Bearer names that same session, signed the way the api checks it.
    const bearer = (init.headers as Record<string, string>).Authorization!.replace(/^Bearer /, "");
    const { payload } = await jwtVerify(bearer, new TextEncoder().encode(SECRET), {
      issuer: "smart-router-dashboard-web",
      audience: "smart-router-dashboard-api",
    });
    expect(payload.sub).toBe("user-1");
    expect(payload.sid).toBe("session-1");
  });

  it("asks nothing of the api for a cookie with no session in it", async () => {
    await (await signOutEvent())({ token: { ...token, sid: undefined } });
    await (await signOutEvent())({ token: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws, so an unreachable api cannot keep anybody signed in", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect((await signOutEvent())({ token })).resolves.toBeUndefined();
  });
});
