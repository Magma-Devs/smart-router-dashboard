import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresDatabase } from "./client.js";

/**
 * Apply pending SQL migrations from the package's `migrations/` directory.
 * Idempotent: Drizzle tracks which files have run via `__drizzle_migrations`.
 *
 * `migrations/` sits beside `src/` and `dist/`, so `../migrations` from this
 * module holds wherever the package lands: dev via tsx, a built dist, the
 * api image's deploy tree.
 */
export async function migrate(db: PostgresDatabase): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "..", "migrations");
  await drizzleMigrate(db, { migrationsFolder });
}
