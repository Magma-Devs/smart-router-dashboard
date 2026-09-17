import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createDb, migrate, seedAdmin, type Database, type DbHandle } from "@sr/db";
import { config } from "../config.js";
import { needsSetup, resolveSetupToken } from "../services/setup.js";

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
/**
 * The `ADMIN_EMAIL` / `ADMIN_PASSWORD` seed — **development only, and refused
 * outright in production.**
 *
 * It predates first-run setup, and against the ticket it fails three lines at
 * once: "that first-run page requires the setup token the installer prints"
 * (this needs none), "we never set a password for anyone" (this sets one from
 * the environment), and "we keep no standing admin account inside a customer's
 * deployment" (this is exactly that, for as long as the variables stay set).
 *
 * Both paths open on the same condition — no active users — so leaving it
 * enabled means the room has two doors and only one of them is locked. In
 * production the setup token is the only way in.
 *
 * It stays for development because `make dev-auth` would otherwise need someone
 * to walk through /setup on every `down -v`; `make accounts` is the target that
 * deliberately does not seed, and is the one to use for testing the real flow.
 */
export async function maybeSeedAdmin(app: FastifyInstance, db: Database): Promise<void> {
  const email = process.env.ADMIN_EMAIL ?? config.auth.adminEmail;
  const password = process.env.ADMIN_PASSWORD ?? config.auth.adminPassword;
  if (!email || !password) return;

  // Read live rather than from the config snapshot, which is taken at module
  // load — the same reason the auth plugin re-reads AUTH_SECRET.
  const env = process.env.NODE_ENV ?? config.env;
  if (env === "production") {
    app.log.warn(
      { email },
      "ADMIN_EMAIL/ADMIN_PASSWORD are set but ignored in production — the first admin is created " +
        "through the first-run page with the installer's setup token, and nowhere else. " +
        "Unset them so nobody expects a standing admin account.",
    );
    return;
  }

  const result = await seedAdmin(db, { email, password });
  app.log.warn({ result, email }, "development-only admin seed applied (ignored in production)");
}

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
    throw new Error("AUTH_MODE=enabled requires DATABASE_URL (postgres://user:pass@host:5432/db).");
  }

  app.decorate("db", null as Database | null);
  let handle: DbHandle | null = null;
  let stopped = false;

  const connectLoop = (async () => {
    for (let attempt = 1; !stopped; attempt++) {
      try {
        const candidate = createDb(url);
        await migrate(candidate.db);
        await maybeSeedAdmin(app, candidate.db);
        // Resolve (and, when unconfigured, generate + log + write) the setup
        // token now rather than on the first attempt to use it. With the seed
        // refused in production this is the only way into a fresh install, and
        // a token that materialises only after somebody has already guessed
        // wrong is not a token anybody can find. SETUP_TOKEN_FILE especially:
        // an init container reads it before the api has served a request.
        if (await needsSetup(candidate.db)) resolveSetupToken(app.log);
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
