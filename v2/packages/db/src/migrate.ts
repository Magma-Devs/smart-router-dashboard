import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./client.js";

/**
 * Apply pending SQL migrations from `packages/db/migrations/`. Idempotent:
 * Drizzle tracks which files have run via the `__drizzle_migrations` table.
 *
 * The migrations folder lives next to this file in dev (src/ at runtime
 * via tsx) and at the package root in prod (dist/ siblings the migrations/
 * directory). Resolve relative to this module so both paths work.
 */
export async function migrate(db: Database): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/migrate.ts -> ../migrations  (dev: src is at packages/db/src)
  // dist/migrate.js -> ../migrations (prod: dist is at packages/db/dist)
  const migrationsFolder = resolve(here, "..", "migrations");
  await drizzleMigrate(db, { migrationsFolder });
}
