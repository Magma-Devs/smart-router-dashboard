import { NextResponse } from "next/server";
import {
  INVITE_HANDOFF_COOKIE,
  INVITE_HANDOFF_MAX_AGE_SECONDS,
  looksLikeInviteToken,
} from "@/lib/invite-handoff";

/**
 * Park an invitation token for the length of a Google round-trip.
 *
 * The invite page calls this immediately before `signIn("google")`; the
 * `signIn` callback in `auth.config.ts` reads the cookie back and redeems with
 * it. A route handler rather than the page itself because only a handler can
 * set a cookie, and only a handler can make it `httpOnly`.
 *
 * Public by necessity — the caller has no session yet, which is the entire
 * point of an invitation. Setting the cookie grants nothing on its own: the api
 * re-checks the token on every use, and an invented one simply fails there.
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const token = (body as { token?: unknown } | null)?.token;

  if (!looksLikeInviteToken(token)) {
    return NextResponse.json(
      { error: "Bad Request", message: "That is not an invitation token." },
      { status: 400 },
    );
  }

  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(INVITE_HANDOFF_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: INVITE_HANDOFF_MAX_AGE_SECONDS,
  });
  return res;
}
