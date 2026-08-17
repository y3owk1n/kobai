import { describe, expect, it } from "vitest";
import { createTestKobai, inspectSchema } from "../testing/index.ts";

/**
 * Core's tables, as Postgres holds them.
 *
 * Everything here is a promise ADR-0004 makes to a Plugin author, so it is checked against
 * the real schema rather than against the Drizzle declaration that produced it — a `$type`
 * on a Drizzle column is a compile-time cast and puts nothing in the database.
 */

/**
 * The principal entities — the rows a Plugin is most likely to want one more field on.
 *
 * Store, Merchant, Role, the catalog's Product, Variant and Price, and now the Cart and its
 * Line Items. Each must arrive carrying `metadata`, because ADR-0004's bargain is that Core's
 * tables are closed *and* there is a cheap way to stash a field anyway. Adding an entity here
 * without the column fails this test, which is the point of the list.
 *
 * On the Cart and the Line Item the column is more than cheap: ADR-0013 has a Project's
 * replaced pricing Step read its inputs from a Line Item's `metadata`, so it is the door a
 * Shopper's unmodelled choice comes through, and there is no other one.
 *
 * A session is deliberately absent: it is a Merchant's transient claim rather than a row
 * anybody would hang a field off, and it is deleted the moment it stops being useful. An
 * API key is not absent for the same reason it is not a session — it is a long-lived,
 * named thing a Merchant manages, and a Plugin wanting to hang a field off one is ordinary.
 */
const PRINCIPAL_ENTITIES = [
  "core_store",
  "core_merchant",
  "core_role",
  "core_api_key",
  "core_product",
  "core_variant",
  "core_price",
  "core_cart",
  "core_cart_line_item",
];

describe("metadata, the cheap case", () => {
  it("exists as a JSON column on every principal entity", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    for (const table of PRINCIPAL_ENTITIES) {
      const metadata = (await schema.columnsOf(table)).find(
        (column) => column.name === "metadata",
      );

      expect(metadata, `${table} has no metadata column`).toBeDefined();
      // `jsonb` and nothing else: no check constraint, no shape, no migration to store a
      // field in it. Untyped is the feature — a Plugin that wants a type wants its own table.
      expect(metadata?.dataType).toBe("jsonb");
      // Defaulted and non-null, so reading it never means handling an absence.
      expect(metadata?.isNullable).toBe(false);
      expect(metadata?.hasDefault).toBe(true);
    }
  });

  it("is indexed nowhere", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    for (const table of PRINCIPAL_ENTITIES) {
      // Unindexed by design. An index would make `metadata` a query surface, and a query
      // surface is a promise; ADR-0004 says a Plugin that needs one needs its own table.
      await expect(schema.indexedColumnsOf(table)).resolves.not.toContain("metadata");
    }
  });
});
