"use client";

import { useApi } from "@/hooks/use-api";
import { getAuthState } from "@/lib/auth-store";
import { roleAtLeast, type Role } from "@sr/shared";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: Role;
}

/**
 * Who the signed-in person is **right now**, from the account row rather than
 * from the session.
 *
 * The session's `role` is stamped once at sign-in and never refreshed —
 * `auth.config.ts`'s `jwt()` callback only sets `token.role` when `user` is
 * present, which is the sign-in call. So a promotion or a demotion never
 * reached the browser: a demoted person kept seeing admin buttons that then
 * 403'd, and a promoted one saw none of their new ones, until they signed in
 * again. Up to thirty days of the screen disagreeing with the server.
 *
 * The api was never wrong — it authorises from this same row on every request,
 * which is what "a role change takes effect straight away" means. This is what
 * lets the UI say the same thing.
 *
 * Polling rather than an event, because a role change originates on somebody
 * else's screen and there is no channel to push it down. Fifteen seconds is the
 * house default and is fast enough: the api refuses the moment the row changes,
 * so the window is one of *looking* wrong, never of *being* permissive.
 */
export function useMe(): { me: Me | null; isAdmin: boolean; loading: boolean } {
  // The store is empty in AUTH_MODE=disabled, where these routes are not even
  // registered — asking would 404 on every page. It is also empty before the
  // session bridge has run, and asking then would race it.
  const bridged = getAuthState().user;
  const { data, isLoading } = useApi<Me>(bridged ? "/api/account/me" : null);

  // Fall back to the session while the first read is in flight, so the sidebar
  // does not flicker from a name to a placeholder and back on every navigation.
  const me: Me | null =
    data ??
    (bridged
      ? {
          id: "",
          email: bridged.email,
          name: bridged.name,
          avatarUrl: bridged.avatarUrl ?? null,
          role: bridged.role,
        }
      : null);

  return {
    me,
    // Only ever from the live row. A stale `true` here would draw controls that
    // cannot work, which is the defect this hook exists to remove.
    isAdmin: roleAtLeast(data?.role, "admin"),
    loading: isLoading && !data,
  };
}
