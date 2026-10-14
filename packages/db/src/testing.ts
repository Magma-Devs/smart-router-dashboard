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
 * Each call gets its own isolated in-memory database with every migration
 * applied. Test-only — never imported by `src/index.ts`, so nothing ships it.
 *
 * **Per-test isolation is deliberate, and it is the expensive choice.** The
 * suite stands up one instance per test, with `apps/api` doing the same in
 * parallel, so the cost grows with the test count. What an instance costs is
 * `initdb` — about 1.4s, with the migrations adding nothing measurable — which
 * is why every instance boots from a snapshot of an already-migrated data dir
 * instead (about 0.3s; see `template()`). If tests start failing under load,
 * raise vitest's `testTimeout` first. Sharing an instance across tests would be
 * the next saving and the wrong one: it trades a rare timeout for cross-test
 * state leaking through a shared database, which is a subtler bug than the one
 * it fixes and much harder to attribute.
 */
export interface TestDb {
  db: Database;
  /** Free the WASM instance. Call in `afterEach`/`afterAll`. */
  close: () => Promise<void>;
}

export async function createTestDb(
  options: {
    /** Sees every statement drizzle sends. For asserting SQL a
     *  single-connection database can't exercise — a row lock needs a second
     *  connection to contend with, and pglite has one. */
    onQuery?: (sql: string) => void;
  } = {},
): Promise<TestDb> {
  const client = new PGlite({ loadDataDir: await template() });
  const { onQuery } = options;
  const db = drizzle(client, {
    schema,
    logger: onQuery ? { logQuery: (sql) => onQuery(sql) } : undefined,
  });

  return { db, close: () => client.close() };
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
