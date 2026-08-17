import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { defineMigrationSet } from "../migrations/set.ts";
import {
  createTestKobai,
  inspectSchema,
  type SchemaInspector,
  signInTestMerchant,
  type TableRef,
  type TestKobai,
} from "../testing/index.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/**
 * The Store's table, qualified as Postgres actually holds it.
 *
 * Read back from `tables()` rather than written as the bare string `"core_store"`, which
 * resolves to `public` — so on a deployment whose search path is elsewhere the sweep below
 * would find no foreign key on a table it never looked at, and pass. Looking the name up
 * also fails loudly if the table is ever renamed, where a bare name would go quiet.
 */
async function storeTable(schema: SchemaInspector): Promise<TableRef> {
  const matches = (await schema.tables()).filter((table) => table.name === "core_store");
  const [store] = matches;
  if (store === undefined || matches.length !== 1) {
    throw new Error(`expected exactly one core_store table, found ${matches.length}`);
  }
  return store;
}

describe("GET /admin/store", () => {
  it("returns the Store a fresh database was migrated into being", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "kobai",
      defaultCurrency: "USD",
      metadata: {},
    });
  });

  it("carries no identifier, because there is only ever one Store", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const body = (await (
      await kobai.request("/admin/store", { headers: merchant.headers })
    ).json()) as Record<string, unknown>;

    // An id here is the first thing a storefront would key a cache on, and the second thing
    // someone would add a `where` on. ADR-0005: the Store is never a scoping key.
    expect(Object.keys(body).sort()).toEqual(["defaultCurrency", "metadata", "name"]);
  });
});

describe("the Store is a singleton", () => {
  it("cannot hold a second row", async () => {
    // `await using` rather than the afterEach above, to keep the ergonomic the harness
    // documents from rotting untested.
    await using harness = await createTestKobai();

    // Enforced in DDL, not by convention: the primary key is a boolean pinned to true.
    await expect(
      harness.db.execute(
        sql`insert into core_store (singleton, name, default_currency) values (false, 'second', 'EUR')`,
      ),
    ).rejects.toThrow();
  });

  it("is referenced by no foreign key anywhere in the database", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // A foreign key onto the Store is multi-tenancy arriving by the back door: it makes the
    // Store a scoping key on whatever points at it (ADR-0005).
    //
    // Asked of the one table rather than of the `core` prefix: `foreignKeysCrossingInto`
    // excludes a package's references to itself, so a `core_` table growing a `store_id`
    // would read as Core's own business and pass. The Store is referenced by *nothing* —
    // Core included — which is a strictly stronger rule than ADR-0004's.
    await expect(schema.foreignKeysTargeting(await storeTable(schema))).resolves.toEqual(
      [],
    );
  });

  /**
   * And that sweep is not vacuous, which is the half worth proving: an assertion that would
   * say "no references" whatever the database held would let the scoping key it exists to
   * catch walk straight past it.
   *
   * The table is created here rather than in a migration because that is exactly what the
   * mistake looks like on the day somebody makes it — an ordinary table with a `store_id` on
   * it, added by a Plugin or by Core, neither of which the sweep is allowed to excuse.
   */
  it("names a table that arrives pointing at it", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const store = await storeTable(schema);

    // The Store's key is the boolean pinned to true, so this is what scoping by it would
    // have to look like. The constraint is named rather than left to Postgres, so what the
    // sweep reports back is pinned rather than guessed.
    await kobai.database.query(`
      create table core_scoped (
        id uuid primary key default gen_random_uuid(),
        store_id boolean not null,
        constraint core_scoped_store_fk foreign key (store_id) references core_store (singleton)
      )
    `);

    await expect(schema.foreignKeysTargeting(store)).resolves.toEqual([
      {
        constraint: "core_scoped_store_fk",
        from: { schema: store.schema, name: "core_scoped" },
        to: store,
      },
    ]);
  });
});

describe("traffic before migrations", () => {
  it("is refused while migrations are still pending", async () => {
    kobai = await createTestKobai({ migrate: false });

    const response = await kobai.request("/admin/store");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "booting" });
  });

  it("is refused after a migration has failed", async () => {
    const broken = defineMigrationSet({
      name: "plugin-broken",
      migrationsFolder: "/nonexistent/kobai/migrations",
    });
    kobai = await createTestKobai({ migrationSets: [broken] });

    const response = await kobai.request("/admin/store");

    // Core's own migrations applied before the broken set failed. Serving anyway would be
    // serving against a half-migrated schema, which is the thing this must never do.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "error" });
  });
});
