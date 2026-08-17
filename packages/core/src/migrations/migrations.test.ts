import { afterEach, describe, expect, it } from "vitest";
import {
  appliedMigrations,
  createTestKobai,
  declaredMigrations,
  inspectSchema,
  type TestKobai,
} from "../testing/index.ts";
import { coreMigrationSet } from "./core-set.ts";
import { runMigrations } from "./run.ts";
import {
  defineMigrationSet,
  KOBAI_MIGRATIONS_SCHEMA,
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

    // `applied` derived rather than pinned: a new migration used to turn four unrelated
    // assertions red, and the number was never what any of them was about (#34, ADR-0049).
    // What the number still buys is the other direction — a row this set does not account
    // for, which is Drizzle having applied something twice. The direction it *cannot* buy
    // is below.
    await expect(inspectSchema(kobai.database).migrationTracking()).resolves.toEqual([
      {
        schema: "drizzle",
        table: "__drizzle_migrations_core",
        applied: (await declaredMigrations(coreMigrationSet)).length,
      },
    ]);
  });

  it("has actually applied every migration Core's journal declares", async () => {
    // Where the strength went when the counts stopped being hardcoded. A count taken from
    // the journal and compared against rows written from that same journal agrees with
    // itself; this asks the database which of Core's migrations it holds, by the digest
    // Drizzle stores of each `.sql`, so a migration that never ran is named rather than
    // subtracted. `packages/core/src/testing/migrations.test.ts` watches it fail.
    kobai = await createTestKobai();

    const declared = await declaredMigrations(coreMigrationSet);

    // Said outright, because two empty lists are also equal.
    expect(declared.length).toBeGreaterThan(0);
    await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
      declared,
    );
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
        applied: (await declaredMigrations(coreMigrationSet)).length,
      },
    ]);
    // What the runner *reported* is one claim; what the database holds is another, and the
    // count above cannot tell them apart on its own.
    await expect(appliedMigrations(harness.database, coreMigrationSet)).resolves.toEqual(
      await declaredMigrations(coreMigrationSet),
    );
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
