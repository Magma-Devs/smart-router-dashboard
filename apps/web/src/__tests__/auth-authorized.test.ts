import { describe, expect, it, vi } from "vitest";

/**
 * The edge gate in `authorized()`: which paths a signed-out browser may open.
 *
 * Everything not listed ends in `return signedIn`, which Auth.js turns into a
 * redirect to /login. A public auth page missing from the list is therefore
 * unreachable by exactly the people it exists for — which is how the "Forgot
 * your password?" link came to lead back to the sign-in page.
 */

// next-auth's runtime needs Next's server modules, which vitest cannot load.
vi.mock("next-auth", () => ({ CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: (o: object) => ({ id: "google", ...o }) }));
vi.mock("next-auth/providers/github", () => ({ default: (o: object) => ({ id: "github", ...o }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: (o: object) => ({ id: "credentials", ...o }) }));

type Authorized = (params: {
  auth: { user?: object } | null;
  request: { nextUrl: URL };
}) => boolean | Response;

async function gate(path: string, signedIn: boolean): Promise<boolean | Response> {
  const { authConfig } = await import("../auth.config");
  const authorized = authConfig.callbacks.authorized as unknown as Authorized;
  return authorized({
    auth: signedIn ? { user: { id: "user-1" } } : null,
    request: { nextUrl: new URL(`http://dash.example.com${path}`) },
  });
}

describe("authorized()", () => {
  it.each(["/forgot-password", "/reset/some-token", "/invite/some-token", "/setup", "/login"])(
    "lets a signed-out browser open %s",
    async (path) => {
      expect(await gate(path, false)).toBe(true);
    },
  );

  it("lets a signed-in browser ask for a reset link too", async () => {
    expect(await gate("/forgot-password", true)).toBe(true);
  });

  it("still gates the dashboard", async () => {
    expect(await gate("/overview", false)).toBe(false);
    expect(await gate("/team", false)).toBe(false);
  });
});
