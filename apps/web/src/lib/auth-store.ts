"use client";

/**
 * Tiny module-level auth store (lava-connect's ApiTokenBridge pattern).
 * `ApiTokenBridge` mirrors the Auth.js session into it once per page
 * load; `api-client` reads the Bearer from here so every data fetch is
 * authenticated without threading the session through every call site.
 *
 * In AUTH_MODE=disabled nothing ever writes to the store — the token
 * stays null and `api-client` skips the Authorization header (it also
 * never awaits `authReady()` because /api/config reports the mode).
 */

export interface AuthUserInfo {
  email: string;
  name: string | null;
  avatarUrl?: string | null;
  role: "admin" | "member";
}

interface AuthState {
  token: string | null;
  user: AuthUserInfo | null;
}

let state: AuthState = { token: null, user: null };
let version = 0;
const listeners = new Set<() => void>();

let readyResolve: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

export function setAuthState(next: AuthState): void {
  state = next;
  version++;
  for (const l of listeners) l();
}

/** Called by ApiTokenBridge once the session has settled (either way). */
export function markAuthReady(): void {
  readyResolve?.();
}

/** Resolves once the session has been read (token present or absent). */
export function authReady(): Promise<void> {
  return readyPromise;
}

export function getAuthToken(): string | null {
  return state.token;
}

export function getAuthState(): AuthState {
  return state;
}

/** For useSyncExternalStore in the Shell. */
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAuthVersion(): number {
  return version;
}
