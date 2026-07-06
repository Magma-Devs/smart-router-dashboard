import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createDb, migrate, seedAdmin, type Database, type DbHandle } from "@sr/db";
import { config } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Drizzle handle — null until the lazy connect loop succeeds. */
    db: Database | null;
    /** Resolves once migrations + seed have run. Rejects only on shutdown. */
    dbReady: Promise<void>;
  }
}

/** Compose has no hard depends_on between api and postgres (AUTH_MODE=
 *  disabled must boot without a DB), so the api absorbs postgres's startup
 *  window by retrying forever: 2s between early attempts, backing off to
 *  30s so a DB that appears hours later still gets picked up without a
 *  restart. /auth/* answers 503 the whole time; nothing else blocks. */
const RETRY_DELAY_MS = 2_000;
const RETRY_DELAY_MAX_MS = 30_000;

/**
 * Registered ONLY when AUTH_MODE=enabled. Opens Postgres in the background
 * (retry loop), runs migrations, seeds the bootstrap admin, then flips
 * `app.db` from null to the live handle. Routes that need the DB check
 * `app.db` and 503 while it's still null — the rest of the api (metrics,
 * health) never blocks on the database.
 */
export const dbPlugin = fp(async (app: FastifyInstance) => {
  // Live env first (config snapshots at module load, before tests set it).
  const url = process.env.DATABASE_URL ?? config.auth.databaseUrl;
  if (!url) {
    throw new Error(
      "AUTH_MODE=enabled requires DATABASE_URL (postgres://user:pass@host:5432/db).",
    );
  }

  app.decorate("db", null as Database | null);
  let handle: DbHandle | null = null;
  let stopped = false;

  const connectLoop = (async () => {
    for (let attempt = 1; !stopped; attempt++) {
      try {
        const candidate = createDb(url);
        await migrate(candidate.db);
        const adminEmail = process.env.ADMIN_EMAIL ?? config.auth.adminEmail;
        const adminPassword = process.env.ADMIN_PASSWORD ?? config.auth.adminPassword;
        if (adminEmail && adminPassword) {
          const result = await seedAdmin(candidate.db, {
            email: adminEmail,
            password: adminPassword,
          });
          app.log.info({ result }, "admin seed");
        } else {
          app.log.warn(
            "AUTH_MODE=enabled but ADMIN_EMAIL/ADMIN_PASSWORD are not set — no bootstrap admin will be seeded",
          );
        }
        handle = candidate;
        app.db = candidate.db;
        app.log.info({ attempt }, "database connected, migrations applied");
        return;
      } catch (err) {
        const delay = Math.min(RETRY_DELAY_MS * Math.ceil(attempt / 10), RETRY_DELAY_MAX_MS);
        app.log.warn(
          { attempt, retryInMs: delay, err: (err as Error).message },
          "database not ready, retrying",
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  })();

  app.decorate("dbReady", connectLoop);

  app.addHook("onClose", async () => {
    stopped = true;
    await handle?.sql.end({ timeout: 5 });
  });
});
