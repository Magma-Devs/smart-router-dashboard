/**
 * Where the suite points and what it knows about the deployment it is pointing
 * at. Every value has a default matching what `playwright.config.ts` boots, so
 * a plain `pnpm e2e` needs no environment at all.
 *
 * Set `E2E_WEB_URL` / `E2E_API_URL` to run against a stack that is already up
 * (`make accounts`), in which case the config starts no servers of its own —
 * then `E2E_AUTH_SECRET`, `E2E_SETUP_TOKEN` and `E2E_DATABASE_URL` have to match
 * that stack.
 */

/**
 * `localhost`, not `127.0.0.1`. Next's dev server serves its client chunks only
 * to origins it recognises, and an unrecognised one is refused with a warning
 * and no error — the page arrives, never hydrates, and every form submits
 * natively. It costs an afternoon to diagnose from the symptom.
 */
export const WEB_URL = process.env.E2E_WEB_URL ?? "http://localhost:3000";
export const API_URL = process.env.E2E_API_URL ?? "http://localhost:8000";

/** True when the suite owns the servers — see `playwright.config.ts`. */
export const MANAGED_STACK = !process.env.E2E_WEB_URL && !process.env.E2E_API_URL;

/** Shared with the api and the web: the HS256 key the session token is signed
 *  with. Dev value; it is the same one `docker-compose.dev.yml` defaults to. */
export const AUTH_SECRET = process.env.E2E_AUTH_SECRET ?? "dev-secret-change-me-please-32chars!";

/** What `/auth/setup` demands on a fresh install. */
export const SETUP_TOKEN = process.env.E2E_SETUP_TOKEN ?? "installer-printed-this-token";

/** Lets the api believe the `clientContext` the web forwards. */
export const INTERNAL_AUTH_SECRET = process.env.E2E_INTERNAL_AUTH_SECRET ?? "dev-internal-secret";

/** 32 bytes, base64 — the key two-factor secrets are sealed with. Same dev
 *  value as the compose default, so a suite run and a `make accounts` stack can
 *  share a database without orphaning each other's enrolments. */
export const TOTP_ENCRYPTION_KEY =
  process.env.E2E_TOTP_ENCRYPTION_KEY ?? "ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=";

/** The accounts database. Defaults to the port `docker-compose.dev.yml`
 *  publishes, so `make accounts` is enough to run the suite locally. */
export const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgres://sr:dev@localhost:5434/sr_dashboard";

/** The account `/auth/setup` creates, and the one every spec invites from. */
export const OPERATOR = {
  email: "e2e.operator@magmadevs.com",
  password: "operator-chose-this-4471",
  name: "E2E Operator",
} as const;
