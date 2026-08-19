import { describe, expect, it } from "vitest";
import { createTestKobai } from "./kobai.ts";
import { inspectSchema } from "./schema.ts";

/**
 * What `indexesOf` promises, asserted rather than only written down.
 *
 * `@kobai/core/testing` is promised surface under ADR-0047, so an inspector's answer is public
 * API a Plugin author reads — and every clause of it is a place a wrong answer would be
 * invisible, because the caller has nothing to compare it against. The shapes below are the
 * ones the doc comment claims and the ones nothing in Core happens to have: `db/schema.test.ts`
 * exercises the plain composite index over and over, and would keep passing against a version
 * that dropped an expression column or listed an `INCLUDE`d one.
 *
 * The table is built here rather than found for the same reason. Core has no expression index
 * and no `INCLUDE`, and a promise made only about tables that do not exist is not a promise.
 */
describe("indexesOf", () => {
  it("describes an expression, keeps an INCLUDEd column out, and spells a non-default NULLS", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    await kobai.database.query(
      `create table an_index_of_every_shape (
         id uuid primary key,
         email text not null,
         created_at timestamptz,
         payload jsonb
       )`,
    );
    await kobai.database.query(
      "create index every_shape_expression_idx on an_index_of_every_shape (lower(email))",
    );
    await kobai.database.query(
      "create index every_shape_include_idx on an_index_of_every_shape (created_at) include (payload)",
    );
    await kobai.database.query(
      "create index every_shape_nulls_idx on an_index_of_every_shape (created_at nulls first)",
    );

    await expect(schema.indexesOf("an_index_of_every_shape")).resolves.toEqual([
      // Sorted by name, and the primary key's own index is one of them.
      { name: "an_index_of_every_shape_pkey", columns: ["id"], isPartial: false },
      // An expression index describes itself. Reading `indkey` would report `[]` here, which a
      // caller looking for particular columns cannot tell from an index it simply does not want.
      {
        name: "every_shape_expression_idx",
        columns: ["lower(email)"],
        isPartial: false,
      },
      // `payload` is carried, not ordered by, so it is absent: an answer about ordering that
      // listed it would say this index orders by two columns when it orders by one.
      { name: "every_shape_include_idx", columns: ["created_at"], isPartial: false },
      // Ascending defaults to nulls last, so this one is not the default and says so — while
      // the ascending `created_at` above stays a bare name.
      {
        name: "every_shape_nulls_idx",
        columns: ["created_at NULLS FIRST"],
        isPartial: false,
      },
    ]);
  });

  it("answers for the table it was given, in the schema it was given", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // A bare name resolves to `public`, which is where Core's tables are; a table that is not
    // there has no indexes rather than being an error, so a sweep aimed at the wrong schema
    // reports emptiness instead of failing — which is why the sweeps that matter pass the
    // qualified ref `tables()` hands back.
    await expect(schema.indexesOf("core_product")).resolves.toContainEqual({
      name: "core_product_created_at_id_idx",
      columns: ["created_at", "id"],
      isPartial: false,
    });
    await expect(
      schema.indexesOf({ schema: "drizzle", name: "core_product" }),
    ).resolves.toEqual([]);
  });
});
