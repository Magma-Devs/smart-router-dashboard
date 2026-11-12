import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));

// Loaded once, at module load: see preview-reset.test.ts for why.
const { readEnrolmentVerdict } = await import("../enrolment-verdict");
const { INTERNAL_API_BASE_URL } = await import("../internal-api");

/**
 * The layouts' server-side read of whether the signed-in person must enrol.
 *
 * It decides what the first HTML is — the enrolment screen or the dashboard —
 * so the one thing it may never do is turn a question it could not answer into
 * "not required". Every failure is `unknown`, which the gate answers by
 * waiting for the browser's own read.
 */

const ME = {
  id: "user-1",
  email: "dana@example.com",
  name: "Dana",
  avatarUrl: null,
  role: "requester",
  twoFactor: { enrolled: false, enrolmentRequired: true, graceEndsAt: null, daysLeft: null },
};

const respond = (status: number, body: unknown) =>
  vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

let authMode: string | undefined;

beforeEach(() => {
  authMode = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "enabled";
  auth.mockResolvedValue({ user: { id: "user-1" }, accessToken: "bearer-for-user-1" });
});

afterEach(() => {
  if (authMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = authMode;
  auth.mockReset();
  vi.unstubAllGlobals();
});

describe("readEnrolmentVerdict", () => {
  it("asks the api for the live account with the session's Bearer", async () => {
    const fetch = respond(200, ME);
    vi.stubGlobal("fetch", fetch);

    expect(await readEnrolmentVerdict()).toEqual({ state: "known", twoFactor: ME.twoFactor });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${INTERNAL_API_BASE_URL}/api/account/me`);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bearer-for-user-1");
    expect(init?.cache).toBe("no-store");
  });

  it("passes on a 'not required' as the api's answer too", async () => {
    const twoFactor = { enrolled: true, enrolmentRequired: false, graceEndsAt: null, daysLeft: null };
    vi.stubGlobal("fetch", respond(200, { ...ME, twoFactor }));
    expect(await readEnrolmentVerdict()).toEqual({ state: "known", twoFactor });
  });

  it("asks nothing where the deployment has no accounts", async () => {
    process.env.AUTH_MODE = "disabled";
    const fetch = respond(200, ME);
    vi.stubGlobal("fetch", fetch);

    expect(await readEnrolmentVerdict()).toEqual({ state: "none" });
    expect(fetch).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("is unknown with no session to ask for", async () => {
    auth.mockResolvedValue(null);
    const fetch = respond(200, ME);
    vi.stubGlobal("fetch", fetch);

    expect(await readEnrolmentVerdict()).toEqual({ state: "unknown" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 503])("is unknown when the api answers %i", async (status) => {
    vi.stubGlobal("fetch", respond(status, { message: "no" }));
    expect(await readEnrolmentVerdict()).toEqual({ state: "unknown" });
  });

  it("is unknown when the api cannot be reached or times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    expect(await readEnrolmentVerdict()).toEqual({ state: "unknown" });
  });

  it("is unknown when the answer carries no two-factor block it can read", async () => {
    vi.stubGlobal("fetch", respond(200, { ...ME, twoFactor: undefined }));
    expect(await readEnrolmentVerdict()).toEqual({ state: "unknown" });
  });

  it("is unknown when reading the session itself fails", async () => {
    auth.mockRejectedValue(new Error("AUTH_SECRET is not set"));
    vi.stubGlobal("fetch", respond(200, ME));
    expect(await readEnrolmentVerdict()).toEqual({ state: "unknown" });
  });
});
