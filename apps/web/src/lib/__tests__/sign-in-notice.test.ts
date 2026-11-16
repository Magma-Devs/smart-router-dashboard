import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_NOTICES, signInNotice, signInPathAfter } from "../sign-in-notice";

/**
 * A removal, or an admin's two-factor reset, ends someone's open session. The
 * api's refusal says so (`endedBy: "admin"`), the browser carries it to the
 * sign-in page as `?reason=access_changed`, and the page says why they are
 * there instead of showing a bare form.
 */

const signOut = vi.hoisted(() => vi.fn());
vi.mock("next-auth/react", () => ({ signOut }));
vi.mock("@/lib/auth-store", () => ({
  authReady: async () => undefined,
  getAuthToken: () => "a-session-token",
}));

describe("signInNotice", () => {
  it("names the admin's act for access_changed", () => {
    expect(signInNotice("access_changed")).toBe(
      "Your session ended. An admin changed your access.",
    );
  });

  it.each([undefined, "", "toString", "__proto__", "<b>hi</b>", ["access_changed"]])(
    "shows nothing for a value it does not list (%s)",
    (reason) => {
      expect(signInNotice(reason as string | string[] | undefined)).toBeNull();
    },
  );

  it("has no long dash in any notice", () => {
    for (const text of Object.values(SIGN_IN_NOTICES)) expect(text).not.toMatch(/[–—]/);
  });
});

describe("signInPathAfter", () => {
  it("carries an admin's act to the sign-in page", () => {
    expect(signInPathAfter("admin")).toBe("/login?reason=access_changed");
  });

  it("sends anything else to the bare sign-in page", () => {
    expect(signInPathAfter(undefined)).toBe("/login");
    expect(signInPathAfter("self")).toBe("/login");
  });
});

describe("a session the api ended", () => {
  beforeEach(() => {
    vi.resetModules();
    signOut.mockReset();
    vi.stubGlobal("window", {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answer(status: number, body: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/config"
          ? Response.json({ apiUrl: "http://api.test", authMode: "enabled" })
          : Response.json(body, { status }),
      ),
    );
  }

  it("goes to the sign-in page with the reason when an admin removed them", async () => {
    answer(403, { code: "ACCOUNT_INACTIVE", endedBy: "admin", message: "inactive" });
    const { apiGet } = await import("../api-client");

    await expect(apiGet("/api/metrics/specs")).rejects.toThrow();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/login?reason=access_changed" });
  });

  it("goes to the bare sign-in page when the holder ended it", async () => {
    answer(401, { code: "SESSION_INVALID", message: "ended" });
    const { apiGet } = await import("../api-client");

    await expect(apiGet("/api/metrics/specs")).rejects.toThrow();
    await vi.waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/login" });
  });
});
