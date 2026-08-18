import { coreMigrationSet, runMigrations } from "@kobai/core/migrations";
import {
  appliedMigrations,
  createTestKobai,
  declaredMigrations,
  inspectSchema,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import drizzleConfig from "../drizzle.config.ts";
import { madeToOrderMigrationSet } from "./migration-set.ts";

/**
 * What this Plugin is, checked rather than asserted.
 *
 * None of it is behaviour, so HTTP cannot reach any of it: "this Plugin owns one table", "no
 * foreign key crosses into Core's" and "an unwired Plugin leaves no trace" are properties of
 * the schema, checked by asking Postgres through `inspectSchema` — the same inspector a Plugin
 * author gets from `@kobai/core/testing`.
 *
 * They live in this package on purpose. Core must be able to run without ever having heard of
 * it, so nothing in `@kobai/core` imports anything here.
 */
describe("a Plugin owns its own tables", () => {
  it("creates exactly one table, carrying its own prefix, once a Project wires it", async () => {
    await using kobai = await createTestKobai({
      migrationSets: [madeToOrderMigrationSet],
    });
    const schema = inspectSchema(kobai.database);

    await expect(schema.tablesOwnedBy("made_to_order")).resolves.toEqual([
      "made_to_order_surcharge",
    ]);
  });

  it("tracks its migrations in its own table, in the explicitly named schema", async () => {
    await using kobai = await createTestKobai({
      migrationSets: [madeToOrderMigrationSet],
    });
    const schema = inspectSchema(kobai.database);

    const tracking = await schema.migrationTracking();

    // Two packages, two tracking tables, one database — so Core and this Plugin never race and
    // neither is in a position to re-apply the other's migrations (ADR-0030).
    expect(tracking.map((entry) => `${entry.schema}.${entry.table}`)).toEqual([
      "drizzle.__drizzle_migrations_core",
      "drizzle.__drizzle_migrations_plugin_made_to_order",
    ]);
    // How many migrations either set has is nobody's business to write down (ADR-0049): the
    // count comes off this set's own journal, and what makes the assertion worth anything is
    // that each migration is named as having actually run.
    const declared = await declaredMigrations(madeToOrderMigrationSet);
    expect(declared.length).toBeGreaterThan(0);
    await expect(
      appliedMigrations(kobai.database, madeToOrderMigrationSet),
    ).resolves.toEqual(declared);
  });

  it("scopes its migration config to its own table prefix", () => {
    // ADR-0030's defence in depth. The primary control is that no `push` script exists;
    // this is what limits the blast radius of one somebody adds anyway.
    expect(drizzleConfig.tablesFilter).toEqual(["made_to_order_*"]);
    expect(drizzleConfig.migrations).toEqual({
      table: "__drizzle_migrations_plugin_made_to_order",
      schema: "drizzle",
    });
  });

  it("has no foreign key pointing into a Core table", async () => {
    await using kobai = await createTestKobai({
      migrationSets: [madeToOrderMigrationSet],
    });

    // ADR-0004. This Plugin's `cart_id` and `variant_id` are Core's rows by ID and nothing
    // more. A constraint on either would freeze Core's tables from outside — and would make
    // install order matter again.
    await expect(
      inspectSchema(kobai.database).foreignKeysCrossingInto("core"),
    ).resolves.toEqual([]);
  });

  it("adds no column to any Core table", async () => {
    // The comparison is the assertion: Core's tables must be the same shape whether or not
    // this Plugin is installed. A Plugin may not add a column to one; only a Project, which
    // owns its own repository and its own migrations, may add columns — and only to its own.
    await using withoutPlugin = await createTestKobai();
    await using withPlugin = await createTestKobai({
      migrationSets: [madeToOrderMigrationSet],
    });

    const stock = await inspectSchema(withoutPlugin.database).columnsOwnedBy("core");
    const extended = await inspectSchema(withPlugin.database).columnsOwnedBy("core");

    expect(Object.keys(stock).length).toBeGreaterThan(0);
    expect(extended).toEqual(stock);
  });
});

describe("an installed Plugin does nothing until the Project wires it", () => {
  it("brings no table into being when the Project has not named its migration set", async () => {
    // This package is a dependency of the test that is running: installed, imported, and its
    // migration set in scope on the line above. None of that is installation (ADR-0017).
    expect(madeToOrderMigrationSet.name).toBe("plugin-made-to-order");

    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    await expect(schema.tablesOwnedBy("made_to_order")).resolves.toEqual([]);
    // Not even a tracking table: an unwired Plugin leaves no trace of itself at all.
    expect((await schema.migrationTracking()).map((entry) => entry.table)).toEqual([
      "__drizzle_migrations_core",
    ]);
  });
});

describe("install order is not a hidden constraint", () => {
  it("applies before Core's set as readily as after it", async () => {
    // What the no-foreign-key rule buys beyond ADR-0004's own reasons: with nothing crossing
    // the boundary, Postgres imposes no ordering between the two sets, so a Project may wire
    // its Plugins in whatever order it likes. The property belongs to *this* package's set,
    // which is why it is asked here rather than trusted from the Plugin next door.
    await using backwards = await createTestKobai({ migrate: false });

    const outcome = await runMigrations(backwards.db, [
      madeToOrderMigrationSet,
      coreMigrationSet,
    ]);

    expect(outcome.ok).toBe(true);
    // Said outright, because a database in which nothing ran is also a database in which
    // nothing conflicted.
    await expect(
      inspectSchema(backwards.database).tablesOwnedBy("made_to_order"),
    ).resolves.toEqual(["made_to_order_surcharge"]);
    for (const set of [coreMigrationSet, madeToOrderMigrationSet]) {
      const declared = await declaredMigrations(set);
      expect(declared.length).toBeGreaterThan(0);
      await expect(appliedMigrations(backwards.database, set)).resolves.toEqual(declared);
    }
  });
});
