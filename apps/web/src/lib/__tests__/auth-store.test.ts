import { describe, expect, it, vi } from "vitest";
import { authReady, isAuthReady, markAuthReady, subscribeAuth } from "../auth-store";

/**
 * The moment the session has been read, as a render sees it.
 *
 * The two-factor gate waits on it when the server could not say whether the
 * person must enrol: until the session is read there is nothing to ask the api
 * with, and a null answer means "not asked yet", not "no answer". So the flag
 * has to start false, turn true exactly when `authReady()` resolves, and tell
 * the components subscribed to the store — or the gate would wait forever.
 */
describe("isAuthReady", () => {
  it("is false until the session has been read, then true for good", async () => {
    expect(isAuthReady()).toBe(false);

    const listener = vi.fn();
    const unsubscribe = subscribeAuth(listener);
    markAuthReady();

    expect(isAuthReady()).toBe(true);
    await expect(authReady()).resolves.toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);

    // The bridge calls this on every session change; only the first one is news.
    markAuthReady();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isAuthReady()).toBe(true);
    unsubscribe();
  });
});
