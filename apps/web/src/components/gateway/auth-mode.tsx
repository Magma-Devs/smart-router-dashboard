"use client";

import { createContext, useContext } from "react";

/**
 * Whether this deployment has accounts at all.
 *
 * Read from `AUTH_MODE` by the authenticated layout, which is a server
 * component, and handed down rather than fetched. The client could ask
 * `/api/config`, but the sidebar and the account page render before any fetch
 * resolves, so asking would draw the signed-in chrome for a moment on a
 * deployment that has no accounts, then take it away.
 *
 * Not the same question as "is anybody signed in". That one the auth store
 * answers, and in `enabled` mode it is legitimately false for a moment on every
 * cold load. This is a property of the deployment and never changes.
 */
const AuthModeContext = createContext(false);

export function AuthModeProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <AuthModeContext.Provider value={enabled}>{children}</AuthModeContext.Provider>;
}

/** True when `AUTH_MODE=enabled`. Default false — the safe way to be wrong is
 *  to leave an account surface out, never to draw one that cannot work. */
export function useAuthMode(): boolean {
  return useContext(AuthModeContext);
}
