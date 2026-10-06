"use client";

import { createContext, useContext } from "react";

/**
 * Whether this deployment renders the 0.28 screens (`DASHBOARD_NEW_UI`, see
 * `lib/new-ui.ts`).
 *
 * Read by the root layout, a server component, and handed down rather than
 * fetched — the same reason `auth-mode.tsx` gives: a fetch resolves after the
 * first paint, so asking would draw one UI for a moment and then the other.
 */
const NewUiContext = createContext(false);

export function NewUiProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  return <NewUiContext.Provider value={enabled}>{children}</NewUiContext.Provider>;
}

/** True when `DASHBOARD_NEW_UI=true`. Default false: the 0.27 screens. */
export function useNewUi(): boolean {
  return useContext(NewUiContext);
}
