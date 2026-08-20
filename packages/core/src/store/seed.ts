import { sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { region, store, storeCurrency } from "../db/schema.ts";
import { readStore } from "./read.ts";

/**
 * The default Region, seeded at boot from the currency this deployment prices in (#291,
 * ADR-0041, ADR-0074).
 *
 * **Why a boot and not a migration**, which is the decision here and is not the obvious answer:
 * `core_store` itself is seeded by a migration (`0001_seed_store.sql`) precisely because the
 * table is meaningless empty. A Region is different in one way that settles it — it *selects*
 * the Store's currency, and which currency this Store prices in is not final until every
 * migration set has applied. A Project's own set may write Core's tables and the reference one
 * does exactly that, moving the Store off Core's placeholder; Core's set runs in front of it, so
 * a Core migration seeding this would name `USD` on a Store that prices in ringgit. A boot
 * happens after all of them.
 *
 * **Why it is seeded at all.** Without it, `GET /store/variants/{id}/price?region=`'s fallback
 * would have to be *a default Region if there is one, otherwise the Store's default currency* —
 * two code paths for one question, and one of them reachable only on deployments nobody had got
 * round to configuring. ADR-0074 says the Store owes a default Region; this is the payment.
 *
 * **What it is named.** The currency code, because that is the only honest thing a deployment
 * that has said nothing about geography can be called: `MYR` is *where this Store's prices are
 * in ringgit*, and inventing `Default` or a country would be a claim nobody made. A Merchant
 * renames it — `PATCH /admin/regions/{id}` — and nothing here ever touches it again.
 *
 * **Nothing about seeding stops a boot**, which is ADR-0041's rule and its reason: a failed
 * migration must exit, because serving against a half-migrated schema is worse than not serving,
 * and this is not that. A deployment with no default Region is a working deployment whose
 * storefront has to name a Region — and a process that exited over it would look, to whatever
 * supervises the container, exactly like the migration failure that must exit.
 */

/**
 * What a boot's seeding did, in the three outcomes a deployment can tell apart.
 *
 * Three rather than ADR-0041's four, and the missing one is `not-configured`: the first Merchant
 * arrives as credentials a deployment supplies and this is derived from a row Core seeded, so
 * there is nothing to configure and no way to configure it wrongly. `not-usable` stays, because
 * there is one way for this to be impossible — a database migrated but holding no Store — and
 * saying so is better than a boot that throws.
 */
export type DefaultRegionSeed =
  /** Created by this boot, and the Store now falls back to it. */
  | { readonly status: "seeded"; readonly region: SeededRegion }
  /** The Store already had a default Region, so nothing was created. Every boot after the first. */
  | { readonly status: "already-present" }
  /** There was nothing to derive one from — a schema without the row `0001` seeds. */
  | { readonly status: "not-usable"; readonly detail: string };

/** What was created, for the one caller that logs it. */
export type SeededRegion = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
};

/**
 * The advisory-lock key seeding the default Region serialises on.
 *
 * Arbitrary but fixed, and its own rather than the first Merchant's: two boots of one deployment
 * do both of these, and sharing a key would serialise two unrelated seeds against each other for
 * no reason. It is held for the length of the transaction and released when that ends.
 */
const DEFAULT_REGION_LOCK_KEY = 4_113_050_002;

/**
 * Seeds the default Region, and is safe to call on every boot.
 *
 * **Idempotent in two places, exactly as ADR-0041's is.** The check here answers the ordinary
 * second boot without taking a lock; the re-check inside the transaction answers the case this
 * one cannot — two processes booting against one database in the same second, where both look,
 * both find nothing, and one has to lose. The loser reports `already-present`, because from a
 * boot's point of view that is what happened.
 *
 * **It reads the Store rather than being told anything**, which is what makes it safe to call
 * from a Project that has configured nothing.
 */
export async function seedDefaultRegion(db: Database): Promise<DefaultRegionSeed> {
  const current = await readStore(db);
  if (!current) {
    return {
      status: "not-usable",
      detail:
        "This database holds no Store, so there is no currency to name a Region from. It is migrated but unseeded.",
    };
  }
  if (current.defaultRegion !== null) return { status: "already-present" };

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${DEFAULT_REGION_LOCK_KEY})`);

    // Re-read *inside* the lock: the process that lost the race has a `defaultRegion` that was
    // null when it looked and is not now, and it must not seed a second one.
    const inside = await readStore(tx);
    if (!inside) {
      return {
        status: "not-usable",
        detail:
          "This database holds no Store, so there is no currency to name a Region from.",
      } as const;
    }
    if (inside.defaultRegion !== null) return { status: "already-present" } as const;

    // **The enabled set is repaired here too, and that is the same argument as the one above
    // rather than a second mechanism.** The migration that created `core_store_currency` enabled
    // whatever the Store held *then*, which on a fresh database is Core's placeholder — and a
    // Project's own set may move the default afterwards, which is precisely what the reference
    // Project's `0001_the_store_prices_in_myr.sql` does. A Region selects one of the enabled
    // currencies, so seeding one for a default the set does not carry would be refused by the
    // foreign key. The invariant is that the Store's default is always enabled, and this is the
    // one moment after every migration set has applied at which it can be restored.
    if (!inside.currencies.some((one) => one.code === inside.defaultCurrency)) {
      // **The set is Core's seed and nothing else, provably**: every write to it goes through
      // `PATCH /admin/store`, which refuses a set leaving the default out — so a set *without*
      // the default is one no request could have produced. Replacing it is therefore taking
      // back a placeholder rather than discarding a Merchant's choice, and it is guarded on
      // there being no Region yet as well, which is the only thing that could be denominated in
      // what is about to go. Where one somehow is, the default is added beside the placeholder
      // instead: a stray currency is untidy, and a foreign-key violation would fail a boot.
      const [anyRegion] = await tx.select({ id: region.id }).from(region).limit(1);
      if (!anyRegion) await tx.delete(storeCurrency);

      await tx
        .insert(storeCurrency)
        .values({ code: inside.defaultCurrency })
        .onConflictDoNothing();
    }

    const [created] = await tx
      .insert(region)
      .values({ name: inside.defaultCurrency, currency: inside.defaultCurrency })
      .returning({ id: region.id, name: region.name, currency: region.currency });
    if (!created) throw new Error("unreachable: seeding a Region answered no row");

    // The Store points at it in the same transaction, which is what makes "has this deployment
    // been seeded" one question rather than two that can disagree.
    await tx.update(store).set({ defaultRegionId: created.id });

    return { status: "seeded", region: created } as const;
  });
}
