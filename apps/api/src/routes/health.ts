import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

/**
 * How long readiness waits for the database to answer `select 1`. Under the
 * chart's probe (timeoutSeconds 5) this leaves room for the Prometheus ping
 * beside it; a connection that hangs — a failover in progress, a security
 * group that stopped admitting the pod — reads as `timeout`, not as a probe
 * that never answered.
 */
export const DB_READY_TIMEOUT_MS = 3_000;
let dbReadyTimeoutMs = DB_READY_TIMEOUT_MS;

/** Tests only — a probe timeout measured in seconds would make them slow. */
export function setDbReadyTimeoutForTests(ms: number): void {
  dbReadyTimeoutMs = ms;
}

/**
 * What `components.database` says.
 *
 *  - `ok`             — `select 1` came back
 *  - `not_connected`  — the lazy connect loop (`plugins/db.ts`) has not
 *                       succeeded: Postgres is unreachable, the credential is
 *                       refused, or migrations are still running
 *  - `query_failed`   — connected once, but the query failed now
 *  - `timeout`        — no answer within `DB_READY_TIMEOUT_MS`
 */
export type DatabaseReadiness = "ok" | "not_connected" | "query_failed" | "timeout";

/**
 * The database's answer, or null when the api runs without one.
 *
 * Only `AUTH_MODE=enabled` registers the db plugin, and only then does the api
 * depend on Postgres at all: the gate resolves every session against it and
 * fails closed (503) while it is unreachable. A backend in that state used to
 * be Ready — its probe pinged Prometheus alone — so a rollout happily replaced
 * a working pod with one that could serve nobody. Checking the database here
 * is what makes the fleet's surge-first rollout safe to merge in either order:
 * a pod whose database does not answer never takes a serving pod's place.
 */
async function databaseReadiness(app: FastifyInstance): Promise<DatabaseReadiness | null> {
  if (!app.hasDecorator("db")) return null;
  const db = app.db;
  if (!db) return "not_connected";

  // The probe never rejects, so a query that fails after the deadline won is
  // an answered promise, not an unhandled rejection.
  const probe: Promise<DatabaseReadiness> = db.execute(sql`select 1`).then(
    () => "ok" as const,
    (err: unknown) => {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "readiness: the database did not answer select 1",
      );
      return "query_failed" as const;
    },
  );
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<DatabaseReadiness>((resolve) => {
    timer = setTimeout(() => resolve("timeout"), dbReadyTimeoutMs);
  });
  try {
    return await Promise.race([probe, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", { schema: { tags: ["Health"], summary: "Liveness probe" } }, async () => ({
    health: "ok",
  }));

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["Health"],
        summary: "Readiness probe (pings Prometheus, and the database under AUTH_MODE=enabled)",
      },
    },
    async (_request, reply) => {
      const [prometheus, database] = await Promise.all([app.prom.ping(), databaseReadiness(app)]);
      const ready = prometheus && (database === null || database === "ok");
      if (!ready) reply.status(503);
      return {
        status: ready ? "ready" : "not_ready",
        components: {
          prometheus: prometheus ? "ok" : "ping_failed",
          // Absent with auth off: the api has no database then, and a key
          // saying so would read as a component that is missing.
          ...(database === null ? {} : { database }),
        },
      };
    },
  );
}
