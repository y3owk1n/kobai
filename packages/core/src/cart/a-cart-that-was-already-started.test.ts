import { describe, expect, it } from "vitest";
import { coreMigrationSet, runMigrations } from "../migrations/index.ts";
import { createTestKobai, migrationSetUpTo, type TestKobai } from "../testing/index.ts";

/**
 * `core_cart.currency` arriving at a Store whose Shoppers **are already holding Carts** — which
 * is the only state this migration ever meets in a live deployment, and one no other test of
 * Core's set arranges (#293, ADR-0038).
 *
 * `createTestKobai` hands out a database created seconds ago, so every table it migrates is
 * empty, and a widening applies perfectly to a table that stayed empty: `SET NOT NULL` finds no
 * row to refuse and the `CHECK` finds none to disagree with. **So the arrangement is the whole
 * test** — Carts first, then the rest of the set — the way
 * `a-catalog-that-was-already-on-sale.test.ts` does it one table along and
 * `packages/plugin-price-log/src/migrations.test.ts` did it first.
 *
 * **`core_cart` is the sharpest table in Core for this hazard.** It takes a row from every
 * storefront session, so it is the one guaranteed to be populated on any Store with traffic —
 * `ADD COLUMN … NOT NULL` in a single statement would have refused at boot, and under ADR-0030
 * that deployment gets no service rather than a bad column.
 *
 * **The value is the fact that was never recorded rather than a guess at one.** A Cart carried
 * no currency until `0055`, and every Price it could have been priced from carried the Store's
 * default — so `core_store.default_currency` is what those Carts *were* denominated in. It is
 * read out of the row rather than written as `USD`, because a deployment's own migration set may
 * have moved it years ago (`reference/migrations/0001_the_store_prices_in_myr.sql` is exactly
 * that), and this asserts it against a Store that has.
 *
 * **`region_id` stays null and that is the assertion, not an omission.** The Store's default
 * Region is seeded at **boot** rather than by a migration (`src/store/seed.ts`), so at the
 * instant this column arrives there may be no Region to name — there is no value a backfill
 * could honestly write, and a Cart with none is priced for the Store's default Region, in the
 * currency stamped here, which is exactly what it was already being priced for.
 *
 * **Watched failing twice before it was trusted**, because an assertion nobody has seen fail is
 * not yet known to be able to: against `0056` taken out entirely — `SET NOT NULL` refused the
 * rows and every case here went red, which is the plain ADR-0038 hazard — and against a `0056`
 * writing `'USD'` as a literal, where the Store priced in MYR and the second case named the
 * wrong currency on all three Carts while everything applied cleanly.
 *
 * Nothing here reaches past the migration seam. The rows are written with SQL because the
 * application cannot boot against a half-migrated database, which is exactly the deployment this
 * migration arrives at.
 */

/** The last migration before the Cart's currency — where a deployment stands when `0055` lands. */
const BEFORE_THE_CURRENCY = "0054_ambitious_titania";

/** What this Store prices in, moved off Core's seeded placeholder the way a Project's set does. */
const THE_STORES_OWN_CURRENCY = "MYR";

type CartRow = {
  readonly currency: string;
  readonly region_id: string | null;
};

/**
 * Carts a Shopper was holding before a Cart said what it was denominated in.
 *
 * Several, and asserted one by one below rather than counted, because what a
 * plausible-but-wrong backfill gets wrong is every row at once.
 */
const AS_STARTED = [
  { at: "2024-01-01T00:00:00Z", email: "first@example.test" },
  { at: "2024-01-02T00:00:00Z", email: "second@example.test" },
  { at: "2024-01-03T00:00:00Z", email: null },
] as const;

/** A database standing exactly where `0055` will find one: migrated to `0054`, and in service. */
async function cartsStartedBeforeTheCurrency(): Promise<TestKobai> {
  const kobai = await createTestKobai({ migrate: false });

  {
    await using asShipped = await migrationSetUpTo(coreMigrationSet, BEFORE_THE_CURRENCY);
    const before = await runMigrations(kobai.db, [asShipped]);
    expect(before.ok, "applying Core's set as it shipped before the currency").toBe(true);
  }

  // The Store prices in something other than Core's placeholder, which is what a Project's own
  // migration set does (`docs/agents/migrations.md`) — so a backfill writing a literal is
  // visible here and invisible on a Store that never moved its default.
  await kobai.database.query('update "core_store" set "default_currency" = $1', [
    THE_STORES_OWN_CURRENCY,
  ]);

  for (const { at, email } of AS_STARTED) {
    await kobai.database.query(
      'insert into "core_cart" ("expires_at", "shopper_email", "created_at") values ($1, $2, $3)',
      ["2099-01-01T00:00:00Z", email, at],
    );
  }

  // Said out loud, because the whole point is that this migration meets rows: against an empty
  // table every assertion below would hold of a backfill that did nothing at all.
  await expect(
    kobai.database.query('select count(*)::int as rows from "core_cart"'),
  ).resolves.toEqual([{ rows: AS_STARTED.length }]);

  return kobai;
}

/** Every Cart, oldest first — the order they were started in. */
function cartsOf(kobai: TestKobai): Promise<CartRow[]> {
  return kobai.database.query<CartRow>(
    'select "currency", "region_id" from "core_cart" order by "created_at", "id"',
  );
}

describe("the currency arriving at Carts somebody is already holding", () => {
  it("applies onto Carts started before the column existed", async () => {
    await using kobai = await cartsStartedBeforeTheCurrency();

    const upgrade = await runMigrations(kobai.db, [coreMigrationSet]);

    expect(upgrade).toMatchObject({ ok: true });
  });

  it("leaves every one of them denominated in the Store's own default", async () => {
    await using kobai = await cartsStartedBeforeTheCurrency();

    await runMigrations(kobai.db, [coreMigrationSet]);

    // Row by row rather than as a count, so a backfill that got one of them wrong is named
    // rather than averaged away — and `region_id` beside it, because *null* is this migration's
    // answer for where those Carts are bought rather than something it failed to fill in.
    await expect(cartsOf(kobai)).resolves.toEqual(
      AS_STARTED.map(() => ({
        currency: THE_STORES_OWN_CURRENCY,
        region_id: null,
      })),
    );
  });

  it("requires one of every Cart written afterwards", async () => {
    // The other half of the widening: the column is `not null` from here on, which is what
    // makes the backfill a backfill rather than a value that could quietly go missing again.
    await using kobai = await cartsStartedBeforeTheCurrency();

    await runMigrations(kobai.db, [coreMigrationSet]);

    await expect(
      kobai.database.query('insert into "core_cart" ("expires_at") values ($1)', [
        "2099-01-01T00:00:00Z",
      ]),
    ).rejects.toThrow(/currency/);
  });

  it("leaves the constraint really enforcing itself afterwards", async () => {
    // `core_price.currency`'s check, said again about the same kind of value. Asserted here
    // rather than assumed, because a constraint that arrived misspelled would be invisible
    // everywhere else — nothing in Core writes a currency this table would refuse.
    await using kobai = await cartsStartedBeforeTheCurrency();

    await runMigrations(kobai.db, [coreMigrationSet]);

    await expect(
      kobai.database.query(
        'insert into "core_cart" ("expires_at", "currency") values ($1, $2)',
        ["2099-01-01T00:00:00Z", "ringgit"],
      ),
    ).rejects.toThrow(/core_cart_currency_is_iso4217/);
  });
});
