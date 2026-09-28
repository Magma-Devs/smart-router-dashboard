import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Loaded once, at module load, not inside the first test: the web suite keeps
// vitest's 5-second test timeout on purpose, and a cold import of the module
// graph under a busy `pnpm -r test` can take longer than that on its own.
const { previewReset } = await import("../bootstrap");

/**
 * The reset page's server-side preview, and the one distinction it must keep:
 * a dead link and an unanswered question are different things.
 *
 * The preview runs from the web pod, so the api's per-IP limit is one bucket
 * for everybody the pod serves. If a 429 read as "expired", anybody who loads
 * `/reset/x` a few times a minute could make every live link look dead.
 */

const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function preview(token = "tok3n") {
  return previewReset(token);
}

describe("previewReset", () => {
  it("names the account for a live link", async () => {
    vi.stubGlobal("fetch", respond(200, { email: "dana@example.com" }));
    expect(await preview()).toEqual({ state: "live", email: "dana@example.com" });
  });

  it("calls a 410 dead — the api's one answer for used, expired and never issued", async () => {
    vi.stubGlobal("fetch", respond(410, { message: "This link has expired." }));
    expect(await preview()).toEqual({ state: "dead" });
  });

  it.each([429, 500, 503])("does not call a %i dead", async (status) => {
    vi.stubGlobal("fetch", respond(status, { message: "busy" }));
    expect(await preview()).toEqual({ state: "unknown" });
  });

  it("does not call an unreachable api dead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await preview()).toEqual({ state: "unknown" });
  });
});
