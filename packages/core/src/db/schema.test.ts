import { getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  type IndexFact,
  inspectSchema,
  type SchemaInspector,
  seedTestOrder,
} from "../testing/index.ts";
import type { PagedList } from "./page.ts";
import {
  apiKey,
  cart,
  channel,
  collection,
  media,
  merchant,
  order,
  price,
  product,
  region,
  role,
} from "./schema.ts";

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
 * Store, Merchant, Role, the catalog's Product, Variant, Price and Collection, the Cart and its
 * Line Items, and the Order with its own and its Adjustments. Each must arrive carrying
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
  "core_collection",
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

/**
 * The index a paged list rests on (ADR-0064, #219).
 *
 * Every list route pages by keyset — `order by created_at desc, id desc`, resumed with a row
 * comparison against that pair — and the whole argument for it assumes the query stays on an
 * index rather than sorting the table. Nothing enforced that. `0028` indexed three tables and
 * #173's two lists shipped without one, from an ordinary declaration, with a green gate; the
 * index was the one clause of ADR-0064's contract held by somebody remembering it.
 *
 * **The expectation is derived from {@link PagedList}, which is the side under test's other
 * half** (ADR-0049). A paged list is a route, and `PagedList` is the closed set of them —
 * `pagination.test.ts` already holds that set against the routes the OpenAPI description says
 * take an `after`, so a list route that shipped without an entry reddens there rather than
 * quietly leaving this sweep. What this file adds is the storage end of the same fact.
 *
 * **`PAGED_TABLES` is a `Record<PagedList, …>` so that an omission does not compile.** It is
 * the one thing here written by hand — nothing derives a table from a route's name, and
 * `store-products` is the reason nothing should try: it and `products` page the same table
 * under two names, because a cursor names a *list* and there are two of them.
 *
 * **It was watched failing against the schema as #219 found it**, before either index was
 * declared: `the roles list pages core_role, which has no (created_at, id) index`. ADR-0049's
 * trap is that a derivation reading the side it checks looks identical to a good one and
 * asserts nothing, so the run is the proof rather than the reading.
 */
type PagedTable = PgTable & {
  readonly id: PgColumn;
  readonly createdAt: PgColumn;
};

const PAGED_TABLES: Record<PagedList, PagedTable> = {
  products: product,
  prices: price,
  "store-products": product,
  orders: order,
  "api-keys": apiKey,
  roles: role,
  merchants: merchant,
  carts: cart,
  media,
  collections: collection,
  regions: region,
  channels: channel,
};

/**
 * The index that supports one list's ordering, or nothing — the pair **in order**, at the head
 * of an index that covers the whole table.
 *
 * `indexesOf` rather than `indexedColumnsOf`, and that is the whole point of the check: the
 * flattened answer says `created_at` and `id` are each indexed *somehow*, which a table with two
 * single-column indexes satisfies while supporting neither the ordering nor the row comparison.
 *
 * **Three shapes name the right columns and answer for none of it**, and the cases below watch
 * each one refused: two single-column indexes, the same pair declared `desc` — which serves
 * `order by created_at, id` and not the `desc, desc` every reader here wants — and a partial
 * index, which covers whichever rows its `where` clause admitted and silently not the rest.
 *
 * A **prefix** rather than an equality, because an index that leads with the pair and carries
 * more still orders by it. The columns are compared as `indexesOf` renders them, direction
 * included, so a bare `created_at` matches the ascending declaration and nothing else: every
 * reader wants `desc` and one ordering reversed whole is a backwards scan of the same index,
 * which is why none of these is declared descending.
 */
async function keysetIndexOf(
  schema: SchemaInspector,
  table: string,
  pair: readonly [string, string],
): Promise<IndexFact | undefined> {
  const indexes = await schema.indexesOf(table);
  return indexes.find(
    (index) =>
      !index.isPartial && pair.every((column, at) => index.columns[at] === column),
  );
}

describe("the index a paged list rests on", () => {
  it("exists, as the pair and in order, on every table a list pages", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    for (const [list, table] of Object.entries(PAGED_TABLES) as [
      PagedList,
      PagedTable,
    ][]) {
      const name = getTableName(table);
      const index = await keysetIndexOf(schema, name, [
        table.createdAt.name,
        table.id.name,
      ]);

      expect(
        index,
        `the ${list} list pages ${name}, which has no (${table.createdAt.name}, ${table.id.name}) index`,
      ).toBeDefined();
    }
  });

  it("is not two single-column indexes that cover the same two names", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // A table shaped like the mistake this check exists to name: both columns indexed, neither
    // ordering supported. It is created here rather than found, because Core has no such table
    // and an assertion nobody has watched fail is not yet known to be able to.
    await kobai.database.query(
      `create table a_list_indexed_one_column_at_a_time (
         id uuid primary key,
         created_at timestamptz not null
       )`,
    );
    await kobai.database.query(
      "create index one_column_at_a_time_created_at_idx on a_list_indexed_one_column_at_a_time (created_at)",
    );

    // The loose reading passes it, which is why the sweep above does not ask this one.
    await expect(
      schema.indexedColumnsOf("a_list_indexed_one_column_at_a_time"),
    ).resolves.toEqual(["created_at", "id"]);
    await expect(
      keysetIndexOf(schema, "a_list_indexed_one_column_at_a_time", ["created_at", "id"]),
    ).resolves.toBeUndefined();

    // And the same table, once it carries what a keyset page actually needs.
    await kobai.database.query(
      "create index one_column_at_a_time_keyset_idx on a_list_indexed_one_column_at_a_time (created_at, id)",
    );

    await expect(
      keysetIndexOf(schema, "a_list_indexed_one_column_at_a_time", ["created_at", "id"]),
    ).resolves.toMatchObject({
      name: "one_column_at_a_time_keyset_idx",
      columns: ["created_at", "id"],
      isPartial: false,
    });
  });

  it("is neither the pair declared descending nor one over part of the table", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // The two shapes that name the right columns in the right order and still answer for
    // nothing: a `desc` declaration serves the ascending ordering rather than this one, and a
    // partial index serves whichever rows its `where` admitted. Both are what the sweep would
    // have accepted while `indexesOf` reported a bare column list.
    await kobai.database.query(
      `create table a_list_indexed_the_other_way (
         id uuid primary key,
         created_at timestamptz not null
       )`,
    );
    await kobai.database.query(
      "create index the_other_way_desc_idx on a_list_indexed_the_other_way (created_at desc, id desc)",
    );
    await kobai.database.query(
      `create index the_other_way_partial_idx on a_list_indexed_the_other_way (created_at, id)
       where created_at > '2020-01-01'`,
    );

    await expect(
      keysetIndexOf(schema, "a_list_indexed_the_other_way", ["created_at", "id"]),
    ).resolves.toBeUndefined();

    // And what the refusal rested on, so a version that stopped reporting either one is a
    // failure here rather than a sweep that quietly went back to accepting both.
    await expect(schema.indexesOf("a_list_indexed_the_other_way")).resolves.toEqual([
      { name: "a_list_indexed_the_other_way_pkey", columns: ["id"], isPartial: false },
      {
        name: "the_other_way_desc_idx",
        columns: ["created_at DESC", "id DESC"],
        isPartial: false,
      },
      {
        name: "the_other_way_partial_idx",
        columns: ["created_at", "id"],
        isPartial: true,
      },
    ]);
  });
});
