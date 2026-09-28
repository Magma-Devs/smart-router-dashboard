import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    name: "web",
    // `chain-methods.test.ts` and `method-search.test.ts` await `catalogReady`
    // in a `beforeAll` — a dynamic import of the whole spec-index catalog —
    // and vitest allows a hook 10s by default. Loading it is not slow; doing
    // it while `apps/api` and `packages/db` boot a pglite per test under
    // `pnpm -r test` is, and the machine decides how much.
    //
    // Over the default the HOOK fails, which fails the whole file and skips
    // every test in it — a different set each run, so it reads as a flaky
    // suite rather than a busy one. `apps/api` and `packages/db` were given
    // this ceiling for the same reason; `apps/web` was the package that
    // missed out.
    //
    // `testTimeout` stays at the default on purpose: nothing here does work
    // inside a test body, so raising it would only delay the report of a
    // genuine hang.
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
