import { afterAll } from "vitest";
import { closeSharedTestDb } from "../testing.js";

/**
 * Runs before every test file in this package (`setupFiles` in
 * `vitest.config.ts`). The database the file's tests share is freed once the
 * file is done.
 */
afterAll(() => closeSharedTestDb());
