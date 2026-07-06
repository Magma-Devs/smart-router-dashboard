import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  /** The underlying postgres-js client — used for migrations + clean shutdown. */
  sql: Sql;
}

/**
 * Open a Postgres connection and return a Drizzle handle. Caller owns
 * lifecycle — call `handle.sql.end()` on shutdown to close the pool.
 *
 * Pool sized small (5 max): the dashboard api only touches the DB on
 * auth flows, not on the metrics hot path.
 */
export function createDb(databaseUrl: string): DbHandle {
  const sql = postgres(databaseUrl, {
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
