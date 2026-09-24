import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import {
  API_URL,
  AUTH_SECRET,
  DATABASE_URL,
  INTERNAL_AUTH_SECRET,
  MANAGED_STACK,
  SETUP_TOKEN,
  TOTP_ENCRYPTION_KEY,
  WEB_URL,
} from "./support/env.js";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Env shared by both servers. Deliberately close to what
 * `docker-compose.accounts.yml` sets, with two differences that matter:
 *
 *  - `PASSWORD_BREACH_CHECK=off`. The check calls HaveIBeenPwned, and a CI
 *    runner without egress fails the seeded passwords rather than the feature.
 *    It fails *open* in the product, but the whole point of a gate is that it
 *    does not depend on the network being up.
 *  - `PROMETHEUS_URL` points nowhere. Nothing under test reads a metric, and an
 *    unreachable store is answered with empty panels by design — the honesty
 *    contract — so this exercises the same path a real outage does.
 */
const serverEnv: Record<string, string> = {
  AUTH_MODE: "enabled",
  AUTH_SECRET,
  DATABASE_URL,
  DEPLOYMENT_MODE: "onprem",
  SETUP_TOKEN,
  INTERNAL_AUTH_SECRET,
  TOTP_ENCRYPTION_KEY,
  PASSWORD_BREACH_CHECK: "off",
  PUBLIC_WEB_ORIGIN: WEB_URL,
  CORS_ORIGINS: WEB_URL,
  ADMIN_EMAIL: "",
  ADMIN_PASSWORD: "",
  PROMETHEUS_URL: "http://127.0.0.1:9",
  LOG_LEVEL: "warn",
};

export default defineConfig({
  testDir: "./specs",
  /** Warms the dev server's per-route compile — see the file. */
  globalSetup: "./global-setup.ts",
  outputDir: "./.playwright/results",
  /**
   * Serial, one worker, and that is not a temporary limitation.
   *
   * The suite shares one deployment, and the flows it exercises are global by
   * nature: the enrolment gate is a property of an account, the rate limiter is
   * a property of an address, and a second browser signing in concurrently
   * changes both. Parallel workers would each need their own database and their
   * own api — worth it for a suite of a hundred, not for five.
   */
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  /** Generous: a step boundary is 30s, and two specs wait one out. */
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],

  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  /**
   * Boot the stack unless one is already pointed at.
   *
   * `next dev` rather than a production build: `AUTH_MODE` is read at request
   * time by the layout and at module scope by the edge proxy, and a built
   * bundle can inline the second — which would serve a disabled-mode shell
   * against an auth-enabled api and fail every spec for a reason that has
   * nothing to do with two-factor.
   *
   * The api runs `tsx src/main.ts` rather than its `dev` script: the watcher
   * that script adds has nothing to watch here and one more thing to shut down.
   */
  webServer: MANAGED_STACK
    ? [
        {
          command: "pnpm --filter @sr/api exec tsx src/main.ts",
          cwd: repoRoot,
          url: `${API_URL}/health`,
          env: serverEnv,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          command: "pnpm --filter @sr/web dev",
          cwd: repoRoot,
          // A page, not the config route: a route handler compiles on its
          // own and proves nothing about whether the app does.
          url: `${WEB_URL}/login`,
          env: {
            ...serverEnv,
            NEXT_PUBLIC_API_URL: API_URL,
            DASHBOARD_API_URL: API_URL,
            INTERNAL_API_BASE_URL: API_URL,
            AUTH_URL: WEB_URL,
          },
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
      ]
    : undefined,
});
