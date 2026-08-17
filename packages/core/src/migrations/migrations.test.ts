import { afterEach, describe, expect, it } from "vitest";
import { type TestKobai, createTestKobai, inspectSchema } from "../testing/index.ts";
import { coreMigrationSet } from "./core-set.ts";
import { runMigrations } from "./run.ts";
import {
  KOBAI_MIGRATIONS_SCHEMA,
  defineMigrationSet,
  migrationsTableFor,
} from "./set.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

describe("migration tracking", () => {
  it("tracks Core's migrations in Core's own table, in an explicitly named schema", async () => {
    kobai = await createTestKobai();

    await expect(inspectSchema(kobai.database).migrationTracking()).resolves.toEqual([
      { schema: "drizzle", table: "__drizzle_migrations_core", applied: 2 },
    ]);
  });

  it("leaves nothing tracking where either tool would default to", async () => {
    // ADR-0030: the CLI reads `migrations.schema` from drizzle.config.ts while the
    // programmatic migrator ignores it and falls back to `drizzle`. Two paths, two
    // defaults, no warning — so this names every tracking table in the database, in full.
    // A bare `__drizzle_migrations`, or anything in `public`, means the paths have diverged
    // and each is about to re-apply what the other already ran.
    kobai = await createTestKobai();

    const tracking = await inspectSchema(kobai.database).migrationTracking();

    expect(tracking.map((entry) => `${entry.schema}.${entry.table}`)).toEqual([
      "drizzle.__drizzle_migrations_core",
    ]);
    expect(KOBAI_MIGRATIONS_SCHEMA).toBe("drizzle");
  });

  it("derives one tracking table per package, so two packages cannot race in one", () => {
    expect(migrationsTableFor("core")).toBe("__drizzle_migrations_core");
    expect(migrationsTableFor("plugin-reviews")).toBe(
      "__drizzle_migrations_plugin_reviews",
    );
    expect(migrationsTableFor("core")).not.toBe(migrationsTableFor("plugin-reviews"));
  });

  it("refuses a name that would collide with another package's table", () => {
    // `plugin_reviews` sanitised would be indistinguishable from `plugin-reviews`, and two
    // packages silently sharing a tracking table is the failure ADR-0030 is about.
    expect(() => migrationsTableFor("plugin_reviews")).toThrow(/not usable/);
    expect(() => migrationsTableFor("Plugin-Reviews")).toThrow(/not usable/);
    // Postgres truncates at 63 bytes, and a truncated table is a shared table.
    expect(() => migrationsTableFor("a".repeat(64))).toThrow(/63-byte/);
  });

  it("is idempotent — a second run applies nothing new", async () => {
    kobai = await createTestKobai();
    const first = kobai.migration;
    const second = await kobai.migrate();

    expect(first?.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first?.ok || !second.ok) return;
    expect(second.sets).toEqual(first.sets);
  });

  it("creates only tables carrying Core's own prefix", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    const everything = (await schema.tables()).map((table) => table.name);

    expect(everything.length).toBeGreaterThan(0);
    await expect(schema.tablesOwnedBy("core")).resolves.toEqual(everything);
  });
});

describe("the runner is reachable on its own", () => {
  it("applies sets a caller hands it directly, in the order given", async () => {
    // The seam a Plugin's tests use. Nothing about Core is privileged here: `runMigrations`
    // takes any Drizzle handle and any list of sets, which is what lets a later ticket prove
    // that applying a Plugin's set *before* Core's still ends up correct (ADR-0004).
    await using harness = await createTestKobai({ migrate: false });

    const outcome = await runMigrations(harness.db, [coreMigrationSet]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.sets).toEqual([
      {
        name: "core",
        migrationsTable: "__drizzle_migrations_core",
        migrationsSchema: "drizzle",
        applied: 2,
      },
    ]);
  });
});

describe("migration failure", () => {
  it("reports which set failed and applies nothing further", async () => {
    // A set pointed at a folder that holds no journal. Whatever the cause, the contract is
    // that the failure is attributed and the application does not pretend to be migrated.
    const broken = defineMigrationSet({
      name: "plugin-broken",
      migrationsFolder: "/nonexistent/kobai/migrations",
    });

    kobai = await createTestKobai({ migrationSets: [broken] });

    expect(kobai.migration?.ok).toBe(false);
    if (kobai.migration?.ok !== false) return;
    expect(kobai.migration.set).toBe("plugin-broken");
    expect(kobai.migrationState()).toMatchObject({
      status: "failed",
      set: "plugin-broken",
    });
  });
});
