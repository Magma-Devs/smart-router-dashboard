import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    // Same reason as `packages/db` — the db-backed tests here open a pglite
    // per test through `@sr/db/testing`, in a hook whose default
    // ceiling is 10s. Under `pnpm -r test` both suites do it at once, and on a
    // busy machine that lands as `Hook timed out in 10000ms` across whole
    // files. The timeout is how long a hang waits before failing, so a
    // generous one slows nothing down.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    env: {
      // Route tests build one app and swap the canned store between cases;
      // with the client's answer cache on, a case would read the previous
      // case's answers. The cache's own tests pass an explicit TTL.
      PROMETHEUS_CACHE_TTL_MS: "0",
    },
    setupFiles: ["./src/__tests__/vitest.setup.ts"],
  },
});
