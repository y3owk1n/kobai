import { describe, expect, it } from "vitest";
import { createTestKobai, inspectSchema, seedTestOrder } from "../testing/index.ts";

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
 * Store, Merchant, Role, the catalog's Product, Variant and Price, the Cart and its Line
 * Items, and now the Order with its own and its Adjustments. Each must arrive carrying
 * `metadata`, because ADR-0004's bargain is that Core's tables are closed *and* there is a
 * cheap way to stash a field anyway. Adding an entity here without the column fails this test,
 * which is the point of the list.
 *
 * On the Cart and the Line Item the column is more than cheap: ADR-0013 has a Project's
 * replaced pricing Step read its inputs from a Line Item's `metadata`, so it is the door a
 * Shopper's unmodelled choice comes through, and there is no other one. On the Order it is the
 * far end of that door — what came through it is copied onto the snapshot at Capture, because
 * an immutable record that dropped it would be the one place the Shopper's choice is not
 * recoverable. On an Adjustment it is the *other* end again: Core validates nothing about a
 * discount or a surcharge, so the Step's own account of why it applied one has nowhere else to
 * go.
 *
 * A session is deliberately absent: it is a Merchant's transient claim rather than a row
 * anybody would hang a field off, and it is deleted the moment it stops being useful. An
 * API key is not absent for the same reason it is not a session — it is a long-lived,
 * named thing a Merchant manages, and a Plugin wanting to hang a field off one is ordinary.
 *
 * Inventory is here and a Reservation is not, and the line between them is the session's line
 * again: what the Store has of a Variant is a long-lived fact a Plugin might want a warehouse
 * bay or a reorder level against, while a Reservation is a claim that lives for minutes and ends
 * as an Order or as nothing at all.
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
  "core_order",
  "core_order_line_item",
  "core_order_adjustment",
  "core_inventory",
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

/**
 * An Adjustment's tax, and the one row it may never sit on (#117).
 *
 * `core_order_adjustment.tax` is where a replaced `calculate-tax` records what it charged on an
 * Adjustment belonging to no line — a delivery surcharge, ADR-0022's own example. A line's
 * Adjustments have no such figure: `calculate-tax` runs after `apply-adjustments` and taxes the
 * *adjusted* line, so their tax is already inside `core_order_line_item.tax`, and a second one
 * here would be charged twice or silently dropped.
 *
 * Core's own types make that unreachable over HTTP — the Adjustments a Step attaches to a line
 * have no `tax` to set — which is exactly why the rule is asserted against Postgres instead.
 * ADR-0037's argument applies: the writers Core does not mediate are the normal case, and a rule
 * held only by a TypeScript type is held only for Core.
 */
describe("tax on an Adjustment", () => {
  it("is refused on one that belongs to a Line Item", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const [line] = await kobai.database.query<{ id: string }>(
      "select id from core_order_line_item where order_id = $1",
      [order.id],
    );

    await expect(
      kobai.database.query(
        `insert into core_order_adjustment
           (order_id, order_line_item_id, position, code, description, amount, tax)
         values ($1, $2, 0, 'taxed-line-discount', 'A line discount with a tax of its own', -100, 10)`,
        [order.id, line?.id],
      ),
    ).rejects.toThrow(/core_order_adjustment_line_level_is_untaxed/);
  });

  it("is written on one that belongs to the Order as a whole", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);

    await kobai.database.query(
      `insert into core_order_adjustment
         (order_id, order_line_item_id, position, code, description, amount, tax)
       values ($1, null, 0, 'delivery', 'Delivery', 500, 50)`,
      [order.id],
    );

    // Scoped to the row this test wrote rather than to the Order: what else `seedTestOrder`
    // arranges on the way is promised to nobody (ADR-0047).
    await expect(
      kobai.database.query(
        "select tax from core_order_adjustment where order_id = $1 and code = 'delivery'",
        [order.id],
      ),
    ).resolves.toEqual([{ tax: "50" }]);
  });
});
