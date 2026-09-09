import { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { jwtVerify, SignJWT } from "jose";
import type { Role } from "@sr/shared";
import { INTERNAL_API_BASE_URL } from "@/lib/internal-api";
import { INVITE_HANDOFF_COOKIE } from "@/lib/invite-handoff";
import {
  TWO_FACTOR_HANDOFF_COOKIE,
  TWO_FACTOR_HANDOFF_MAX_AGE_SECONDS,
  decodeHandoff,
  encodeHandoff,
  type HandoffProvider,
} from "@/lib/two-factor-handoff";

/**
 * Auth.js v5 configuration (ported from lava-connect's auth.config.ts,
 * trimmed to the dashboard's needs). Split from `auth.ts` so the edge
 * proxy can import the config without pulling in the full Node-only
 * Auth.js handler.
 *
 * The session JWT is signed with HS256 using `AUTH_SECRET`. The Fastify
 * api validates with the same secret via `@fastify/jwt` — that's how the
 * web's session token doubles as the api Bearer token.
 *
 * Only referenced when AUTH_MODE=enabled — the proxy, login page, and
 * [...nextauth] route all no-op/404 in disabled mode.
 */

/**
 * The four roles, from `@sr/shared` — one definition, so the web can't drift
 * into disagreeing with the api about who may do what.
 *
 * A **type-only** re-export on purpose: `proxy.ts` pulls this module into the
 * edge bundle, and a value import of `@sr/shared` would drag the metric catalog
 * and the chain map along with it. `import type` is erased at compile time, so
 * this costs the bundle nothing.
 */
export type UserRole = Role;

/** Least privilege — what an unknown or missing role decays to. */
const DEFAULT_ROLE: UserRole = "read_only";

/** Server-side base URL for talking to the api from inside Auth.js callbacks.
 *  Shared with `lib/bootstrap.ts`, which needs the same resolution. */
const apiBase = INTERNAL_API_BASE_URL;

/** Must match the api's expected values in `apps/api/src/plugins/auth.ts`. */
const SESSION_JWT_ISSUER = "smart-router-dashboard-web";
const SESSION_JWT_AUDIENCE = "smart-router-dashboard-api";

interface SignInUserPayload {
  id: string;
  email: string;
  name: string | null;
  avatarUrl?: string | null;
  role: UserRole;
}

/** `/auth/sign-in` and `/auth/oauth/:provider` open the session row and return
 *  its id; it rides in the token's `sid` claim and the api resolves it on every
 *  request. A token without one is refused, so this is not optional. */
interface SignInResponse {
  user: SignInUserPayload;
  /** Set, with `challenge`, when the account has an authenticator: the first
   *  factor held, and the code is still to come. */
  twoFactorRequired?: boolean;
  challenge?: string;
  /** The account's address, with a challenge — for the code screen. */
  email?: string;
  /** Absent when the api answered `twoFactorRequired` — a verified password
   *  opens no session, so there is nothing to address. */
  sessionId?: string;
}

/**
 * How many proxies sit between the browser and this container. Each one appends
 * the address it received from, so the client is that many entries from the
 * right of `X-Forwarded-For`. Must match the ingress topology, and the api's
 * own `TRUST_PROXY`.
 */
function trustedHops(): number {
  const raw = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? "", 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * The browser's own address, picked out of `X-Forwarded-For` by hop count.
 *
 * **Never the left-most entry.** Most ingresses append rather than replace, so
 * the left of that header is whatever the caller sent — meaning a client could
 * choose the address written to its own session row and audit trail, which is
 * the forgery the internal secret exists to prevent. Counting from the right
 * lands on an entry a proxy wrote.
 *
 * Returns undefined when the header is shorter than the configured hop count:
 * that is a misconfiguration or a manipulated header, and recording this
 * container's address is the honest answer to it.
 *
 * Exported for tests — the arithmetic is the whole security property.
 */
export function clientIpFrom(headers: Headers | null, hops = trustedHops()): string | undefined {
  if (!headers) return undefined;
  const chain =
    headers
      .get("x-forwarded-for")
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  if (chain.length === 0) return headers.get("x-real-ip") || undefined;
  return chain[chain.length - hops] ?? undefined;
}

/**
 * What the browser told *us*, forwarded to the api so the session row and the
 * audit log record the person's own address rather than this container's.
 *
 * The api only believes it alongside `INTERNAL_AUTH_SECRET`; without that it
 * falls back to what it observes, so an attacker calling the public sign-in
 * endpoint directly cannot choose the address recorded against their attempts.
 *
 * Headers rather than a body field: the api's rate limiter runs before a body
 * exists and keys on this same address, so a deployment's sign-ins do not all
 * share one bucket.
 */
function forwardedClientHeaders(headers: Headers | null): Record<string, string> {
  const secret = process.env.INTERNAL_AUTH_SECRET;
  if (!headers || !secret) return {};

  const ip = clientIpFrom(headers);
  const userAgent = headers.get("user-agent") ?? undefined;
  if (!ip && !userAgent) return {};

  return {
    "X-Internal-Auth": secret,
    ...(ip ? { "X-Forwarded-Client-Ip": ip } : {}),
    ...(userAgent ? { "X-Forwarded-Client-Ua": userAgent } : {}),
  };
}

/**
 * The invitation token parked by `/api/invite/handoff`, if this Google flow
 * started on an invite page. `next/headers` is imported dynamically for the
 * same reason the `signIn` callback does it: `proxy.ts` pulls this module into
 * the edge bundle, where the module does not exist and this never runs.
 */
async function readInviteHandoff(): Promise<string | null> {
  try {
    const { cookies } = await import("next/headers");
    return (await cookies()).get(INVITE_HANDOFF_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/** Park a provider sign-in's two-factor challenge for the code screen. */
async function parkTwoFactorHandoff(
  challenge: string,
  email: string,
  provider: HandoffProvider,
): Promise<boolean> {
  try {
    const { cookies } = await import("next/headers");
    (await cookies()).set(TWO_FACTOR_HANDOFF_COOKIE, encodeHandoff({ challenge, email, provider }), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: TWO_FACTOR_HANDOFF_MAX_AGE_SECONDS,
    });
    return true;
  } catch {
    return false;
  }
}

/** The parked challenge, read once and burnt: spent right or wrong, a challenge
 *  is dead, and a cookie still holding it would only mislead the next screen. */
async function takeTwoFactorHandoff() {
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    const handoff = decodeHandoff(jar.get(TWO_FACTOR_HANDOFF_COOKIE)?.value);
    jar.delete(TWO_FACTOR_HANDOFF_COOKIE);
    return handoff;
  } catch {
    return null;
  }
}

/** A code step the api rate-limited: not a wrong code, and the challenge was
 *  never spent — so the form keeps the code screen rather than starting over. */
class RateLimited extends CredentialsSignin {
  code = "rate_limited";
}

/** Burn the handoff cookie the moment it has been spent, successfully or not —
 *  a token that survived a failed attempt would be replayed by the next one. */
async function clearInviteHandoff(): Promise<void> {
  try {
    const { cookies } = await import("next/headers");
    (await cookies()).delete(INVITE_HANDOFF_COOKIE);
  } catch {
    // Not in a mutable request scope; the cookie's short max-age bounds it.
  }
}

declare module "next-auth" {
  interface User {
    role?: UserRole;
    avatarUrl?: string | null;
    /** Set by `authorize()` / `signIn()` from the api's response, then copied
     *  onto the token exactly once per sign-in. */
    sessionId?: string;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: UserRole;
      avatarUrl?: string | null;
    };
    /** Raw HS256 JWT — sent to the api as `Authorization: Bearer`. */
    accessToken: string;
  }
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return new TextEncoder().encode(secret);
}

/** The Bearer the api accepts for one session: the base claims, re-signed. */
async function signApiBearer(claims: { sub: string; email: string; role: UserRole; sid: string }) {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(SESSION_JWT_ISSUER)
    .setAudience(SESSION_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(secretKey());
}

/** How long a sign-out waits on the api before letting the browser go anyway. */
const SIGN_OUT_API_TIMEOUT_MS = 3_000;

/** A lockout, told apart from a wrong password so the form can say which. The
 *  code rides in the URL, and is safe there: addresses with no account lock too. */
class AccountLocked extends CredentialsSignin {
  code = "locked";
}

/** A provider is offered only when BOTH halves of its credential pair are
 *  set — this is what makes the login page's badges conditional. */
export const oauthProviderFlags = {
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
} as const;

const providers: NextAuthConfig["providers"] = [];
if (oauthProviderFlags.google) {
  providers.push(
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  );
}
if (oauthProviderFlags.github) {
  providers.push(
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      // user:email so the api can pull the verified primary address.
      authorization: { params: { scope: "read:user user:email" } },
    }),
  );
}
providers.push(
  Credentials({
    name: "Credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
      /** Second step. Present together or not at all — see `authorize`. */
      challenge: { label: "Challenge", type: "text" },
      code: { label: "Authenticator code", type: "text" },
      /** "1" when the challenge is the one a Google or GitHub sign-in parked in
       *  the handoff cookie, rather than one the form holds. */
      handoff: { label: "Handoff", type: "text" },
    },
    // The second argument is the browser's own request to
    // /api/auth/callback/credentials — the only place in this flow that can see
    // the client. Auth.js v5 passes it; omitting it (as this once did) leaves
    // the api recording the web container's address for every sign-in, and
    // every access event in the audit log inherits that.
    /**
     * Two shapes reach here, and they are two different api calls.
     *
     *  - `{ email, password }` — an account with no authenticator. The api opens
     *    a session and this mints the token from it.
     *  - `{ email, challenge, code }` — the second step. The password was
     *    already checked by `/auth/sign-in`, which returned a challenge and
     *    **no session**; `/auth/2fa/verify` is what opens one.
     *
     * The password path can also come back saying two-factor is required, and
     * that returns null: there is no session to mint a token from, and the form
     * is the thing that knows what to do next (show the code screen). Auth.js
     * has no notion of a partial sign-in, and inventing one here — a token
     * marked "half" — is exactly the shape the api refuses on purpose.
     */
    async authorize(credentials, request) {
      // After a Google or GitHub sign-in the challenge never reached the
      // browser: it is read here, server-side, from the cookie the provider
      // callback parked it in.
      const parked = credentials?.handoff === "1" ? await takeTwoFactorHandoff() : null;
      if (credentials?.handoff === "1" && !parked) return null;

      const email = parked?.email ?? credentials?.email;
      if (typeof email !== "string") return null;

      const challenge = parked?.challenge ?? credentials?.challenge;
      const code = credentials?.code;
      const secondStep = typeof challenge === "string" && typeof code === "string" && !!challenge;

      const password = credentials?.password;
      if (!secondStep && typeof password !== "string") return null;

      const forwarded = forwardedClientHeaders(request?.headers ?? null);
      const url = secondStep ? `${apiBase}/auth/2fa/verify` : `${apiBase}/auth/sign-in`;
      const payload = secondStep ? { challenge, code } : { email, password };

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...forwarded },
          body: JSON.stringify(payload),
        });
        if (res.status === 423) throw new AccountLocked();
        if (res.status === 429) throw new RateLimited();
        if (!res.ok) return null;
        const body = (await res.json()) as SignInResponse;
        // No session id ⇒ the api answered `twoFactorRequired`. Nothing to mint.
        if (!body.sessionId) return null;
        return {
          id: body.user.id,
          email: body.user.email,
          name: body.user.name,
          avatarUrl: body.user.avatarUrl ?? null,
          role: body.user.role,
          sessionId: body.sessionId,
        };
      } catch (err) {
        if (err instanceof AccountLocked || err instanceof RateLimited) throw err;
        return null;
      }
    },
  }),
);

export const authConfig = {
  trustHost: true,
  session: { strategy: "jwt" as const, maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: "/login" },
  providers,
  /**
   * Override the JWT codec to plain HS256 signing instead of Auth.js's
   * default JWE encryption. The api validates with the same secret via
   * `@fastify/jwt` — JWE would require a separate decryption path.
   */
  jwt: {
    async encode({ token }) {
      if (!token) return "";
      const claims = {
        sub: (token.id as string) ?? (token.sub as string) ?? "",
        email: (token.email as string) ?? "",
        name: (token.name as string | undefined) ?? null,
        avatarUrl: (token.avatarUrl as string | null | undefined) ?? null,
        role: (token.role as UserRole) ?? DEFAULT_ROLE,
        // The session this cookie addresses. Persisted here so it survives the
        // decode on the next request — anything not in these claims is dropped.
        sid: (token.sid as string | undefined) ?? "",
      };
      return await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience(SESSION_JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(secretKey());
    },
    async decode({ token }) {
      if (!token) return null;
      try {
        const { payload } = await jwtVerify(token, secretKey(), {
          algorithms: ["HS256"],
          issuer: SESSION_JWT_ISSUER,
          audience: SESSION_JWT_AUDIENCE,
        });
        return {
          id: payload.sub as string,
          sub: payload.sub as string,
          email: payload.email as string,
          name: (payload.name as string | undefined) ?? null,
          avatarUrl: (payload.avatarUrl as string | null | undefined) ?? null,
          role: (payload.role as UserRole) ?? DEFAULT_ROLE,
          sid: (payload.sid as string | undefined) ?? undefined,
        };
      } catch {
        return null;
      }
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      // OAuth sign-ins: forward the provider's token to the api so it can
      // independently verify and upsert the user. Strict-fail paths that
      // don't produce a usable token — letting them through would create
      // a session not backed by a DB row.
      if (!account) return true;
      const provider = account.provider;
      if (provider !== "google" && provider !== "github") return true;

      const token = provider === "google" ? account.id_token : account.access_token;
      if (!token) return false;

      // This callback gets no `request`, so reach for the ambient one. Imported
      // dynamically because `proxy.ts` pulls this module into the edge bundle,
      // where `next/headers` doesn't exist — and never runs this callback.
      let requestHeaders: Headers | null = null;
      try {
        const { headers } = await import("next/headers");
        requestHeaders = await headers();
      } catch {
        // No ambient request scope: fall through with no forwarded address.
        // The api then records what it observes rather than nothing.
      }
      const internalHeaders = forwardedClientHeaders(requestHeaders);

      // Redeeming an invitation with Google, rather than signing in with it.
      //
      // `upsertOAuthUser` links only — it never creates — so on a fresh
      // invitee `/auth/oauth/google` can only ever answer 403. The account has
      // to come from `/auth/invite/accept`, which is the one place besides
      // first-run setup that is allowed to create one. The token got here in a
      // cookie the invite page set just before starting this round-trip.
      // Every provider, not just Google: `upsertOAuthUser` links and never
      // creates, so redemption is the only way a social account comes to
      // exist. A provider that skipped this branch would be one nobody could
      // ever sign in with on an invite-only deployment.
      const inviteToken = await readInviteHandoff();

      async function post(url: string, payload: Record<string, unknown>) {
        return fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...internalHeaders },
          body: JSON.stringify(payload),
        });
      }

      try {
        let res: Response;
        if (inviteToken) {
          await clearInviteHandoff();
          res = await post(`${apiBase}/auth/invite/accept`, {
            token: inviteToken,
            oauthProvider: provider,
            oauthToken: token,
            name: user.name ?? undefined,
          });

          // A handoff cookie outlives an abandoned attempt by up to its
          // max-age, so an ordinary sign-in started inside that window would
          // otherwise be dragged through a redemption that cannot succeed.
          // A dead invitation is exactly that case: fall through to signing
          // in, which is what this person actually asked for. Only a mismatch
          // (403) is worth interrupting them over — they chose the wrong
          // account and can fix it.
          if (!res.ok && res.status !== 403) {
            res = await post(`${apiBase}/auth/oauth/${provider}`, { token });
          } else if (res.status === 403) {
            return `/invite/${encodeURIComponent(inviteToken)}?error=email_mismatch`;
          }
        } else {
          res = await post(`${apiBase}/auth/oauth/${provider}`, { token });
        }

        if (!res.ok) return false;
        const body = (await res.json()) as SignInResponse;

        // An account with an authenticator: the provider was one factor, and
        // the api answered with a challenge for the second, no session. Park it
        // and send the browser to the code screen. Returning a path denies this
        // sign-in, which is right — nothing is signed in until the code is.
        if (body.twoFactorRequired && body.challenge) {
          const parked = await parkTwoFactorHandoff(
            body.challenge,
            body.email ?? user.email ?? "",
            provider,
          );
          return parked ? "/login?step=code" : false;
        }

        user.id = body.user.id;
        user.email = body.user.email;
        user.name = body.user.name ?? null;
        user.avatarUrl = body.user.avatarUrl ?? null;
        user.role = body.user.role;
        user.sessionId = body.sessionId;
        return true;
      } catch {
        return false;
      }
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.email = user.email;
        token.name = user.name ?? null;
        token.avatarUrl = user.avatarUrl ?? null;
        // `user` is present only on the sign-in call, so the session id is
        // fixed here exactly once and every later refresh reuses it. Minting or
        // defaulting it further down (in `session()`, which runs on every read)
        // would hand each refresh a different id, and the audit log's `session`
        // field — the thing that ties a run of actions to one sign-in — would
        // stop meaning anything.
        token.sid = user.sessionId;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = (token.id as string) ?? "";
      session.user.role = (token.role as UserRole) ?? DEFAULT_ROLE;
      session.user.email = (token.email as string) ?? session.user.email;
      session.user.name = (token.name as string | null | undefined) ?? null;
      session.user.avatarUrl = (token.avatarUrl as string | null | undefined) ?? null;
      // Re-sign the api Bearer here — the custom `encode` only persists
      // the base claims into the cookie, so a token stashed on `token`
      // would be dropped on the next decode (lava-connect's lesson).
      //
      // `sid` is carried through, never generated: the api refuses a token
      // whose session id doesn't resolve, so a fabricated one would 401 the
      // whole surface rather than fail open.
      session.accessToken = await signApiBearer({
        sub: session.user.id,
        email: session.user.email,
        role: session.user.role,
        sid: (token.sid as string | undefined) ?? "",
      });
      return session;
    },
    authorized({ auth, request }) {
      const url = request.nextUrl;
      const path = url.pathname;
      const signedIn = !!auth?.user;

      // Already-signed-in users land on /metrics if they hit /login.
      if (path === "/login") {
        return signedIn ? Response.redirect(new URL("/metrics", url)) : true;
      }
      // First-run setup is reachable without a session — on a fresh install
      // there is nobody to be yet. The page itself refuses once an account
      // exists, and so does the api; the gate can't tell, because the edge
      // can't reach the database.
      if (path === "/setup") {
        return signedIn ? Response.redirect(new URL("/overview", url)) : true;
      }
      // Invitation redemption is public, signed in or not. An invitation creates
      // an account for somebody who has none, but a silent redirect would read
      // as a broken link to the person it strands — somebody with an account
      // clicking an invitation for a second address. The page explains it and
      // offers a sign-out that comes back here; the gate can't, because it
      // cannot see who the invitation is for.
      if (path.startsWith("/invite/")) return true;
      // Reset links are usable while signed in — the usual reason someone
      // follows one is that they think somebody else is signed in as them.
      if (path.startsWith("/reset/")) return true;
      // Asking for a reset link is for somebody who cannot sign in, by
      // definition. Signed in, it still works: the reason to ask is often a
      // suspicion that somebody else knows the password.
      if (path === "/forgot-password") return true;
      // Enrolment needs a session and is reachable with one. Whether it is
      // *required* is the api's call — the edge cannot see the database, and a
      // gate that guessed would either strand somebody who has enrolled or wave
      // through somebody who has not. `TwoFactorGate` renders the block.
      if (path === "/account/two-factor") return signedIn;
      // Auth.js's own endpoints + the runtime-config route stay public, and so
      // does the invite handoff: its whole job is to run before there is a
      // session. It only parks a token the api re-checks on every use.
      if (
        path.startsWith("/api/auth") ||
        path === "/api/config" ||
        path === "/api/invite/handoff"
      ) {
        return true;
      }
      // Static assets.
      if (path.startsWith("/_next/") || path === "/favicon.ico") return true;
      if (/\.[a-zA-Z0-9]+$/.test(path)) return true;

      // Everything else requires a session.
      return signedIn;
    },
  },
  events: {
    /**
     * Signing out of the browser closes the api's session too. Clearing the
     * cookie alone leaves the session live on the api: its token keeps working
     * until it expires, the sessions list goes on showing the device, and the
     * audit log gets no `signout` row.
     *
     * Best effort. Auth.js clears the cookie whatever happens here, and an api
     * that is down or slow must not keep anybody signed in — hence the timeout,
     * and no throw.
     */
    async signOut(message) {
      const token = "token" in message ? message.token : null;
      const sid = token?.sid as string | undefined;
      const sub = (token?.id ?? token?.sub) as string | undefined;
      if (!token || !sid || !sub) return;
      try {
        const bearer = await signApiBearer({
          sub,
          email: (token.email as string) ?? "",
          role: (token.role as UserRole) ?? DEFAULT_ROLE,
          sid,
        });
        await fetch(`${apiBase}/auth/sign-out`, {
          method: "POST",
          headers: { Authorization: `Bearer ${bearer}` },
          signal: AbortSignal.timeout(SIGN_OUT_API_TIMEOUT_MS),
        });
      } catch {
        // Already signed out in the browser; the api session ends at expiry.
      }
    },
  },
} satisfies NextAuthConfig;
