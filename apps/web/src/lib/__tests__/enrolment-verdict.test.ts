import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { auth, requestHeaders } = vi.hoisted(() => ({ auth: vi.fn(), requestHeaders: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
// The request being rendered. Outside one, Next's `headers()` throws.
vi.mock("next/headers", () => ({ headers: requestHeaders }));

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

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36";
const INTERNAL = "internal-secret-for-tests";

let authMode: string | undefined;
let internalSecret: string | undefined;

beforeEach(() => {
  authMode = process.env.AUTH_MODE;
  internalSecret = process.env.INTERNAL_AUTH_SECRET;
  process.env.AUTH_MODE = "enabled";
  process.env.INTERNAL_AUTH_SECRET = INTERNAL;
  auth.mockResolvedValue({ user: { id: "user-1" }, accessToken: "bearer-for-user-1" });
  requestHeaders.mockResolvedValue(new Headers({ "user-agent": BROWSER_UA }));
});

afterEach(() => {
  if (authMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = authMode;
  if (internalSecret === undefined) delete process.env.INTERNAL_AUTH_SECRET;
  else process.env.INTERNAL_AUTH_SECRET = internalSecret;
  auth.mockReset();
  requestHeaders.mockReset();
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

  it("vouches for the read, so the api counts it against the reader rather than the web pod", async () => {
    // Sent bare, every page load by everybody came from this container and
    // spent one shared allowance; a busy minute left each new page waiting.
    const fetch = respond(200, ME);
    vi.stubGlobal("fetch", fetch);

    await readEnrolmentVerdict();
    const sent = new Headers(fetch.mock.calls[0]![1]?.headers);
    expect(sent.get("x-internal-auth")).toBe(INTERNAL);
    expect(sent.get("x-forwarded-client-ua")).toBe(BROWSER_UA);
    expect(sent.get("authorization")).toBe("Bearer bearer-for-user-1");
  });

  it("vouches even with nothing to forward — the session decides the allowance, not the address", async () => {
    requestHeaders.mockResolvedValue(new Headers());
    const fetch = respond(200, ME);
    vi.stubGlobal("fetch", fetch);

    await readEnrolmentVerdict();
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-internal-auth")).toBe(INTERNAL);
  });

  it("still asks, unvouched, outside a request", async () => {
    requestHeaders.mockRejectedValue(new Error("`headers` was called outside a request scope"));
    const fetch = respond(200, ME);
    vi.stubGlobal("fetch", fetch);

    expect(await readEnrolmentVerdict()).toEqual({ state: "known", twoFactor: ME.twoFactor });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-internal-auth")).toBeNull();
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
