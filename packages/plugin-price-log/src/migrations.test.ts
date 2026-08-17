import { runMigrations } from "@kobai/core/migrations";
import { createTestKobai, migrationSetUpTo } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { priceLogMigrationSet } from "./migration-set.ts";

/**
 * This Plugin's set, applied to a database that is **not empty** — which is the only state
 * a migration ever meets in a real deployment, and the one no other test in this repository
 * arranges.
 *
 * `createTestKobai` hands out a database created seconds ago, so every table it migrates is
 * empty and `ALTER TABLE … ADD COLUMN … NOT NULL` with no default passes. It is a green
 * test for a statement Postgres refuses the moment a single row exists (#58): the column has
 * to hold a value for every row already there and the statement offers none. Under ADR-0030
 * the set runs against a live database at boot and, per #2, a failed migration refuses to
 * start the application — so the Project that installs this Plugin does not get a broken
 * column, it gets no service at all.
 *
 * The seam is the migration seam AGENTS.md names: `runMigrations` driven directly, with the
 * set handed over in pieces. Nothing here reaches past it.
 */

/** The migration that creates `price_log_entry`, before it carried an amount. */
const BEFORE_THE_WIDENING = "0000_next_daredevil";

/** A Core Variant by ID, which is all this Plugin ever stores of one (ADR-0004). */
const SOME_VARIANT = "9f8a1c0e-3b6d-4a2f-9c11-5d7e2b8a4f36";

type Entry = {
  variant_id: string;
  amount: number;
  currency: string;
  resolved_at: Date;
};

describe("widening a table that already holds rows", () => {
  it("applies onto a price_log_entry written before amount and currency existed", async () => {
    await using kobai = await createTestKobai({ migrate: false });
    await using asShipped = await migrationSetUpTo(
      priceLogMigrationSet,
      BEFORE_THE_WIDENING,
    );

    // The deployment this Plugin's second migration actually arrives at: the table exists,
    // and it has been in service.
    const beforeUpgrade = await runMigrations(kobai.db, [asShipped]);
    expect(beforeUpgrade.ok).toBe(true);
    await kobai.database.query("insert into price_log_entry (variant_id) values ($1)", [
      SOME_VARIANT,
    ]);
    // Said out loud, because a widening applies cleanly to a table that stayed empty and
    // this test would then be asserting nothing at all.
    await expect(
      kobai.database.query("select count(*)::int as rows from price_log_entry"),
    ).resolves.toEqual([{ rows: 1 }]);

    const upgrade = await runMigrations(kobai.db, [priceLogMigrationSet]);

    expect(upgrade).toMatchObject({ ok: true });
  });

  it("keeps the row it found, and says of it only what is true", async () => {
    await using kobai = await createTestKobai({ migrate: false });
    await using asShipped = await migrationSetUpTo(
      priceLogMigrationSet,
      BEFORE_THE_WIDENING,
    );

    await runMigrations(kobai.db, [asShipped]);
    await kobai.database.query("insert into price_log_entry (variant_id) values ($1)", [
      SOME_VARIANT,
    ]);
    const [before] = await kobai.database.query<Entry>(
      "select variant_id, resolved_at from price_log_entry",
    );

    await runMigrations(kobai.db, [priceLogMigrationSet]);

    // Surviving the widening is half of it. The other half is what the new columns now
    // claim about a resolution recorded before anything recorded amounts: `XXX` is ISO
    // 4217's code for "no currency involved", and 0 is the only amount consistent with it.
    // Any real currency here would be a price this Plugin never saw, indistinguishable
    // from one it did.
    await expect(
      kobai.database.query<Entry>(
        "select variant_id, amount, currency, resolved_at from price_log_entry",
      ),
    ).resolves.toEqual([
      {
        variant_id: SOME_VARIANT,
        amount: 0,
        currency: "XXX",
        resolved_at: before?.resolved_at,
      },
    ]);
  });

  it("still refuses a new row that names no amount", async () => {
    // The backfill is for the rows that were already there. It must not become a licence
    // for the next one: a Step that forgets to pass an amount has to fail loudly rather
    // than log `0 XXX` and look like a free item. That is why the migration leaves no
    // column default behind, and why `schema.ts` declares neither.
    await using kobai = await createTestKobai({
      migrationSets: [priceLogMigrationSet],
    });

    await expect(
      kobai.database.query("insert into price_log_entry (variant_id) values ($1)", [
        SOME_VARIANT,
      ]),
    ).rejects.toThrow(/null value in column "amount"/);
  });
});
