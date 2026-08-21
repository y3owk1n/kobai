import { eq } from "drizzle-orm";
import type { Queryable } from "../db/client.ts";
import { joined } from "../db/join.ts";
import { region, store } from "../db/schema.ts";
import { type EnabledCurrency, readEnabledCurrencies } from "./currency.ts";
import type { Region, RegionIdentity } from "./region.ts";
import { readShippingMethods } from "./shipping-method.ts";

/** The Store as the API reports it. There is no identifier, because there is only one. */
export type Store = {
  readonly name: string;
  readonly defaultCurrency: string;
  /**
   * Every currency this Store may price in, by code — the vocabulary, and always including
   * {@link Store.defaultCurrency} (ADR-0074).
   *
   * A field of this record rather than a list route of its own, which `store/currency.ts`
   * argues: the set is read behind `store:read` and written behind `store:write`, and a plural
   * route over a table a Merchant can insert into would have had to page (ADR-0064).
   */
  readonly currencies: readonly EnabledCurrency[];
  /**
   * The Region a storefront that names none is answered for, or `null` before the first boot
   * that seeded one (`store/seed.ts`).
   *
   * The whole Region rather than its identifier, on `Merchant.role`'s shape: what a Merchant
   * wants to see is which geography and which currency, and a second request to find out is one
   * every client would make.
   */
  readonly defaultRegion: Region | null;
  readonly metadata: Record<string, unknown>;
};

/**
 * Reads the Store.
 *
 * Note what is absent: there is no `where` clause and no argument to scope by, because
 * there is nothing to scope by. One deployment serves exactly one Store (ADR-0005). A
 * future reader tempted to add a parameter here should read that ADR first — a scoping key
 * on this function is the first move of a multi-tenancy retrofit.
 *
 * **`Queryable`, so a write can read inside its own transaction** — which is how `updateStore`
 * decides against the row it is about to write rather than against whatever was there a
 * statement ago, and how `seedDefaultRegion` re-reads inside its lock. It takes no lock either
 * way: a plain read in Postgres blocks on nothing.
 *
 * **Two statements, because the enabled set is rows.** A left join would repeat the Store per
 * currency and leave the caller to fold it back up; the second read is the honest shape and the
 * table holds one row per currency this deployment prices in.
 */
export async function readStore(db: Queryable): Promise<Store | undefined> {
  const [row] = await db
    .select({
      name: store.name,
      defaultCurrency: store.defaultCurrency,
      metadata: store.metadata,
      // The default Region is a `left` join because it is nullable until a boot seeds it, and
      // an inner one would answer "there is no Store" for a deployment that merely has no
      // Region yet.
      region: {
        id: region.id,
        name: region.name,
        currency: region.currency,
        metadata: region.metadata,
      },
    })
    .from(store)
    .leftJoin(region, eq(region.id, store.defaultRegionId))
    .limit(1);
  if (!row) return undefined;

  // `joined` is the reading of a left join, and `db/join.ts` is where the trap it avoids is
  // written down: an unjoined row arrives as an object of nulls rather than as `null`.
  const defaultRegion = joined<Omit<Region, "shippingMethods">>(row.region);

  return {
    name: row.name,
    defaultCurrency: row.defaultCurrency,
    currencies: await readEnabledCurrencies(db),
    // A third statement, and for `currencies`' reason: a Region carries its shipping methods
    // (#321), which are rows, so a join here would repeat the Store per rate. Skipped entirely
    // for a Store with no default Region, which is a deployment no boot has seeded.
    defaultRegion:
      defaultRegion === null
        ? null
        : {
            ...defaultRegion,
            shippingMethods: await readShippingMethods(db, defaultRegion.id),
          },
    metadata: row.metadata,
  };
}

/**
 * The Region a request that names none is priced for — the Store's default, as an identity
 * (#292, ADR-0074).
 *
 * Its own function beside {@link readDefaultCurrency} and for that one's reason: this is on the
 * read path of every price a storefront asks for, and the caller wants the Region rather than
 * the Store, the enabled set and the Region's `metadata` with it.
 *
 * `undefined` covers both ways there can be none — a database holding no Store, and a Store
 * whose `default_region_id` is still `null` because no boot has seeded one (`store/seed.ts`).
 * They are one answer here because they are one answer to the caller: *this deployment cannot
 * price a request that names no Region*, and naming one is the repair either way.
 */
export async function readDefaultRegion(
  db: Queryable,
): Promise<RegionIdentity | undefined> {
  const [row] = await db
    .select({ id: region.id, name: region.name, currency: region.currency })
    .from(store)
    .innerJoin(region, eq(region.id, store.defaultRegionId))
    .limit(1);
  return row;
}

/**
 * The one code an unconstrained Price may be denominated in — the Store's whole record read down
 * to the one column that decides it.
 *
 * Its own function because {@link readStore} is now a join and a second query, and `setPrice` is
 * on the write path for every Price a Merchant enters while wanting **one column** of it. A
 * caller that reached for the whole record would pay for the Region and the enabled set on every
 * price, and would then be reading a shape it does not depend on.
 *
 * `undefined` means there is no Store at all, which is a migrated-but-unseeded database rather
 * than a currency this deployment has not chosen — the caller says so.
 */
export async function readDefaultCurrency(db: Queryable): Promise<string | undefined> {
  const [row] = await db
    .select({ defaultCurrency: store.defaultCurrency })
    .from(store)
    .limit(1);
  return row?.defaultCurrency;
}
