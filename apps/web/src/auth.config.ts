import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Discord from "next-auth/providers/discord";
import Credentials from "next-auth/providers/credentials";
import { jwtVerify, SignJWT } from "jose";

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

export type UserRole = "admin" | "member";

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

declare module "next-auth" {
  interface User {
    role?: UserRole;
    avatarUrl?: string | null;
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

/** A provider is offered only when BOTH halves of its credential pair are
 *  set — this is what makes the login page's badges conditional. */
export const oauthProviderFlags = {
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  github: !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
  discord: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
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
if (oauthProviderFlags.discord) {
  providers.push(
    Discord({
      clientId: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
    }),
  );
}
providers.push(
  Credentials({
    name: "Credentials",
    credentials: {
      email: { label: "Email", type: "email" },
      password: { label: "Password", type: "password" },
    },
    async authorize(credentials) {
      const email = credentials?.email;
      const password = credentials?.password;
      if (typeof email !== "string" || typeof password !== "string") return null;

      try {
        const res = await fetch(`${apiBase}/auth/sign-in`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { user: SignInUserPayload };
        return {
          id: body.user.id,
          email: body.user.email,
          name: body.user.name,
          avatarUrl: body.user.avatarUrl ?? null,
          role: body.user.role,
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
        role: (token.role as UserRole) ?? "member",
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
          role: (payload.role as UserRole) ?? "member",
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
      if (provider !== "google" && provider !== "github" && provider !== "discord") return true;

      const token = provider === "google" ? account.id_token : account.access_token;
      if (!token) return false;

      try {
        const res = await fetch(`${apiBase}/auth/oauth/${provider}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { user: SignInUserPayload };
        user.id = body.user.id;
        user.email = body.user.email;
        user.name = body.user.name ?? null;
        user.avatarUrl = body.user.avatarUrl ?? null;
        user.role = body.user.role;
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
      }
      return token;
    },
    async session({ session, token }) {
      session.user.id = (token.id as string) ?? "";
      session.user.role = (token.role as UserRole) ?? "member";
      session.user.email = (token.email as string) ?? session.user.email;
      session.user.name = (token.name as string | null | undefined) ?? null;
      session.user.avatarUrl = (token.avatarUrl as string | null | undefined) ?? null;
      // Re-sign the api Bearer here — the custom `encode` only persists
      // the base claims into the cookie, so a token stashed on `token`
      // would be dropped on the next decode (lava-connect's lesson).
      session.accessToken = await new SignJWT({
        sub: session.user.id,
        email: session.user.email,
        role: session.user.role,
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
