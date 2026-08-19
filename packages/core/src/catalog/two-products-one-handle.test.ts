import { describe, expect, it } from "vitest";
import { coreMigrationSet, runMigrations } from "../migrations/index.ts";
import { createTestKobai, migrationSetUpTo, type TestKobai } from "../testing/index.ts";
import { slugify } from "./handle.ts";

/**
 * `core_product.handle` arriving at a catalog that is **already there** — which is the only
 * state this migration ever meets in a real deployment, and one no other test of Core's set
 * arranges.
 *
 * `createTestKobai` hands out a database created seconds ago, so every table it migrates is
 * empty. A widening applies perfectly to a table that stayed empty: `SET NOT NULL` finds no row
 * to refuse and a unique constraint finds no pair to disagree about. **So the arrangement is
 * the whole test** — rows first, then the rest of the set, the way
 * `packages/plugin-price-log/src/migrations.test.ts` does it for the column that taught this
 * repository the lesson (#58, ADR-0038).
 *
 * The second hazard is the one this file exists for (#119, #153). A required column can be
 * backfilled with anything; a **unique** one cannot, because the value the backfill writes has
 * to be different for every row it writes it to. Two Products sharing a title is the ordinary
 * case rather than the edge one, so `0037` has to *guarantee* uniqueness rather than hope the
 * slugs differ — and every case below is a shape that a plausible backfill gets wrong.
 *
 * Nothing here reaches past the migration seam. The rows are written with SQL because the
 * application cannot boot against a half-migrated database, which is exactly the deployment
 * this migration arrives at.
 */

/** The last migration before the handle — where a deployment stands when `0036` reaches it. */
const BEFORE_THE_HANDLE = "0035_famous_vin_gonzales";

type ProductRow = {
  readonly title: string;
  readonly handle: string;
  [column: string]: unknown;
};

/**
 * A catalog written before the column existed, oldest first.
 *
 * Every entry is here because a backfill can plausibly get it wrong, and the third is the one
 * that catches the *likely* wrong answer: numbering per duplicated title hands `blue-poster-2`
 * to the second `Blue poster` **and** to the Product actually called `Blue poster 2`, and
 * `0038` then refuses to apply at the first deployment holding both.
 */
const AS_WRITTEN = [
  { at: "2024-01-01T00:00:00Z", title: "Blue poster" },
  { at: "2024-01-02T00:00:00Z", title: "Blue poster" },
  { at: "2024-01-03T00:00:00Z", title: "Blue poster 2" },
  // Case and punctuation are not a difference an address can carry, so this is a third
  // collision arriving in the spelling a Merchant would not think of as one.
  { at: "2024-01-04T00:00:00Z", title: "BLUE POSTER!" },
  // Nothing addressable survives either of these, so the slug alone would write `''` twice —
  // which is both an unusable handle and a duplicate.
  { at: "2024-01-05T00:00:00Z", title: "★" },
  { at: "2024-01-06T00:00:00Z", title: "!!!" },
  // A title that reads as an identifier. Taken as the handle it would make this Product
  // unreachable by its own address, because `GET /store/products/{idOrHandle}` would look it
  // up as an id and find nothing.
  { at: "2024-01-07T00:00:00Z", title: "9f8a1c0e-3b6d-4a2f-9c11-5d7e2b8a4f36" },
  // An accent is the case that says the SQL decomposes rather than merely stripping: `caf`
  // would be the answer without it, and `cafe-creme` is what `slugify` answers in TypeScript.
  { at: "2024-01-08T00:00:00Z", title: "Café Crème" },
  // Punctuation of every width, so the comparison against `slugify` below has something to
  // disagree about: a run of `(`, `)`, `—` and spaces is one separator, not four.
  { at: "2024-01-09T00:00:00Z", title: "Blue Poster (A2) — 2024" },
] as const;

/**
 * A database standing exactly where `0036` will find one: migrated as far as `0035`, and in
 * service.
 */
async function aCatalogWrittenBeforeTheHandle(): Promise<TestKobai> {
  const kobai = await createTestKobai({ migrate: false });

  {
    await using asShipped = await migrationSetUpTo(coreMigrationSet, BEFORE_THE_HANDLE);
    const before = await runMigrations(kobai.db, [asShipped]);
    expect(before.ok, "applying Core's set as it shipped before the handle").toBe(true);
  }

  for (const { at, title } of AS_WRITTEN) {
    await kobai.database.query(
      'insert into "core_product" ("title", "created_at") values ($1, $2)',
      [title, at],
    );
  }

  // Said out loud, because the whole point is that this migration meets rows: against an empty
  // table every assertion below would hold of a backfill that did nothing at all.
  await expect(
    kobai.database.query('select count(*)::int as rows from "core_product"'),
  ).resolves.toEqual([{ rows: AS_WRITTEN.length }]);

  return kobai;
}

/** Every Product, oldest first — the order `0037` assigns handles in. */
function handlesOf(kobai: TestKobai): Promise<ProductRow[]> {
  return kobai.database.query<ProductRow>(
    'select "title", "handle" from "core_product" order by "created_at", "id"',
  );
}

describe("the handle arriving at a catalog that is already there", () => {
  it("applies onto Products written before the column existed", async () => {
    await using kobai = await aCatalogWrittenBeforeTheHandle();

    const upgrade = await runMigrations(kobai.db, [coreMigrationSet]);

    expect(upgrade).toMatchObject({ ok: true });
  });

  it("gives every Product an address, and no two the same one", async () => {
    await using kobai = await aCatalogWrittenBeforeTheHandle();

    await runMigrations(kobai.db, [coreMigrationSet]);

    const handles = (await handlesOf(kobai)).map((row) => row.handle);
    expect(handles).toHaveLength(AS_WRITTEN.length);
    expect(handles.filter((handle) => handle === "")).toEqual([]);
    // The property `0038` rests on, asserted as itself rather than inferred from the values
    // below: had the constraint been the only check, this test would say "it applied" and never
    // which rows it was applied to.
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("hands the plain address to the oldest, and numbers the rest after it", async () => {
    await using kobai = await aCatalogWrittenBeforeTheHandle();

    await runMigrations(kobai.db, [coreMigrationSet]);

    // Oldest first by `(created_at, id)`, which is the order every list in kobai already reads
    // in — so the Product that has been at that address longest keeps it, and the numbering is
    // deterministic rather than whatever order Postgres happened to read the table in.
    //
    // `blue-poster-2-2` is the case that matters: `Blue poster 2` is a real title whose own
    // slug had already been handed to the second `Blue poster`, so the backfill numbers it
    // again rather than writing the duplicate a per-title count would have written.
    await expect(handlesOf(kobai)).resolves.toEqual([
      { title: "Blue poster", handle: "blue-poster" },
      { title: "Blue poster", handle: "blue-poster-2" },
      { title: "Blue poster 2", handle: "blue-poster-2-2" },
      { title: "BLUE POSTER!", handle: "blue-poster-3" },
      { title: "★", handle: "product" },
      { title: "!!!", handle: "product-2" },
      { title: "9f8a1c0e-3b6d-4a2f-9c11-5d7e2b8a4f36", handle: "product-3" },
      { title: "Café Crème", handle: "cafe-creme" },
      { title: "Blue Poster (A2) — 2024", handle: "blue-poster-a2-2024" },
    ]);
  });

  it("derives the same slug the application derives", async () => {
    // Two implementations of one rule is the price of the backfill being SQL, and this is the
    // only place a comparison of them is worth anything: a Product from before the column and
    // one created after it have to be addressed the same way, or a Merchant's catalog is
    // spelled two ways depending on when each Product was written.
    await using kobai = await aCatalogWrittenBeforeTheHandle();

    await runMigrations(kobai.db, [coreMigrationSet]);

    const rows = await handlesOf(kobai);
    // Every Product whose slug nothing else had taken carries exactly the string `slugify`
    // produces, accents, punctuation and all. The rest are the two cases the SQL answers for
    // and `slugify` deliberately does not — a title with no address in it, and one the
    // collision rule had to number — and they are named here rather than filtered out, so a
    // backfill that started answering differently for an *ordinary* title cannot hide among
    // them.
    const spelledAsProposed = rows.filter((row) => row.handle === slugify(row.title));
    expect(spelledAsProposed.map((row) => row.title)).toEqual([
      "Blue poster",
      "Café Crème",
      "Blue Poster (A2) — 2024",
    ]);
  });

  it("leaves the constraint really enforcing itself afterwards", async () => {
    // The backfill is for the rows that were already there and must not become a licence for
    // the next one: a Product written without an address, or written at an address another
    // Product answers to, has to be refused rather than numbered behind everybody's back.
    await using kobai = await aCatalogWrittenBeforeTheHandle();

    await runMigrations(kobai.db, [coreMigrationSet]);

    await expect(
      kobai.database.query('insert into "core_product" ("title") values ($1)', [
        "No address",
      ]),
    ).rejects.toThrow(/null value in column "handle"/);
    await expect(
      kobai.database.query(
        'insert into "core_product" ("title", "handle") values ($1, $2)',
        ["A second blue poster", "blue-poster"],
      ),
    ).rejects.toThrow(/core_product_handle_unique/);
  });
});
