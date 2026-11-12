import { verifyDexToken, type VerifiedSignIn } from "./dex.js";
import { verifyOAuthToken } from "./oauth.js";
import type { OAuthProvider } from "./users.js";

/**
 * Where a provider token came from, as the web names it on the wire:
 * straight from Google or GitHub, or through the Dex broker. Not the same set
 * as {@link OAuthProvider} — `dex` is a way in, not an account column; the
 * token itself says which provider stood behind it.
 */
export type SignInRoute = OAuthProvider | "dex";

export const SIGN_IN_ROUTES = ["google", "github", "dex"] as const satisfies readonly SignInRoute[];

/** For error copy before the token has said which provider it is. */
export const SIGN_IN_ROUTE_LABEL: Record<SignInRoute, string> = {
  google: "Google",
  github: "GitHub",
  dex: "Google or GitHub",
};

export type { VerifiedSignIn };

/**
 * Verify a provider token whichever way it came, and say whose it is. Every
 * route that turns a provider token into an account goes through here, so the
 * direct and the brokered path cannot drift apart in what they accept.
 */
export async function verifySignInToken(route: SignInRoute, token: string): Promise<VerifiedSignIn> {
  if (route === "dex") return verifyDexToken(token);
  return { provider: route, profile: await verifyOAuthToken(route, token) };
}
