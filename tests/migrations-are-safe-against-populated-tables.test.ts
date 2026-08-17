import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No migration in this repository adds a `NOT NULL` column with no default to a table that
 * already exists.
 *
 * Postgres refuses `ALTER TABLE … ADD COLUMN … NOT NULL` against a table holding even one
 * row: the column has to have a value for every row already there, and the statement offers
 * none. Every test database in this repository is created seconds before it is migrated, so
 * that statement is green everywhere here and red at the first Project with traffic — and
 * under ADR-0030 the set runs against a live database at boot, where a failed migration
 * refuses to start the application (#2). The failure lands on a Developer who wrote none of
 * it.
 *
 * `drizzle-kit generate` emits exactly this statement from an ordinary `.notNull()` on a new
 * field of an existing table, so it is a hazard of the tool rather than of anyone's
 * carelessness, and it will arrive again. ADR-0038 has the shape that replaces it: add the
 * column nullable, backfill in a `--custom` migration, then constrain — three migrations,
 * two of them generated. `packages/plugin-price-log` is the worked example and
 * `packages/plugin-price-log/src/migrations.test.ts` proves it against a seeded table.
 *
 * This is a reading of the SQL rather than a run of it, because the fault is a property of
 * the text: what the statement offers for the rows it may find. Running it would need every
 * table in the repository seeded through whatever writes it, which is a suite nobody would
 * keep. The behavioural half lives in the Plugin's own package, where one table is seeded
 * for real.
 */
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/** Never walked: not ours, or an artifact of building what is. */
const NOT_SOURCE = new Set(["node_modules", ".git", "dist", ".devbox", "coverage"]);

/** One migration file, labelled well enough for a failure to name it without a diff. */
type Migration = {
  /** Repository-relative, e.g. `packages/core/migrations/0009_updated_at_triggers.sql`. */
  readonly path: string;
  readonly sql: string;
};

/**
 * Every migration directory in the repository, found by walking rather than by listing.
 *
 * A list of the three that exist today would stop covering the next Plugin on the day it
 * lands, silently — which is the class of failure this file exists to prevent. The signal is
 * a `migrations/meta/_journal.json`, because that is the file Drizzle reads first and the
 * only thing that makes a directory of `.sql` a migration set.
 */
async function migrationFolders(directory: string): Promise<string[]> {
  const found: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || NOT_SOURCE.has(entry.name)) continue;

    const path = join(directory, entry.name);
    if (entry.name === "migrations" && (await isMigrationSet(path))) {
      found.push(path);
      continue;
    }
    found.push(...(await migrationFolders(path)));
  }

  return found;
}

async function isMigrationSet(path: string): Promise<boolean> {
  return (
    (await readFile(join(path, "meta", "_journal.json"), "utf8").catch(() => null)) !==
    null
  );
}

/**
 * Every `.sql` a migration set will actually apply — taken from the journal, because that is
 * what the runner reads. A file the journal does not name is never applied and is not this
 * test's business; a file it names and the directory lacks is `packaged-migrations.test.ts`'s.
 */
async function migrationsOf(folder: string): Promise<Migration[]> {
  const { entries } = JSON.parse(
    await readFile(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries?: { tag?: string }[] };

  const read = (entries ?? []).flatMap(({ tag }) =>
    tag === undefined ? [] : [join(folder, `${tag}.sql`)],
  );

  return Promise.all(
    read.map(async (path) => ({
      path: path.slice(repoRoot.length),
      sql: await readFile(path, "utf8"),
    })),
  );
}

/**
 * `ALTER TABLE … ADD COLUMN … NOT NULL`, up to the end of that one statement.
 *
 * `[^;]` throughout keeps a match inside a single statement, so neither a `NOT NULL` from
 * the next statement nor a `DEFAULT` from the previous one can be read into this one.
 * `ADD CONSTRAINT` is excluded because it is a different statement that happens to share a
 * verb — the foreign keys in `packages/core/migrations` are all of that form, and none of
 * them is this bug.
 *
 * Deliberately blind to `ALTER COLUMN … SET NOT NULL`, which fails on a populated table too
 * — but only when the backfill before it was missing or wrong, and no reading of the text
 * can tell. It is the third step of the safe shape, so flagging it would fail the fix along
 * with the fault. What proves that one is the Plugin's seeded test.
 */
const ADDS_A_REQUIRED_COLUMN =
  /\balter\s+table\b[^;]*?\badd\s+(?!constraint\b)(?:column\s+)?[^;]*?\bnot\s+null\b[^;]*/gis;

/**
 * The SQL with its comments removed, both spellings.
 *
 * Every hand-written migration in this repository explains itself in a comment, and those
 * comments talk about `NOT NULL` — this file's own subject matter — so a check that read them
 * would be permanently red for the wrong reason. Block comments as well as line comments,
 * because nothing stops the next `--custom` migration from using them.
 *
 * It does not tokenise, so a `--` or a `/*` *inside a string literal* would be treated as the
 * start of a comment. That can only ever cause a **false** positive here (text is dropped, so
 * a statement can lose a `DEFAULT` it really had, never gain one), and it needs a literal
 * containing a comment marker inside an `ALTER TABLE … ADD COLUMN` — at which point a
 * one-line ignore is a better answer than a SQL parser living in a test.
 */
function withoutComments(sql: string): string {
  return sql.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/--.*$/gm, "");
}

/**
 * The offending statements in one migration, each already labelled with its file, so a
 * failure reads as a list of places rather than as a diff of two blobs of SQL.
 */
function addsRequiredColumnsWithNoDefault(migration: Migration): string[] {
  return [...withoutComments(migration.sql).matchAll(ADDS_A_REQUIRED_COLUMN)]
    .map(([statement]) => statement.replaceAll(/\s+/g, " ").trim())
    .filter((statement) => !/\bdefault\b/i.test(statement))
    .map((statement) => `${migration.path}: ${statement}`);
}

describe("a migration can be applied to a database that is already in use", () => {
  it("adds no NOT NULL column without a default, in any migration set", async () => {
    const folders = await migrationFolders(repoRoot);
    const migrations = (await Promise.all(folders.map(migrationsOf))).flat();

    // Failing open would be worse than failing: nothing found makes this pass by reading
    // nothing, which is indistinguishable from reading everything.
    expect(folders.length).toBeGreaterThan(0);
    expect(migrations.length).toBeGreaterThan(0);

    expect(migrations.flatMap(addsRequiredColumnsWithNoDefault)).toEqual([]);
  });

  it("finds the migration sets that exist today", async () => {
    // Not the list being checked — that is discovered, and grows by itself. This catches the
    // narrower slip of the walk still finding something and no longer finding these.
    const folders = (await migrationFolders(repoRoot)).map((path) =>
      path.slice(repoRoot.length),
    );

    expect(folders).toContain(join("packages", "core", "migrations"));
    expect(folders).toContain(join("packages", "plugin-price-log", "migrations"));
    expect(folders).toContain(join("reference", "migrations"));
  });
});

/**
 * The check above is only as good as its reading of SQL, and SQL that is fine today cannot
 * demonstrate the failure. These drive the same function against statements written to
 * offend — starting with the one that was actually here, in `0001_spicy_darwin.sql`, until
 * #58 replaced it.
 */
describe("reading a migration for the fault", () => {
  const reading = (sql: string) =>
    addsRequiredColumnsWithNoDefault({ path: "example.sql", sql });

  it("catches the statement #58 was filed about", () => {
    expect(
      reading(
        `ALTER TABLE "price_log_entry" ADD COLUMN "amount" integer NOT NULL;--> statement-breakpoint\nALTER TABLE "price_log_entry" ADD COLUMN "currency" text NOT NULL;`,
      ),
    ).toEqual([
      'example.sql: ALTER TABLE "price_log_entry" ADD COLUMN "amount" integer NOT NULL',
      'example.sql: ALTER TABLE "price_log_entry" ADD COLUMN "currency" text NOT NULL',
    ]);
  });

  it("passes the safe shape: nullable, then constrained after a backfill", () => {
    expect(reading(`ALTER TABLE "price_log_entry" ADD COLUMN "amount" integer;`)).toEqual(
      [],
    );
    expect(
      reading(`ALTER TABLE "price_log_entry" ALTER COLUMN "amount" SET NOT NULL;`),
    ).toEqual([]);
  });

  it("passes a required column that brings a default with it", () => {
    expect(
      reading(`ALTER TABLE "core_store" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;`),
    ).toEqual([]);
  });

  it("passes a CREATE TABLE, whose columns meet no existing rows", () => {
    expect(
      reading(`CREATE TABLE "core_thing" (\n\t"id" uuid PRIMARY KEY NOT NULL\n);`),
    ).toEqual([]);
  });

  it("passes the foreign keys Core adds, which share the verb and not the fault", () => {
    expect(
      reading(
        `ALTER TABLE "core_session" ADD CONSTRAINT "core_session_merchant_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."core_merchant"("id") ON DELETE cascade ON UPDATE no action;`,
      ),
    ).toEqual([]);
  });

  it("is not fooled by a DEFAULT belonging to the statement before it", () => {
    expect(
      reading(
        `ALTER TABLE "t" ADD COLUMN "a" text DEFAULT 'x' NOT NULL;--> statement-breakpoint\nALTER TABLE "t" ADD COLUMN "b" text NOT NULL;`,
      ),
    ).toEqual(['example.sql: ALTER TABLE "t" ADD COLUMN "b" text NOT NULL']);
  });

  it("reads the SQL and not the prose about it, in either spelling of comment", () => {
    expect(
      reading(
        `/* Never ALTER TABLE x ADD COLUMN y text NOT NULL against a populated table. */\nUPDATE "t" SET "a" = 0 WHERE "a" IS NULL;`,
      ),
    ).toEqual([]);
  });

  it("reads the SQL and not the prose about it", () => {
    // Every migration this repository hand-writes carries a comment saying why, and
    // ADR-0038's says these very words. A check that read them would be permanently red.
    expect(
      reading(
        `-- Never ALTER TABLE x ADD COLUMN y text NOT NULL against a populated table.\nUPDATE "t" SET "a" = 0 WHERE "a" IS NULL;`,
      ),
    ).toEqual([]);
  });
});
