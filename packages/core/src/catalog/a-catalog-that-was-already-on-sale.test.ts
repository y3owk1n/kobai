import { describe, expect, it } from "vitest";
import { coreMigrationSet, runMigrations } from "../migrations/index.ts";
import { createTestKobai, migrationSetUpTo, type TestKobai } from "../testing/index.ts";

/**
 * `core_product.status` arriving at a catalog that is **already on sale** — which is the only
 * state this migration ever meets in a real deployment, and one no other test of Core's set
 * arranges.
 *
 * `createTestKobai` hands out a database created seconds ago, so every table it migrates is
 * empty. A widening applies perfectly to a table that stayed empty: `SET NOT NULL` finds no row
 * to refuse and a `CHECK` finds none to disagree with. **So the arrangement is the whole test** —
 * rows first, then the rest of the set — the way `two-products-one-handle.test.ts` does it for
 * the column before this one and `packages/plugin-price-log/src/migrations.test.ts` did it first
 * (#58, ADR-0038).
 *
 * **The hazard this one carries is not the `NOT NULL`; it is the value** (story 30). A required
 * column can be backfilled with anything the constraint accepts, and `draft` would satisfy every
 * statement in `0041` — while taking a Store's entire catalog off its storefront on the deploy
 * that upgraded kobai. That failure is silent, immediate, and reversible only by a Merchant who
 * worked out what happened. So the assertion that matters here is not "it applied" but **what it
 * applied**: every Product that was there before the column existed was on sale, because until
 * `0041` there was nothing else it could be, and `published` is the only value that records that
 * rather than guessing at it.
 *
 * The other half is the pair: **`published` for the rows that were there and `draft` for the
 * rows that come after**, which is exactly what makes this a backfill rather than a default
 * (AGENTS.md — a default that has to be dropped once it has done its job was never a default).
 * Both are asserted, because either alone is satisfied by a column that only does one of them.
 *
 * **Watched failing three ways before it was trusted**, because an assertion nobody has seen
 * fail is not yet known to be able to:
 *
 * - against `0040` writing **`draft`** instead of `published` — the plausible wrong answer, and
 *   the one a `DEFAULT 'draft'` on its own produces: everything still applied and exactly one
 *   case went red, the second, naming `draft` for all four rows. That is the whole point of this
 *   file, and it is the only case in the repository that can see it;
 * - against `0040` writing **`live`**, a word the set does not have: `0041` refused to apply at
 *   all and all four cases failed, which is the `check` earning its place;
 * - against `0040` **taken out entirely**: `SET NOT NULL` refused the rows and all four failed,
 *   which is the plain ADR-0038 hazard and the one every other three-step widening shares.
 *
 * Nothing here reaches past the migration seam. The rows are written with SQL because the
 * application cannot boot against a half-migrated database, which is exactly the deployment this
 * migration arrives at.
 */

/** The last migration before the status — where a deployment stands when `0039` reaches it. */
const BEFORE_THE_STATUS = "0038_stiff_fenris";

type ProductRow = {
  readonly title: string;
  readonly status: string;
};

/**
 * A catalog written before a Product could be anything but on sale, oldest first.
 *
 * Ordinary Products and nothing clever, because the hazard here is not in any one row: what a
 * plausible-but-wrong backfill gets wrong is *every* row at once, which is why there are several
 * and why they are asserted one by one below rather than counted.
 */
const AS_WRITTEN = [
  { at: "2024-01-01T00:00:00Z", title: "Blue poster", handle: "blue-poster" },
  { at: "2024-01-02T00:00:00Z", title: "Red poster", handle: "red-poster" },
  { at: "2024-01-03T00:00:00Z", title: "A mug", handle: "a-mug" },
  { at: "2024-01-04T00:00:00Z", title: "A tote", handle: "a-tote" },
] as const;

/**
 * A database standing exactly where `0039` will find one: migrated as far as `0038`, and in
 * service.
 */
async function aCatalogWrittenBeforeTheStatus(): Promise<TestKobai> {
  const kobai = await createTestKobai({ migrate: false });

  {
    await using asShipped = await migrationSetUpTo(coreMigrationSet, BEFORE_THE_STATUS);
    const before = await runMigrations(kobai.db, [asShipped]);
    expect(before.ok, "applying Core's set as it shipped before the status").toBe(true);
  }

  for (const { at, title, handle } of AS_WRITTEN) {
    await kobai.database.query(
      'insert into "core_product" ("title", "handle", "created_at") values ($1, $2, $3)',
      [title, handle, at],
    );
  }

  // Said out loud, because the whole point is that this migration meets rows: against an empty
  // table every assertion below would hold of a backfill that did nothing at all.
  await expect(
    kobai.database.query('select count(*)::int as rows from "core_product"'),
  ).resolves.toEqual([{ rows: AS_WRITTEN.length }]);

  return kobai;
}

/** Every Product, oldest first — the order they were written in. */
function statusesOf(kobai: TestKobai): Promise<ProductRow[]> {
  return kobai.database.query<ProductRow>(
    'select "title", "status" from "core_product" order by "created_at", "id"',
  );
}

describe("the status arriving at a catalog that is already on sale", () => {
  it("applies onto Products written before the column existed", async () => {
    await using kobai = await aCatalogWrittenBeforeTheStatus();

    const upgrade = await runMigrations(kobai.db, [coreMigrationSet]);

    expect(upgrade).toMatchObject({ ok: true });
  });

  it("leaves every Product that was already on sale published", async () => {
    await using kobai = await aCatalogWrittenBeforeTheStatus();

    await runMigrations(kobai.db, [coreMigrationSet]);

    // Row by row rather than as a count of `published`, so a backfill that got one of them
    // wrong is named rather than averaged away — and titles rather than identifiers, because
    // this is the assertion a person reads when it fails.
    await expect(statusesOf(kobai)).resolves.toEqual(
      AS_WRITTEN.map(({ title }) => ({ title, status: "published" })),
    );
  });

  it("still makes the Product written after it a draft", async () => {
    // The other half of what makes this a backfill rather than a default: the value that was
    // right for the rows already there is not the value that is right for the next one. A
    // migration that wrote `published` and *defaulted* to `published` would satisfy the case
    // above and publish every Product a Merchant has since started drafting.
    await using kobai = await aCatalogWrittenBeforeTheStatus();

    await runMigrations(kobai.db, [coreMigrationSet]);
    await kobai.database.query(
      'insert into "core_product" ("title", "handle") values ($1, $2)',
      ["A new poster", "a-new-poster"],
    );

    await expect(
      kobai.database.query('select "status" from "core_product" where "handle" = $1', [
        "a-new-poster",
      ]),
    ).resolves.toEqual([{ status: "draft" }]);
  });

  it("leaves the constraint really enforcing itself afterwards", async () => {
    // The three words are Core's own and nothing outside Core can invent a fourth, so a row
    // holding one is a bug rather than a Merchant's choice — which is what the `check` is for
    // and is the judgement `handle` deliberately does not take. Asserted here rather than
    // assumed, because a constraint that arrived misspelled would be invisible everywhere else.
    await using kobai = await aCatalogWrittenBeforeTheStatus();

    await runMigrations(kobai.db, [coreMigrationSet]);

    await expect(
      kobai.database.query(
        'insert into "core_product" ("title", "handle", "status") values ($1, $2, $3)',
        ["A live poster", "a-live-poster", "live"],
      ),
    ).rejects.toThrow(/core_product_status_is_known/);
  });
});
