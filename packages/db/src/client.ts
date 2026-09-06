import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

/**
 * Driver-agnostic Drizzle handle. Production opens it over postgres-js
 * (`createDb` below); tests open the same schema over pglite — real Postgres
 * in-process — via `@sr/db/testing`. Typing it as the base `PgDatabase` rather
 * than `PostgresJsDatabase` is what lets both flow through the same service
 * signatures without a cast.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/** The concrete postgres-js handle. Narrower than `Database` on purpose: the
 *  migrator is driver-specific, so it needs the real thing rather than the
 *  driver-agnostic view services use. */
export type PostgresDatabase = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: PostgresDatabase;
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
