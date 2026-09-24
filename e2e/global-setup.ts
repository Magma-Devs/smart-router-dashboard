import { WEB_URL } from "./support/env.js";

/**
 * Compile the pages the suite touches before the first test looks at one.
 *
 * `next dev` compiles a route the first time it is asked for, and `fill()` and
 * `click()` wait for an element to be actionable — not for React to have
 * hydrated it. On a warm machine the gap is invisible; on a cold CI runner the
 * first form is clicked before its handlers exist and submits natively, which
 * looks exactly like the page being broken and nothing like a slow build.
 *
 * A plain GET is enough: the compile is per-route, not per-visitor.
 */
const WARM = ["/login", "/overview", "/team", "/account/two-factor"];

export default async function globalSetup(): Promise<void> {
  await Promise.all(
    WARM.map(async (path) => {
      try {
        await fetch(WEB_URL + path, { redirect: "manual" });
      } catch {
        // Not fatal. The server is up — `webServer.url` waited for it — and a
        // failure here costs a slow first navigation, not a wrong result.
      }
    }),
  );
}
