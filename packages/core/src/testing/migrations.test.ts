import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coreMigrationSet } from "../migrations/core-set.ts";
import { runMigrations } from "../migrations/run.ts";
import { createTestKobai } from "./kobai.ts";
import { appliedMigrations, declaredMigrations, migrationSetUpTo } from "./migrations.ts";
import { inspectSchema } from "./schema.ts";

/**
 * What replaced four hardcoded counts (#34, ADR-0049), asserted as the promised surface it
 * is (ADR-0047): what a set declares, read off its journal, and what a database has
 * actually applied, read back from its tracking table one migration at a time.
 */

/**
 * The two migrations at the front of Core's journal.
 *
 * A literal, and one that never needs touching: a journal is append-only, so its first
 * entries stay put. Naming the *whole* journal here would be the chore #34 is about.
 */
const CORE_BEGINS = ["0000_right_expediter", "0001_seed_store"];

describe("the migrations a set declares", () => {
  it("names them in the order its journal does", async () => {
    const declared = await declaredMigrations(coreMigrationSet);

    expect(declared.slice(0, CORE_BEGINS.length)).toEqual(CORE_BEGINS);
  });

  it("reports a truncated set as exactly what is left of it", async () => {
    // The count every test that used to hardcode one now derives, shown deriving.
    await using asShipped = await migrationSetUpTo(coreMigrationSet, "0001_seed_store");

    await expect(declaredMigrations(asShipped)).resolves.toEqual(CORE_BEGINS);
  });
});

describe("the migrations a database has applied", () => {
  it("names every one the set declares, once a boot has migrated", async () => {
    await using kobai = await createTestKobai();

    await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
      await declaredMigrations(coreMigrationSet),
    );
  });

  it("stops naming a migration whose .sql no longer matches the row that applied it", async () => {
    // The claim the digest buys, asserted rather than left to the docblock. A `.sql` edited
    // after it shipped is a different migration from the one this database ran, and the
    // tracking row still holds the digest of what actually ran — so the match breaks and
    // the tag drops out. Edited in the temporary copy `migrationSetUpTo` hands back, never
    // in `packages/core/migrations`, which is generated and never hand-edited.
    await using kobai = await createTestKobai({ migrate: false });
    await using asShipped = await migrationSetUpTo(coreMigrationSet, "0001_seed_store");
    await runMigrations(kobai.db, [asShipped]);
    await expect(appliedMigrations(kobai.database, asShipped)).resolves.toEqual(
      CORE_BEGINS,
    );

    const edited = join(asShipped.migrationsFolder, "0001_seed_store.sql");
    await writeFile(edited, `${await readFile(edited, "utf8")}\n-- and one more thing\n`);

    await expect(appliedMigrations(kobai.database, asShipped)).resolves.toEqual([
      "0000_right_expediter",
    ]);
  });

  it("is empty for a set this database has never seen, rather than an error", async () => {
    // An installed Plugin a Project has not wired has no tracking table at all, and
    // "nothing of this set has run here" is a state worth asserting rather than throwing on.
    await using kobai = await createTestKobai({ migrate: false });

    await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
      [],
    );
  });
});

/**
 * The pairing above is only worth having if it can fail, and a database that migrated
 * cleanly cannot demonstrate that. So one is put into the state #34 is about — a set the
 * journal declares and the database has not fully applied — and the assertion every other
 * test now makes is watched refusing it.
 *
 * This is what a derived count cannot do on its own, and the reason the strength moved off
 * the number and onto the effect.
 */
describe("a migration this database never ran", () => {
  it("is left out, so the assertion the other tests make fails naming it", async () => {
    await using kobai = await createTestKobai({ migrate: false });
    // Core as it stood two migrations in — an old deployment, or a set whose later
    // migrations threw. Truncated at the front of the journal so this literal never moves.
    await using asShipped = await migrationSetUpTo(coreMigrationSet, "0001_seed_store");

    expect((await runMigrations(kobai.db, [asShipped])).ok).toBe(true);

    const applied = await appliedMigrations(kobai.database, coreMigrationSet);
    const declared = await declaredMigrations(coreMigrationSet);

    // Said outright: the two that ran, and not one of the rest.
    expect(applied).toEqual(CORE_BEGINS);
    expect(declared.length).toBeGreaterThan(CORE_BEGINS.length);
    expect(applied).not.toEqual(declared);
  });

  it("is left out even when the tracking table's row count looks right", async () => {
    // The failure a count cannot see, and the reason a count alone would not have been
    // enough: the first two of Core's migrations applied, and a junk row written for each
    // of the rest, bringing the tally back to what the journal declares.
    // `migrationTracking()` now reports exactly the expected number, and every migration
    // after those first two has still never run.
    await using kobai = await createTestKobai({ migrate: false });
    await using asShipped = await migrationSetUpTo(coreMigrationSet, "0001_seed_store");
    await runMigrations(kobai.db, [asShipped]);

    const declared = await declaredMigrations(coreMigrationSet);
    for (let row = CORE_BEGINS.length; row < declared.length; row++) {
      await kobai.database.query(
        `insert into ${coreMigrationSet.migrationsSchema}.${coreMigrationSet.migrationsTable}
           (hash, created_at) values ($1, $2)`,
        [`not-a-migration-${row}`, `${row}`],
      );
    }

    await expect(inspectSchema(kobai.database).migrationTracking()).resolves.toEqual([
      {
        schema: coreMigrationSet.migrationsSchema,
        table: coreMigrationSet.migrationsTable,
        applied: declared.length,
      },
    ]);
    await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
      CORE_BEGINS,
    );
  });
});
