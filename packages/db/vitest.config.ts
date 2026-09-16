import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "db",
    // Every test here builds a fresh in-process Postgres — `new PGlite()` plus
    // a replay of every migration — and that happens in a hook, where vitest
    // allows 10s by default. Booting a WASM database is not slow, but doing
    // several at once while `apps/api` does the same under `pnpm -r test` is,
    // and the machine decides how many "at once" means.
    //
    // Over the default, a whole file fails with `Hook timed out in 10000ms` and
    // a different set of tests each run, which reads as a flaky suite rather
    // than a busy one. Raising the ceiling costs a passing run nothing: it is
    // how long a hang waits before being called a failure, not work anyone
    // does. Keep it well clear of the worst case rather than tuned to it.
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
