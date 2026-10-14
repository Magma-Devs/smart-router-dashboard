import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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
 * Every call hands back a database with every migration applied and no rows in
 * it. Test-only — never imported by `src/index.ts`, so nothing ships it.
 *
 * **One instance per test file, wiped between tests.** The first call in a
 * process opens a pglite from the migrated snapshot `template()` keeps; every
 * later call truncates every table — `RESTART IDENTITY CASCADE`, so sequences
 * start over too — and hands the same instance back. Vitest runs each test
 * file in a process of its own, so nothing crosses a file boundary, and within
 * a file a test starts where a fresh instance would start it: the tables,
 * indexes and constraints the migrations made, untouched, and no rows. What
 * the wipe does not reach is state a test leaves outside the tables — a
 * session setting, an advisory lock held past its transaction — which no test
 * here does. A test that needs the database to itself, to watch its SQL or to
 * leave it in a state the next test must not see, passes `onQuery` and gets a
 * private instance.
 *
 * Why share at all: even from the snapshot a fresh instance costs about 0.3s —
 * pglite unpacking a 41 MB data dir into its in-memory filesystem — while the
 * truncate costs about 20ms, and the api suite opens one per test. The risk
 * the trade takes on is cross-test state leaking through the shared database;
 * the truncate between calls is what closes that door, and `testing.test.ts`
 * pins that it does.
 */
export interface TestDb {
  db: Database;
  /** Free a private instance. For the shared one this is a no-op: the
   *  package's vitest setup file frees it with `closeSharedTestDb()` once the
   *  file is done. Call in `afterEach`/`afterAll` either way. */
  close: () => Promise<void>;
}

export async function createTestDb(
  options: {
    /** Sees every statement drizzle sends, on a private instance. For
     *  asserting SQL a single-connection database can't exercise — a row lock
     *  needs a second connection to contend with, and pglite has one. */
    onQuery?: (sql: string) => void;
  } = {},
): Promise<TestDb> {
  const { onQuery } = options;
  if (onQuery) {
    const client = new PGlite({ loadDataDir: await template() });
    const db = drizzle(client, { schema, logger: { logQuery: (sql) => onQuery(sql) } });
    return { db, close: () => client.close() };
  }

  if (shared) {
    const { client, db, truncate } = await shared;
    await client.exec(truncate);
    return { db, close: async () => undefined };
  }
  shared = openShared();
  const { db } = await shared;
  return { db, close: async () => undefined };
}

interface Shared {
  client: PGlite;
  db: Database;
  /** The statement that puts the instance back to empty. */
  truncate: string;
}

let shared: Promise<Shared> | undefined;

async function openShared(): Promise<Shared> {
  const client = new PGlite({ loadDataDir: await template() });
  const db = drizzle(client, { schema });
  // Every table the migrations made, read once from the catalog, so a table
  // added later needs no edit here. drizzle's own bookkeeping lives in the
  // `drizzle` schema and is left alone.
  const { rows } = await client.query<{ tables: string }>(
    `select string_agg(format('%I', tablename), ', ' order by tablename) as tables
       from pg_tables where schemaname = 'public'`,
  );
  return { client, db, truncate: `truncate ${rows[0]!.tables} restart identity cascade` };
}

/** Free the instance this process's tests shared. Each package's vitest setup
 *  file calls it in `afterAll`. */
export async function closeSharedTestDb(): Promise<void> {
  const open = shared;
  shared = undefined;
  if (open) await (await open).client.close();
}

const here = dirname(fileURLToPath(import.meta.url));
// src/testing.ts -> ../migrations (dev, via vitest)
// dist/testing.js -> ../migrations (built)
const MIGRATIONS = resolve(here, "..", "migrations");
const TEMPLATE_CACHE = resolve(here, "..", "node_modules", ".cache", "pglite-template");

let templateBlob: Promise<Blob> | undefined;

/**
 * The data dir every instance starts from: a fresh pglite with every migration
 * applied, dumped with `dumpDataDir`. Built once and kept on disk under
 * `node_modules/.cache`, keyed by the migrations folder and the installed
 * pglite, so a process pays `initdb` at most once — on a cold cache — and the
 * next run not at all. A key that no longer matches (a new migration, a pglite
 * upgrade) is a miss, so a stale snapshot is never loaded; the files it leaves
 * behind are removed when the new one is written.
 */
function template(): Promise<Blob> {
  return (templateBlob ??= loadOrBuildTemplate());
}

async function loadOrBuildTemplate(): Promise<Blob> {
  const key = await templateKey();
  const path = join(TEMPLATE_CACHE, `${key}.tar`);
  try {
    // The type is what `dumpDataDir` stamps on its own output; pglite reads it
    // to tell a plain tar from a gzipped one.
    return new Blob([await readFile(path)], { type: "application/x-tar" });
  } catch {
    // A miss. Build it below.
  }

  const client = new PGlite();
  let dump: Blob;
  try {
    await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
    dump = await client.dumpDataDir("none");
  } finally {
    await client.close();
  }

  // Written under a private name and renamed into place, so a parallel worker
  // that misses at the same moment never reads a half-written file. Both write
  // the same bytes; the last rename wins.
  await mkdir(TEMPLATE_CACHE, { recursive: true });
  const partial = join(TEMPLATE_CACHE, `${key}.${process.pid}.${Date.now()}.partial`);
  await writeFile(partial, Buffer.from(await dump.arrayBuffer()));
  await rename(partial, path);
  for (const name of await readdir(TEMPLATE_CACHE)) {
    if (name.endsWith(".tar") && name !== `${key}.tar`) {
      await unlink(join(TEMPLATE_CACHE, name)).catch(() => undefined);
    }
  }
  return dump;
}

/** What the snapshot depends on: every file under `migrations/` — the SQL and
 *  the journal — and the installed pglite, whose resolved path carries its
 *  version under pnpm. */
async function templateKey(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  const entries = await readdir(MIGRATIONS, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    hash.update(relative(MIGRATIONS, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex").slice(0, 16);
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
