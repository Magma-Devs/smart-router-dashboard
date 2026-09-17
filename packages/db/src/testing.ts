import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
import type { Database } from "./client.js";

/**
 * A real Postgres, in-process, for tests.
 *
 * pglite is Postgres 16 compiled to WASM — same planner, same types, same
 * constraint enforcement, no Docker and no service container. That matters here
 * because the behaviour this schema leans on hardest is exactly what a hand-rolled
 * fake can't reproduce: the partial unique index on `lower(email)`, conditional
 * single-use updates that are correct only if the rowcount is real, and cascade
 * on delete.
 *
 * Each call gets its own isolated in-memory database with every migration
 * applied. Test-only — never imported by `src/index.ts`, so nothing ships it.
 *
 * **Per-test isolation is deliberate, and it is the expensive choice.** The
 * suite now stands up one instance per test, each replaying every migration,
 * with `apps/api` doing the same in parallel — so the cost grows with both the
 * test count and the migration count. If tests start failing under load, raise
 * vitest's `testTimeout` first. Sharing an instance across tests would be the
 * obvious saving and the wrong one: it trades a rare timeout for cross-test
 * state leaking through a shared database, which is a subtler bug than the one
 * it fixes and much harder to attribute.
 */
export interface TestDb {
  db: Database;
  /** Free the WASM instance. Call in `afterEach`/`afterAll`. */
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite();
  const db = drizzle(client, { schema });

  // src/testing.ts -> ../migrations (dev, via vitest)
  // dist/testing.js -> ../migrations (built)
  const here = dirname(fileURLToPath(import.meta.url));
  await migrate(db, { migrationsFolder: resolve(here, "..", "migrations") });

  return { db, close: () => client.close() };
}

/**
 * The two columns a fixture needs so the api's must-enrol gate lets it past.
 *
 * MAG-2730 shut the dashboard to anyone without an authenticator, which is the
 * ticket's whole point — and it means every HTTP-level test whose subject is
 * something else (invitations, roles, the audit log, the Magma account label)
 * has to seed an account that has one, or it spends its time asserting 403.
 *
 * Spread into the insert:
 *
 * ```ts
 * await db.insert(users).values({ email: "a@b.c", role: "admin", ...enrolledTwoFactor() })
 * ```
 *
 * The secret is a **fixed, invalid envelope on purpose**. These fixtures never
 * submit a code — they hold a session token already — so the gate's question
 * ("is there an enrolled secret") is answered without any test needing a real
 * key configured. A test that actually verifies codes seals a real one; that is
 * `apps/api/src/__tests__/two-factor.test.ts`, and it is the only place the
 * enrolment and challenge paths are exercised.
 */
export function enrolledTwoFactor(): { totpSecret: string; totpEnrolledAt: Date } {
  return { totpSecret: "fixture-not-a-real-envelope", totpEnrolledAt: new Date("2026-01-01") };
}
