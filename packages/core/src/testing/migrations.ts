import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteIdentifier } from "../db/identifier.ts";
import { defineMigrationSet, type MigrationSet } from "../migrations/set.ts";
import type { SchemaQuery } from "./schema.ts";

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
  readonly entries: readonly JournalEntry[];
};

type JournalEntry = {
  /** The migration's file name without `.sql`, e.g. `0009_updated_at_triggers`. */
  readonly tag: string;
};

async function journalOf(set: MigrationSet): Promise<Journal> {
  return JSON.parse(
    await readFile(join(set.migrationsFolder, JOURNAL), "utf8"),
  ) as Journal;
}

/**
 * The migrations a set declares, by tag, in the order its journal names them.
 *
 * The answer to "how many migrations does this package have", read off the file the
 * migrator itself reads rather than pinned in a test — which is what stops a new migration
 * turning four unrelated assertions red (#34, ADR-0049). Tags rather than a count, because
 * a count that disagrees says only that it disagrees.
 *
 * On its own this is a statement about a *file*, so it proves nothing about a database.
 * Pair it with {@link appliedMigrations}, which is where the strength went:
 *
 * ```ts
 * await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
 *   await declaredMigrations(coreMigrationSet),
 * );
 * ```
 */
export async function declaredMigrations(set: MigrationSet): Promise<string[]> {
  return (await journalOf(set)).entries.map((entry) => entry.tag);
}

/**
 * The migrations of `set` this database has actually applied, by tag, in journal order.
 *
 * This is what a derived count cannot say. `declaredMigrations(set).length` is a fact about
 * a file, and comparing it against a row count taken from the same run is close to
 * circular: a migration dropped from the journal satisfies both sides. This asks the
 * database, one migration at a time, so the failure names the tag that is missing rather
 * than reporting that two numbers differ (#34, ADR-0049):
 *
 * ```ts
 * await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
 *   await declaredMigrations(coreMigrationSet),
 * );
 * ```
 *
 * A row is matched to a migration by **the hash Drizzle stores**, which is the sha256 of
 * the `.sql` file as it sits on disk — the same digest the migrator itself compares to
 * decide whether a migration has already run. So this asks the migrator's own question, and
 * it is identity rather than coincidence: a `.sql` edited after it shipped no longer matches
 * the row that applied it. The journal's `when`, which Drizzle copies into `created_at`
 * verbatim, would have been the looser alternative — two migrations generated in one
 * millisecond would be indistinguishable under it, and an edited file would pass.
 *
 * If a Drizzle upgrade ever changed that digest, everything here would report unapplied.
 * That is the right alarm rather than a false one: the same change would make every
 * deployed database re-apply every migration it has already run.
 *
 * The one thing a digest cannot separate is two migrations whose `.sql` is byte-identical:
 * they share a hash, so one applied row would report both as applied. Drizzle decides what
 * to apply from the journal's `when` and would run both, so the pair normally arrives as two
 * rows — and a set holding the same statements twice is a finding about the set.
 *
 * A set that has never been applied has no tracking table, and that is `[]` rather than an
 * error — "this Plugin is installed and unwired" is a state worth asserting about.
 */
export async function appliedMigrations(
  database: SchemaQuery,
  set: MigrationSet,
): Promise<string[]> {
  // Identifiers cannot be bound, so they are quoted. They come from the set's own
  // definition rather than from a caller, but quoting is free — and the quoted qualified
  // name is what `to_regclass` takes as its argument, so one string serves both.
  const table = `${quoteIdentifier(set.migrationsSchema)}.${quoteIdentifier(set.migrationsTable)}`;
  const [tracking] = await database.query<{ present: boolean }>(
    "select to_regclass($1) is not null as present",
    [table],
  );
  if (tracking?.present !== true) return [];

  const rows = await database.query<{ hash: string }>(`select hash from ${table}`);
  const applied = new Set(rows.map((row) => row.hash));

  const declared = await Promise.all(
    (await journalOf(set)).entries.map(async (entry) => ({
      tag: entry.tag,
      hash: await sqlDigestOf(set.migrationsFolder, entry.tag),
    })),
  );

  return declared.filter((entry) => applied.has(entry.hash)).map((entry) => entry.tag);
}

/**
 * What Drizzle writes into `hash` for one migration: the sha256 of the whole `.sql` file,
 * before it is split on `--> statement-breakpoint`.
 */
async function sqlDigestOf(folder: string, tag: string): Promise<string> {
  const sql = await readFile(join(folder, `${tag}.sql`), "utf8");
  return createHash("sha256").update(sql).digest("hex");
}

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
  const journal = await journalOf(set);

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
