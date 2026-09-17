import { describe, expect, it } from "vitest";
import {
  INVITE_HANDOFF_COOKIE,
  INVITE_HANDOFF_MAX_AGE_SECONDS,
  looksLikeInviteToken,
} from "../invite-handoff";
import { POST } from "../../app/api/invite/handoff/route";

/**
 * The cookie that carries an invitation token across the Google round-trip.
 *
 * It is the one piece of that flow that can be executed in a unit test — the
 * rest is Auth.js's redirect to Google and back — so the properties that make
 * it safe to set from an unauthenticated route are pinned here.
 */

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/invite/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("looksLikeInviteToken", () => {
  it("accepts a base64url token of the shape the api mints", () => {
    expect(looksLikeInviteToken("abcdEFGH1234_-xyzABCDEFGH")).toBe(true);
  });

  it("rejects anything that could not have come from randomBytes(32)", () => {
    for (const bad of ["", "short", "has spaces in it", "semi;colon", "a".repeat(257), null, 42]) {
      expect(looksLikeInviteToken(bad)).toBe(false);
    }
  });
});

describe("POST /api/invite/handoff", () => {
  it("parks the token in a cookie page scripts cannot read", async () => {
    const res = await post({ token: "abcdEFGH1234_-xyzABCDEFGH" });
    expect(res.status).toBe(204);

    const cookie = res.cookies.get(INVITE_HANDOFF_COOKIE);
    expect(cookie?.value).toBe("abcdEFGH1234_-xyzABCDEFGH");
    // httpOnly: the token is a bearer credential. It is already in the URL the
    // person is holding, which is no reason to hand it to every script too.
    expect(cookie?.httpOnly).toBe(true);
    // lax, not strict: the cookie has to survive Google's top-level redirect
    // back to us, which is the single moment it is needed.
    expect(cookie?.sameSite).toBe("lax");
    expect(cookie?.maxAge).toBe(INVITE_HANDOFF_MAX_AGE_SECONDS);
  });

  it("refuses to park something that was never a token", async () => {
    const res = await post({ token: "not a token" });
    expect(res.status).toBe(400);
    expect(res.cookies.get(INVITE_HANDOFF_COOKIE)).toBeUndefined();
  });

  it("refuses a body that isn't one", async () => {
    const res = await POST(
      new Request("http://localhost/api/invite/handoff", { method: "POST", body: "{[" }),
    );
    expect(res.status).toBe(400);
  });
});
