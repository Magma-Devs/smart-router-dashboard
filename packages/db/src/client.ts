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
 * How many connections one process holds, and how long an idle one is kept.
 *
 * Every authenticated request takes a connection for the session join, so
 * `max` bounds a backend's concurrency — and, summed over every backend of a
 * deployment, what its Postgres has to admit. A fleet that runs one backend
 * per node against a shared instance sizes this from the instance's connection
 * budget, which is why it is a knob rather than a constant.
 */
export interface DbPoolOptions {
  /** Connections this process may hold open at once. At least 1. */
  max?: number;
  /** Seconds a connection may sit idle before it is closed; the next request
   *  then pays for a new one — TCP, TLS and three SCRAM legs, about seven round
   *  trips. `0` keeps idle connections open for the life of the process. */
  idleTimeout?: number;
}

/** What `createDb` uses for anything a caller leaves out — the values the api
 *  always ran with, so a deployment that sets nothing is unchanged. The api
 *  reads `DB_POOL_MAX` / `DB_IDLE_TIMEOUT_S` on top of these
 *  (`readDbPoolOptions` in its config). */
export const DEFAULT_DB_POOL: Readonly<Required<DbPoolOptions>> = { max: 20, idleTimeout: 30 };

/**
 * Everything `createDb` takes beside the URL: the pool, and how the server is
 * verified when the socket does not go to the server itself.
 */
export interface DbConnectOptions extends DbPoolOptions {
  /**
   * The name the server's TLS certificate must carry — set when the URL points
   * at a local proxy rather than at the database.
   *
   * The fleet's backends reach a private RDS instance through a cloudflared
   * sidecar listening on `127.0.0.1:5432` in the pod, so `DATABASE_URL` names
   * the loopback address while the TLS session still terminates on RDS. Node
   * verifies a certificate against the name it dialled, and an IP address in
   * the URL has no name to verify, which would silently defeat the check. With
   * this set, TLS is always on, the chain is verified against the trusted CAs
   * (`NODE_EXTRA_CA_CERTS` for the RDS bundle) and the certificate must name
   * exactly this host — `sslmode=verify-full` with the name supplied — whatever
   * the URL's own `sslmode` says. Unset, the URL decides, as it always did.
   */
  tlsServername?: string;
}

/** A DNS name: labels of letters, digits and hyphens, joined by dots. An IP
 *  address is refused on purpose — RDS certificates name the endpoint, never
 *  an address, so an IP here would fail every connection. */
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export function isTlsServername(value: string): boolean {
  return HOSTNAME.test(value) && !/^[0-9.]+$/.test(value);
}

/**
 * Open a Postgres connection and return a Drizzle handle. Caller owns
 * lifecycle — call `handle.sql.end()` on shutdown to close the pool.
 *
 * Pool size follows what the gate does, not what the routes do: since the
 * session became a row, **every authenticated request** resolves it with one
 * indexed join, so this is on the path of the metrics hot path too rather than
 * beside it. The default is sized for a team's concurrent panels — each
 * dashboard page fans out several polls — with room to queue rather than to sit
 * idle; a backend that shares its instance with many others sets it lower.
 *
 * A pool that could hold nothing, or a negative idle timeout, is refused here
 * rather than handed to the driver: postgres-js would take `max: 0` and then
 * never answer a query. So is a TLS server name that is not a DNS name — the
 * driver would accept it and every connection would then fail its name check.
 */
export function createDb(databaseUrl: string, options: DbConnectOptions = {}): DbHandle {
  const max = options.max ?? DEFAULT_DB_POOL.max;
  const idleTimeout = options.idleTimeout ?? DEFAULT_DB_POOL.idleTimeout;
  const tlsServername = options.tlsServername?.trim() || undefined;
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`database pool size must be a whole number of at least 1, got ${String(max)}`);
  }
  if (!Number.isInteger(idleTimeout) || idleTimeout < 0) {
    throw new Error(
      `database idle timeout must be a whole number of seconds, 0 or more, got ${String(idleTimeout)}`,
    );
  }
  if (tlsServername !== undefined && !isTlsServername(tlsServername)) {
    throw new Error(
      `database TLS server name must be a DNS name (letters, digits, dots, hyphens — no scheme, port or address), got ${JSON.stringify(options.tlsServername)}`,
    );
  }
  // An object `ssl` is handed to tls.connect as it is: it switches TLS on
  // whatever the URL says and overrides the servername the driver derives
  // from the host — the one it dialled, or none for an IP address.
  const sql = postgres(databaseUrl, {
    max,
    idle_timeout: idleTimeout,
    connect_timeout: 10,
    ...(tlsServername ? { ssl: { servername: tlsServername } } : {}),
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
