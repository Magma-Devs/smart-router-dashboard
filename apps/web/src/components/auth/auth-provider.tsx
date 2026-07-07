"use client";

import { SessionProvider, useSession } from "next-auth/react";
import { useEffect } from "react";
import { markAuthReady, setAuthState } from "@/lib/auth-store";

/**
 * Mirrors the Auth.js session into the module-level auth store so
 * `api-client` can attach the Bearer token and the Shell can render the
 * signed-in user — without every consumer needing useSession().
 */
function ApiTokenBridge() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "loading") return;
    setAuthState({
      token: session?.accessToken ?? null,
      user: session?.user
        ? {
            email: session.user.email,
            name: session.user.name ?? null,
            avatarUrl: session.user.avatarUrl ?? null,
            role: session.user.role,
          }
        : null,
    });
    markAuthReady();
  }, [session, status]);

  return null;
}

/**
 * Mounted by the root layout ONLY when AUTH_MODE=enabled. In disabled
 * mode the layout renders children bare — no session fetch, no bridge,
 * and the auth store stays empty (which the Shell reads as "no auth").
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ApiTokenBridge />
      {children}
    </SessionProvider>
  );
}
