import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

/**
 * Auth.js v5 entry. The route handler in `app/api/auth/[...nextauth]/route.ts`
 * re-exports `handlers`, and server-side code uses `auth()` to read the
 * current session. Only meaningful when AUTH_MODE=enabled.
 */
export const { handlers, signIn, signOut, auth } = NextAuth(authConfig);
