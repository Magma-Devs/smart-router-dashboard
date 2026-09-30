import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

/**
 * Edge proxy (Next.js 16's rename of `middleware.ts`). When
 * AUTH_MODE=enabled it runs the Auth.js `authorized` callback on every
 * request not excluded by the matcher — unauthed users hitting app routes
 * get redirected to /login, signed-in users hitting /login bounce to
 * /overview. When AUTH_MODE=disabled (the default) it's a no-op and the
 * dashboard keeps its open, zero-login behaviour.
 */
const authEnabled = process.env.AUTH_MODE === "enabled";

const { auth } = NextAuth(authConfig);

export default authEnabled ? auth : function proxy() { /* auth disabled — pass through */ };

export const config = {
  matcher: [
    // Run on everything except static assets and the auth-callback
    // endpoint itself (Auth.js handles those internally).
    "/((?!_next/static|_next/image|favicon.ico|api/auth).*)",
  ],
};
