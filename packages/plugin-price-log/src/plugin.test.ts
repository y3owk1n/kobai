import { coreMigrationSet, runMigrations } from "@kobai/core/migrations";
import { createTestKobai, inspectSchema } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import drizzleConfig from "../drizzle.config.ts";
import { priceLogMigrationSet } from "./migration-set.ts";

/**
 * What a Plugin is, checked rather than asserted.
 *
 * These tests are the second seam kobai has: HTTP cannot reach any of it, because none of
 * it is behaviour. "No foreign key crosses into a Core table" and "this Plugin added no
 * column to one" are properties of the schema, so they are checked by asking Postgres —
 * through `inspectSchema` from `@kobai/core/testing`, which is the same inspector a Plugin
 * author gets.
 *
 * They live in the Plugin's own package on purpose. Core must be able to run without ever
 * having heard of this package, so nothing in `@kobai/core` imports it.
 */
describe("a Plugin owns its own tables", () => {
  it("creates exactly one table, carrying its own prefix, once a Project wires it", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });
    const schema = inspectSchema(kobai.database);

    await expect(schema.tablesOwnedBy("price_log")).resolves.toEqual(["price_log_entry"]);
  });

  it("tracks its migrations in its own table, in the explicitly named schema", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });
    const schema = inspectSchema(kobai.database);

    const tracking = await schema.migrationTracking();

    // Two packages, two tracking tables, one database. Core and this Plugin never race,
    // and neither is in a position to re-apply the other's migrations.
    expect(tracking.map((entry) => `${entry.schema}.${entry.table}`)).toEqual([
      "drizzle.__drizzle_migrations_core",
      "drizzle.__drizzle_migrations_plugin_price_log",
    ]);
    // Only this Plugin's count is asserted. How many migrations Core has is Core's business
    // and no reason for a Plugin's suite to go red.
    expect(tracking.find((entry) => entry.table.endsWith("price_log"))?.applied).toBe(1);
  });

  it("scopes its migration config to its own table prefix", () => {
    // ADR-0030's defence in depth. The primary control is that no `push` script exists;
    // this is what limits the blast radius of one that someone adds anyway.
    expect(drizzleConfig.tablesFilter).toEqual(["price_log_*"]);
    expect(drizzleConfig.migrations).toEqual({
      table: "__drizzle_migrations_plugin_price_log",
      schema: "drizzle",
    });
  });
});

describe("Core's tables are closed to a Plugin", () => {
  it("has no foreign key pointing into a Core table", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });
    const schema = inspectSchema(kobai.database);

    // ADR-0004. The Plugin's `variant_id` is Core's row by ID and nothing more. A
    // constraint here would freeze Core's tables from outside — and, incidentally, would
    // make install order matter again.
    await expect(schema.foreignKeysCrossingInto("core")).resolves.toEqual([]);
  });

  it("adds no column to any Core table", async () => {
    // The comparison is the assertion: Core's tables must be byte-for-byte the same shape
    // whether or not this Plugin is installed. A Plugin may not add a column to one; only a
    // Project, which owns its own repository and its own migrations, may add columns — and
    // only to its own tables. That asymmetry is what keeps Core free to alter its schema.
    await using withoutPlugin = await createTestKobai();
    await using withPlugin = await createTestKobai({
      migrationSets: [priceLogMigrationSet],
    });

    const stock = await inspectSchema(withoutPlugin.database).columnsOwnedBy("core");
    const extended = await inspectSchema(withPlugin.database).columnsOwnedBy("core");

    expect(Object.keys(stock).length).toBeGreaterThan(0);
    expect(extended).toEqual(stock);
  });
});

describe("the asymmetry, side by side", () => {
  /**
   * The two tests above assert that nothing is wrong. These two assert that the checks can
   * tell — without them, `toEqual([])` would pass just as well against an inspector that
   * looked at nothing.
   *
   * They also put the rule's *shape* on the page. What ADR-0004 closes is **Core's tables**,
   * not schema change in general: a package may do as it likes to a table it owns, and a
   * Project — which owns its repository, its migrations and its tables — may add columns to
   * its own freely. Only reaching into `core_*` is forbidden, and only to a Plugin.
   */
  it("catches a foreign key crossing into a Core table", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });

    // Not something this Plugin does. Something a Plugin might reach for, done here by hand
    // so the check is shown catching it.
    await kobai.database.query(`
      alter table price_log_entry
      add column store_singleton boolean references core_store(singleton)
    `);

    await expect(
      inspectSchema(kobai.database).foreignKeysCrossingInto("core"),
    ).resolves.toMatchObject([
      { from: { name: "price_log_entry" }, to: { name: "core_store" } },
    ]);
  });

  it("catches a column added to a Core table, and permits one added to the Plugin's own", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });
    const schema = inspectSchema(kobai.database);
    const stock = await schema.columnsOwnedBy("core");

    // Widening a table you own: allowed, and invisible to the rule. This is the move a
    // Project makes against its own tables whenever it likes.
    await kobai.database.query("alter table price_log_entry add column note text");
    await expect(schema.columnsOwnedBy("core")).resolves.toEqual(stock);

    // Widening a Core table: forbidden to a Plugin, and the check sees it.
    await kobai.database.query("alter table core_store add column smuggled text");
    await expect(schema.columnsOwnedBy("core")).resolves.not.toEqual(stock);
  });
});

describe("an installed Plugin does nothing until the Project wires it", () => {
  it("creates no tables when the Project has not listed its migration set", async () => {
    // This package is a dependency of the test that is running: it is installed, imported,
    // and its migration set is in scope. None of that is installation. Nothing happens
    // until a Project says so in `kobai.config.ts` (ADR-0017).
    expect(priceLogMigrationSet.name).toBe("plugin-price-log");

    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    await expect(schema.tablesOwnedBy("price_log")).resolves.toEqual([]);
    // Not even a tracking table: an unwired Plugin leaves no trace of itself at all.
    const tracking = await schema.migrationTracking();
    expect(tracking.map((entry) => `${entry.schema}.${entry.table}`)).toEqual([
      "drizzle.__drizzle_migrations_core",
    ]);
  });

  it("changes no behaviour when the Project has not wired it", async () => {
    await using unwired = await createTestKobai();
    await using wired = await createTestKobai({ migrationSets: [priceLogMigrationSet] });

    const [before, after] = await Promise.all([
      unwired.request("/admin/store").then((response) => response.json()),
      wired.request("/admin/store").then((response) => response.json()),
    ]);

    expect(before).toEqual(after);
  });
});

describe("install order is not a hidden constraint", () => {
  it("ends up with the same database whichever set is applied first", async () => {
    // ADR-0004's no-foreign-key rule buys more than it was written for: with no FK crossing
    // the boundary, Postgres imposes no cross-package ordering, so a Project may install
    // Plugins in whatever order it likes. Verified by the prototype; locked down here.
    await using backwards = await createTestKobai({ migrate: false });
    await using forwards = await createTestKobai({ migrate: false });

    const pluginFirst = await runMigrations(backwards.db, [
      priceLogMigrationSet,
      coreMigrationSet,
    ]);
    const coreFirst = await runMigrations(forwards.db, [
      coreMigrationSet,
      priceLogMigrationSet,
    ]);

    expect(pluginFirst.ok).toBe(true);
    expect(coreFirst.ok).toBe(true);

    const backwardsSchema = inspectSchema(backwards.database);
    const forwardsSchema = inspectSchema(forwards.database);

    // Said outright before the comparison, because two empty databases are also equal.
    await expect(backwardsSchema.tablesOwnedBy("price_log")).resolves.toEqual([
      "price_log_entry",
    ]);
    await expect(backwardsSchema.tablesOwnedBy("core")).resolves.toEqual(["core_store"]);
    // And Core's own first migration ran: its seed row is there, applied after a Plugin's
    // table already existed.
    await expect(
      backwards.database.query("select name from core_store"),
    ).resolves.toEqual([{ name: "kobai" }]);

    await expect(backwardsSchema.tables()).resolves.toEqual(
      await forwardsSchema.tables(),
    );
    await expect(backwardsSchema.columnsOwnedBy("core")).resolves.toEqual(
      await forwardsSchema.columnsOwnedBy("core"),
    );
    await expect(backwardsSchema.columnsOwnedBy("price_log")).resolves.toEqual(
      await forwardsSchema.columnsOwnedBy("price_log"),
    );
    await expect(backwardsSchema.migrationTracking()).resolves.toEqual(
      await forwardsSchema.migrationTracking(),
    );
  });
});
