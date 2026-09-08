import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { jwtVerify, SignJWT } from "jose";
import type { Role } from "@sr/shared";

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

/** Server-side base URL for talking to the api from inside Auth.js
 *  callbacks. In docker compose the api is reachable as `http://api:8000`
 *  from the web container while the browser hits `http://localhost:8000`. */
const apiBase =
  process.env.INTERNAL_API_BASE_URL ??
  process.env.DASHBOARD_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000";

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

/** `/auth/sign-in` opens the session row and returns its id; it rides in the
 *  token's `sid` claim and the api resolves it on every request. A token
 *  without one is refused, so this is not optional. */
interface SignInResponse {
  user: SignInUserPayload;
  /** Absent when the api answered `twoFactorRequired` — a verified password
   *  opens no session, so there is nothing to address. */
  sessionId?: string;
}

/**
 * What the browser told *us*, forwarded to the api so the session row and the
 * audit log record the person's own address rather than this container's.
 *
 * The api only believes it alongside `INTERNAL_AUTH_SECRET`; without that it
 * falls back to what it observes, so an attacker calling the public sign-in
 * endpoint directly cannot choose the address recorded against their attempts.
 */
function clientContextFrom(headers: Headers | null): {
  clientContext?: { ip?: string; userAgent?: string };
  internalHeaders: Record<string, string>;
} {
  const secret = process.env.INTERNAL_AUTH_SECRET;
  if (!headers || !secret) return { internalHeaders: {} };

  // The ingress appends the real client; take the left-most entry, which is the
  // originating address in the standard X-Forwarded-For ordering.
  const forwardedFor = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedFor || headers.get("x-real-ip") || undefined;
  const userAgent = headers.get("user-agent") ?? undefined;
  if (!ip && !userAgent) return { internalHeaders: {} };

  return {
    clientContext: { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) },
    internalHeaders: { "X-Internal-Auth": secret },
  };
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

/**
 * Email and password, and nothing else.
 *
 * Google, GitHub and Discord sign-in used to be here, offered whenever their
 * credential pair was configured. The ticket puts social sign-in out of scope
 * for a reason worth keeping in view: a personal account at one of those
 * providers is not administered by the customer's IT, so when somebody leaves
 * the company their corporate identity is disabled and that personal account
 * still opens the dashboard. SSO exists to close exactly that gap, and it
 * arrives as its own task when a customer asks for it.
 */
const providers: NextAuthConfig["providers"] = [];
providers.push(
  Credentials({
    name: "Credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
      /** Second step. Present together or not at all — see `authorize`. */
      challenge: { label: "Challenge", type: "text" },
      code: { label: "Authenticator code", type: "text" },
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
      const email = credentials?.email;
      if (typeof email !== "string") return null;

      const challenge = credentials?.challenge;
      const code = credentials?.code;
      const secondStep = typeof challenge === "string" && typeof code === "string" && !!challenge;

      const password = credentials?.password;
      if (!secondStep && typeof password !== "string") return null;

      const { clientContext, internalHeaders } = clientContextFrom(request?.headers ?? null);
      const url = secondStep ? `${apiBase}/auth/2fa/verify` : `${apiBase}/auth/sign-in`;
      const payload = secondStep
        ? { challenge, code, ...(clientContext ? { clientContext } : {}) }
        : { email, password, ...(clientContext ? { clientContext } : {}) };

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...internalHeaders },
          body: JSON.stringify(payload),
        });
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
      } catch {
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
      session.accessToken = await new SignJWT({
        sub: session.user.id,
        email: session.user.email,
        role: session.user.role,
        sid: (token.sid as string | undefined) ?? "",
      })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer(SESSION_JWT_ISSUER)
        .setAudience(SESSION_JWT_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(secretKey());
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
      // Invitation redemption is public, signed in or not. It used to bounce a
      // signed-in visitor to the dashboard — the rule was right (an invitation
      // creates an account for somebody who has none) but a silent redirect
      // reads as a broken link, and the person it strands is somebody with an
      // account clicking an invitation for a second address. The page explains
      // it and offers a sign-out that comes back here; the gate can't, because
      // it cannot see who the invitation is for.
      if (path.startsWith("/invite/")) return true;
      // Reset links are usable while signed in — the usual reason someone
      // follows one is that they think somebody else is signed in as them.
      if (path.startsWith("/reset/") || path === "/forgot-password") return true;
      // Enrolment needs a session and is reachable with one. Whether it is
      // *required* is the api's call — the edge cannot see the database, and a
      // gate that guessed would either strand somebody who has enrolled or wave
      // through somebody who has not. `TwoFactorGate` renders the block.
      if (path === "/account/two-factor") return signedIn;
      // Auth.js's own endpoints + the runtime-config route stay public.
      if (path.startsWith("/api/auth") || path === "/api/config") return true;
      // Static assets.
      if (path.startsWith("/_next/") || path === "/favicon.ico") return true;
      if (/\.[a-zA-Z0-9]+$/.test(path)) return true;

      // Everything else requires a session.
      return signedIn;
    },
  },
} satisfies NextAuthConfig;
