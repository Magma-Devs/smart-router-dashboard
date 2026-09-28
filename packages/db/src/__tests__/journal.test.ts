import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The migration journal, checked against the folder it describes.
 *
 * Drizzle does not order migrations by filename or by `idx` — `migrate()` reads
 * `_journal.json` in array order and applies an entry only when its `when` is
 * strictly greater than the single highest `created_at` already in
 * `__drizzle_migrations`:
 *
 * ```js
 * if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis)
 * ```
 *
 * Two consequences, both of which have already nearly bitten this repo while
 * two lanes of work each added migrations:
 *
 *  - **A repeated `when` is silently skipped.** If lane A merges `when: X` and
 *    lane B later merges a *different* migration at the same `when: X`, every
 *    database that already ran A's is at `created_at = X`, `X < X` is false,
 *    and B's SQL never runs. No error, no log — the tables simply are not there.
 *  - **The same is true of any `when` that goes backwards**, which is what
 *    renumbering a file without touching its timestamp looks like.
 *
 * So the invariant worth testing is not "the numbers are pretty", it is that
 * `when` strictly increases and the folder and journal agree.
 */
const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");

interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
}

const entries: JournalEntry[] = JSON.parse(
  readFileSync(resolve(migrationsDir, "meta/_journal.json"), "utf8"),
).entries;

describe("the migration journal", () => {
  it("stamps every migration with a strictly increasing `when`", () => {
    // The one that matters: an equal or lower `when` than the entry before it
    // is applied on a fresh database and skipped on every existing one.
    const whens = entries.map((e) => e.when);
    const increasing = whens.every((w, i) => i === 0 || w > whens[i - 1]!);
    expect(increasing, `when values must strictly increase, got ${whens.join(", ")}`).toBe(true);
  });

  it("numbers entries contiguously from zero", () => {
    // A gap means a tag is being held for a migration that lives on another
    // branch — which is exactly the situation that produces a duplicate `when`.
    expect(entries.map((e) => e.idx)).toEqual(entries.map((_, i) => i));
  });

  it("names each entry after the file it applies", () => {
    for (const entry of entries) {
      expect(entry.tag).toMatch(new RegExp(`^${String(entry.idx).padStart(4, "0")}_`));
    }
  });

  it("describes every .sql file in the folder, and no others", () => {
    const onDisk = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    expect(entries.map((e) => e.tag).sort()).toEqual(onDisk);
  });
});
