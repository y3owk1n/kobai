import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * No migration in this repository asks a table that already exists for something the rows
 * already in it might not be able to give.
 *
 * Two statements can, and both arrive from an ordinary schema declaration rather than from
 * anyone's carelessness. Postgres refuses `ALTER TABLE … ADD COLUMN … NOT NULL` against a
 * table holding even one row: the column has to have a value for every row already there,
 * and the statement offers none. It refuses `CREATE UNIQUE INDEX` against a table already
 * holding two rows that agree on the indexed columns, for the same reason one door along —
 * the constraint is a claim about rows nobody has checked (#119).
 *
 * Every test database in this repository is created seconds before it is migrated, so both
 * are green everywhere here and red at the first Project with traffic — and under ADR-0030
 * the set runs against a live database at boot, where a failed migration refuses to start
 * the application (#2). The failure lands on a Developer who wrote none of it.
 *
 * `drizzle-kit generate` emits each of them from an ordinary declaration — a `.notNull()` on
 * a new field, a `uniqueIndex()` on an existing table — so they are hazards of the tool, and
 * they will arrive again. ADR-0038 has the shape that replaces the first: add the column
 * nullable, backfill in a `--custom` migration, then constrain — three migrations, two of
 * them generated. `packages/plugin-price-log` is the worked example and
 * `packages/plugin-price-log/src/migrations.test.ts` proves it against a seeded table. The
 * second takes the same shape: deduplicate in a `--custom` migration, then let the generated
 * one add the index.
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
 * `CREATE UNIQUE INDEX … ON <table>`, and the table it names — up to the end of that one
 * statement, for the same reason the one above stops at a `;`.
 *
 * Postgres refuses a unique index against a table already holding two rows that agree on the
 * indexed columns, so this is `ADD COLUMN … NOT NULL`'s failure arriving through a different
 * statement, and `drizzle-kit generate` writes it from an ordinary `uniqueIndex()` on an
 * existing table exactly as unprompted (#119). What replaces it is the shape ADR-0038 gives
 * a column, one door along — that ADR is about columns and says nothing about indexes:
 * deduplicate in a `--custom` migration first, then let the generated one add the index.
 *
 * A plain `CREATE INDEX` is deliberately not read. No row can refuse one — its cost against a
 * populated table is a lock rather than a failure, and the remedy for that is `CONCURRENTLY`,
 * which cannot run inside the transaction the migrator wraps a migration in. Flagging it
 * would name a fault with no shape available to answer it, which is the mistake the blindness
 * above avoids.
 *
 * Two spellings of the same hazard are still unread, and #119 stopped short of both on
 * purpose: `ALTER TABLE … ADD CONSTRAINT … UNIQUE`, and `… ADD CONSTRAINT … CHECK`, which
 * fails against rows that do not satisfy it. The excuse below cannot cover a `CHECK` — the
 * shape that makes one safe is the statement *before* it in the same migration, as
 * `packages/core/migrations/0027` shows, so reading it is a question about what came earlier
 * rather than about what this migration created.
 */
const ADDS_A_UNIQUE_INDEX =
  /\bcreate\s+unique\s+index\b[^;]*?\bon\s+(?:only\s+)?([^\s(;]+)[^;]*/gis;

/**
 * `CREATE TABLE <table>`, and the table it names.
 *
 * `IF NOT EXISTS` is deliberately not matched, so a table created that way excuses nothing.
 * The excuse below is *no row exists that this migration has not seen*, and that spelling is
 * the one statement which says the opposite may be true — it is a no-op against a table that
 * was already there, holding whatever it holds.
 */
const CREATES_A_TABLE = /\bcreate\s+table\s+(?!if\s+not\s+exists\b)([^\s(;]+)/gis;

/**
 * A table reference reduced to the name two statements have to share to be about the same
 * table: unquoted, lower-cased, and without the schema qualifier one of them may carry and
 * the other may not.
 *
 * It is a token rather than a parse, so an identifier quoted around a space would be read
 * short. Nothing drizzle-kit emits is one, and the failure direction is the safe one: a name
 * read short matches no `CREATE TABLE` in the file, so the statement is flagged rather than
 * excused. A group the compiler thinks optional goes the same way — it becomes a name no
 * `CREATE TABLE` can produce, and the reader below keeps it out of the set of created tables
 * so it can excuse nothing.
 */
function tableName(reference: string | undefined): string {
  const unquoted = (reference ?? "").replaceAll('"', "").toLowerCase();
  return unquoted.slice(unquoted.lastIndexOf(".") + 1);
}

/**
 * One finding: the file it was read out of, and the statement on a single line, so a failure
 * reads as a list of places rather than as a diff of two blobs of SQL. Every reader below
 * labels through this one, so the next hazard reads the same way without copying it.
 */
function labelled(migration: Migration, statement: string): string {
  return `${migration.path}: ${statement.replaceAll(/\s+/g, " ").trim()}`;
}

/** The required columns one migration adds to a table with nothing to give them. */
function addsRequiredColumnsWithNoDefault(migration: Migration): string[] {
  return [...withoutComments(migration.sql).matchAll(ADDS_A_REQUIRED_COLUMN)]
    .map(([statement]) => statement)
    .filter((statement) => !/\bdefault\b/i.test(statement))
    .map((statement) => labelled(migration, statement));
}

/**
 * The unique indexes in one migration that meet a table the same migration did not create.
 *
 * A table created here can hold no row the index has not seen, which is the same excuse
 * Core's `ADD CONSTRAINT … FOREIGN KEY` statements rest on — and it is the only excuse a
 * reading of one file can make. Whether the deduplication that makes such an index
 * survivable happened in an earlier migration is not a property of this text, so an index
 * arriving at a table this migration inherited is named, and answered where a reason can be
 * written down beside it.
 */
function addsUniqueIndexesToTablesItDidNotCreate(migration: Migration): string[] {
  const sql = withoutComments(migration.sql);
  const created = new Set(
    [...sql.matchAll(CREATES_A_TABLE)].flatMap(([, table]) =>
      table === undefined ? [] : [tableName(table)],
    ),
  );

  return [...sql.matchAll(ADDS_A_UNIQUE_INDEX)]
    .filter(([, table]) => !created.has(tableName(table)))
    .map(([statement]) => labelled(migration, statement));
}

/** Everything in one migration that a table with rows already in it could refuse. */
function unsafeStatements(migration: Migration): string[] {
  return [
    ...addsRequiredColumnsWithNoDefault(migration),
    ...addsUniqueIndexesToTablesItDidNotCreate(migration),
  ];
}

/**
 * The statements the check names that this repository nevertheless ships, each with the
 * reason it was allowed to — and there is exactly one.
 *
 * It is not an ignore list. The assertion below is an equality, so an entry that stops being
 * produced fails just as loudly as one that appears: the acknowledgement cannot outlive the
 * statement it excuses, and it cannot be widened without being edited. Answering a finding
 * here is a decision written down, which is what the check exists to force.
 *
 * `0016` is the hazard #119 was filed about, in the repository rather than in a fixture.
 * `core_order` is created by `0012`, and until `0016` shipped with #118 a Cart could become
 * two Orders — so a deployment sitting on `0015` can be holding exactly the duplicate
 * `cart_id` values the index refuses, and would get no service at its next boot (ADR-0030).
 * It is survivable only because nothing has been released and no such deployment exists,
 * which is an argument about today: **before the first release this needs either the
 * deduplication ADR-0038 would put in front of it or a decision that it does not.** Deleting
 * this entry then is the point of it being here.
 */
const ACKNOWLEDGED = [
  `${join("packages", "core", "migrations", "0016_fresh_gwen_stacy.sql")}: CREATE UNIQUE INDEX "core_order_cart_idx" ON "core_order" USING btree ("cart_id")`,
];

describe("a migration can be applied to a database that is already in use", () => {
  it("asks nothing of rows already there but what is acknowledged, in any set", async () => {
    const folders = await migrationFolders(repoRoot);
    const migrations = (await Promise.all(folders.map(migrationsOf))).flat();

    // Failing open would be worse than failing: nothing found makes this pass by reading
    // nothing, which is indistinguishable from reading everything.
    expect(folders.length).toBeGreaterThan(0);
    expect(migrations.length).toBeGreaterThan(0);

    expect(migrations.flatMap(unsafeStatements)).toEqual(ACKNOWLEDGED);
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
 * #58 replaced it, and with the unique index that is still here, in `0016`.
 */
describe("reading a migration for the fault", () => {
  const reading = (sql: string) => unsafeStatements({ path: "example.sql", sql });

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

  it("catches a unique index arriving at a table it did not create", () => {
    expect(
      reading(
        `CREATE UNIQUE INDEX "core_order_cart_idx" ON "core_order" USING btree ("cart_id");`,
      ),
    ).toEqual([
      'example.sql: CREATE UNIQUE INDEX "core_order_cart_idx" ON "core_order" USING btree ("cart_id")',
    ]);
  });

  it("passes a unique index on a table the same migration creates", () => {
    expect(
      reading(
        `CREATE TABLE "core_payment" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"order_id" uuid NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX "core_payment_order_idx" ON "core_payment" USING btree ("order_id");`,
      ),
    ).toEqual([]);
  });

  it("takes CREATE TABLE IF NOT EXISTS as no promise about rows", () => {
    // The excuse is that no row exists this migration has not seen, and that is the one
    // spelling of the statement which may have created nothing at all.
    expect(
      reading(
        `CREATE TABLE IF NOT EXISTS "core_payment" (\n\t"order_id" uuid NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX "core_payment_order_idx" ON "core_payment" USING btree ("order_id");`,
      ),
    ).toEqual([
      'example.sql: CREATE UNIQUE INDEX "core_payment_order_idx" ON "core_payment" USING btree ("order_id")',
    ]);
  });

  it("is not fooled by the schema qualifier only one of the two carries", () => {
    // `CREATE TABLE` names the table bare and `CREATE INDEX` may qualify it, so the two have
    // to be compared by the name rather than by the reference.
    expect(
      reading(
        `CREATE TABLE "core_payment" (\n\t"order_id" uuid NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX "core_payment_order_idx" ON "public"."core_payment" USING btree ("order_id");`,
      ),
    ).toEqual([]);
  });

  it("passes a plain index, which no row it meets can refuse", () => {
    expect(
      reading(
        `CREATE INDEX "core_order_cart_idx" ON "core_order" USING btree ("cart_id");`,
      ),
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
