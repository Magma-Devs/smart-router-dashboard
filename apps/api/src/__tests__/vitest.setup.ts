import { beforeEach } from "vitest";
import { setPasswordCostForTests } from "../services/password.js";

/**
 * Runs before every test file in this package (`setupFiles` in
 * `vitest.config.ts`).
 *
 * Passwords hash at bcrypt cost 4 rather than the production 12: the fixtures
 * that seed an account with a password outnumber the tests about hashing many
 * times over, and at cost 12 each one costs a quarter of a second. Set before
 * each test rather than once, so a test that needs the production cost can
 * take it for itself without putting it back.
 */
beforeEach(() => {
  setPasswordCostForTests(4);
});
