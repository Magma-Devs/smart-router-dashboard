import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "api",
    // Same reason as `packages/db` — the db-backed tests here build a fresh
    // pglite per test through `@sr/db/testing`, in a hook whose default
    // ceiling is 10s. Under `pnpm -r test` both suites do it at once, and on a
    // busy machine that lands as `Hook timed out in 10000ms` across whole
    // files. The timeout is how long a hang waits before failing, so a
    // generous one slows nothing down.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
