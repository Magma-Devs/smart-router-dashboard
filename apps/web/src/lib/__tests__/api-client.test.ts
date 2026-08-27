import { describe, expect, it } from "vitest";
import { shouldEndSession } from "../api-client";

/**
 * When an api answer means "this session is over" and the browser should go to
 * /login on its own.
 *
 * Revoking a session is server-side and cannot reach the browser holding it, so
 * a device signed out from the sessions list keeps its rendered page and looks
 * usable until it next calls the api. That device is exactly the one somebody
 * clicked "sign out" about.
 *
 * The exclusions matter more than the rule. Each is a way of being wrong that
 * would be worse than the staleness it fixes.
 */
describe("shouldEndSession", () => {
  it("ends the session on a 401 for a request we authenticated", () => {
    expect(shouldEndSession(401, true)).toBe(true);
  });

  it("ignores a 403 — wrong role is not a dead session", () => {
    // A demoted admin is still signed in. Throwing them out of the app for
    // clicking something they may no longer do would be its own bug, and the
    // api already refuses the action.
    expect(shouldEndSession(403, true)).toBe(false);
  });

  it("ignores a 503 — the auth database being unreachable is not a sign-out", () => {
    // Signing everybody out during a database blip turns a short outage into a
    // support queue, and none of those sessions was actually revoked.
    expect(shouldEndSession(503, true)).toBe(false);
  });

  it("ignores a 401 on a request that carried no token", () => {
    // The public pages — login, invite redemption, reset — call the api with
    // nobody signed in, and a page can load before the session bridge has run.
    // "Not signed in yet" is not something to react to, and reacting would
    // bounce /login to /login.
    expect(shouldEndSession(401, false)).toBe(false);
  });

  it.each([200, 201, 400, 404, 409, 410, 429, 500])("ignores %i", (status) => {
    expect(shouldEndSession(status, true)).toBe(false);
  });
});
