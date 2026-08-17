import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { defineMigrationSet } from "../migrations/set.ts";
import { type TestKobai, createTestKobai } from "../testing/index.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

describe("GET /admin/store", () => {
  it("returns the Store a fresh database was migrated into being", async () => {
    kobai = await createTestKobai();

    const response = await kobai.request("/admin/store");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "kobai",
      defaultCurrency: "USD",
      metadata: {},
    });
  });

  it("carries no identifier, because there is only ever one Store", async () => {
    kobai = await createTestKobai();

    const body = (await (await kobai.request("/admin/store")).json()) as Record<
      string,
      unknown
    >;

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

    const references = await kobai.db.execute<{ src: string }>(sql`
      select tc.table_name as src
      from information_schema.table_constraints tc
      join information_schema.constraint_column_usage ccu
        using (constraint_name, constraint_schema)
      where tc.constraint_type = 'FOREIGN KEY' and ccu.table_name = 'core_store'
    `);

    // A foreign key onto the Store is multi-tenancy arriving by the back door: it makes the
    // Store a scoping key on whatever points at it.
    expect(references.rows).toEqual([]);
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
