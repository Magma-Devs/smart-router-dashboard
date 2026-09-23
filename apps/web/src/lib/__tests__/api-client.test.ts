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
 * The api's session gate names the reason in a `code`. The exclusions matter
 * more than the rule: each is a way of being wrong that would be worse than the
 * staleness it fixes.
 */
describe("shouldEndSession", () => {
  it.each([
    [401, "SESSION_INVALID"],
    [401, "AUTH_REQUIRED"],
    [403, "ACCOUNT_INACTIVE"],
  ])("ends the session on the gate's %i %s for a request we authenticated", (status, code) => {
    expect(shouldEndSession(status, code, true)).toBe(true);
  });

  it("ignores a route's own 401, which carries no code", () => {
    // "That current password is not correct" is a 401 from the change-password
    // route, not a verdict on the session. Signing someone out for a typo in
    // that field would be absurd.
    expect(shouldEndSession(401, undefined, true)).toBe(false);
  });

  it("ignores a 403 FORBIDDEN — wrong role is not a dead session", () => {
    // A demoted admin is still signed in. Throwing them out of the app for
    // clicking something they may no longer do would be its own bug, and the
    // api already refuses the action.
    expect(shouldEndSession(403, "FORBIDDEN", true)).toBe(false);
  });

  it("ignores a 503 — the auth database being unreachable is not a sign-out", () => {
    // Signing everybody out during a database blip turns a short outage into a
    // support queue, and none of those sessions was actually revoked.
    expect(shouldEndSession(503, "AUTH_UNAVAILABLE", true)).toBe(false);
  });

  it("ignores even the gate's verdict on a request that carried no token", () => {
    // The public pages — login, invite redemption, reset — call the api with
    // nobody signed in, and a page can load before the session bridge has run.
    // "Not signed in yet" is not something to react to, and reacting would
    // bounce /login to /login.
    expect(shouldEndSession(401, "AUTH_REQUIRED", false)).toBe(false);
    expect(shouldEndSession(401, "SESSION_INVALID", false)).toBe(false);
  });

  it.each([200, 201, 400, 404, 409, 410, 423, 429, 500])("ignores %i", (status) => {
    expect(shouldEndSession(status, undefined, true)).toBe(false);
  });
});
