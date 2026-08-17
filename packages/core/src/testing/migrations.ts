import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineMigrationSet, type MigrationSet } from "../migrations/set.ts";

/**
 * A set truncated at some migration, and the temporary directory holding it. `await using`
 * removes the directory; the set itself is an ordinary {@link MigrationSet} until then.
 */
export type PartialMigrationSet = MigrationSet & AsyncDisposable;

/** What Drizzle reads first, and the only file in `meta/` its migrator opens. */
const JOURNAL = join("meta", "_journal.json");

type Journal = {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly { readonly tag: string }[];
};

/**
 * The same migration set, as it stood when `tag` was its most recent migration.
 *
 * This is how a test puts a database into the state a **real deployment** is in on the day
 * a new migration reaches it: some rows already written, under the older schema. Every
 * other seam in this repository starts from an empty database, so a migration that cannot
 * survive existing rows — `ALTER TABLE … ADD COLUMN … NOT NULL` with no default is the
 * classic one — passes every test and fails the first Project that installs it. Under
 * ADR-0030 the set runs against a live database at boot, and a failed migration refuses to
 * start the application, so that Project does not get a broken column: it gets no service.
 *
 * ```ts
 * await using kobai = await createTestKobai({ migrate: false });
 * await using before = await migrationSetUpTo(mySet, "0000_creates_the_table");
 *
 * await runMigrations(kobai.db, [before]);
 * await kobai.database.query("insert into my_table (…) values (…)");
 *
 * const outcome = await runMigrations(kobai.db, [mySet]); // the rest, onto rows
 * ```
 *
 * The name is carried over unchanged, which is the point: {@link defineMigrationSet}
 * derives the tracking table from it, so the truncated set and the full one track in the
 * *same* table and the second run picks up exactly where the first stopped — as a
 * Developer's `pnpm migrate` does after an upgrade, rather than starting over.
 *
 * The `.sql` is copied rather than re-authored, so what is applied here is byte-for-byte
 * what ships. Only the journal is rewritten, and only by dropping entries from the end.
 */
export async function migrationSetUpTo(
  set: MigrationSet,
  tag: string,
): Promise<PartialMigrationSet> {
  const journal = JSON.parse(
    await readFile(join(set.migrationsFolder, JOURNAL), "utf8"),
  ) as Journal;

  const stop = journal.entries.findIndex((entry) => entry.tag === tag);
  if (stop === -1) {
    throw new Error(
      `Migration set ${JSON.stringify(set.name)} has no migration tagged ${JSON.stringify(tag)}. Its journal names: ${journal.entries.map((entry) => entry.tag).join(", ") || "nothing"}.`,
    );
  }

  const kept = journal.entries.slice(0, stop + 1);
  const folder = await mkdtemp(join(tmpdir(), `kobai-migrations-${set.name}-`));

  try {
    await mkdir(join(folder, "meta"), { recursive: true });
    await writeFile(
      join(folder, JOURNAL),
      JSON.stringify({ ...journal, entries: kept }, null, 2),
    );
    for (const entry of kept) {
      const sql = `${entry.tag}.sql`;
      await writeFile(
        join(folder, sql),
        await readFile(join(set.migrationsFolder, sql), "utf8"),
      );
    }
  } catch (cause) {
    await rm(folder, { recursive: true, force: true });
    throw cause;
  }

  return {
    ...defineMigrationSet({ name: set.name, migrationsFolder: folder }),
    async [Symbol.asyncDispose]() {
      await rm(folder, { recursive: true, force: true });
    },
  };
}
