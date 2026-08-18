import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { price, product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { readInventoryOf, type VariantInventory } from "../reservation/inventory.ts";

/**
 * Reading the catalog.
 *
 * The shapes here are what the admin surface answers with, and they are the shapes ADR-0008
 * insists on: a Product carries no amount and no SKU, a Variant carries the SKU, and a
 * Variant's Prices are a **list**, because a Price is a row. A storefront asking "what does
 * this cost" is not served from here at all — resolving a Price by best match is the
 * `resolve-price` Workflow, and it answers on the store surface (`pricing/resolve-price.ts`).
 *
 * There is no Store parameter and no scoping key, for the same reason `readStore` has none:
 * one deployment is one Store (ADR-0005).
 */

/** One Price row, as the admin surface reports it. */
export type Price = {
  readonly id: string;
  /**
   * Minor units of `currency` — 1250 is `USD` 12.50. An integer, because money in binary
   * floating point is wrong by construction.
   */
  readonly amount: number;
  /** ISO 4217, upper case. */
  readonly currency: string;
  readonly metadata: Record<string, unknown>;
};

/** The sellable thing, with every Price that has been set on it. */
export type Variant = {
  readonly id: string;
  readonly sku: string;
  readonly metadata: Record<string, unknown>;
  readonly prices: readonly Price[];
  /**
   * What the Store has of it, or `null` when nobody is counting (ADR-0018).
   *
   * Read here rather than through a route of its own because this is where a Merchant is
   * already looking: opening a Product is how you find out about the things you sell, and
   * how many are left is one of those things. Untracked is `null` and not `0` — the first
   * sells freely and the second sells to nobody.
   */
  readonly inventory: VariantInventory | null;
};

/** A Product as a list reports it: no Variants, because a list is not a detail view. */
export type Product = {
  readonly id: string;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
};

/** A Product opened — its Variants and their Prices, which is the whole sellable picture. */
export type ProductDetail = Product & { readonly variants: readonly Variant[] };

/**
 * Every Product, newest first — a Merchant listing them has just created one and is looking
 * for it.
 *
 * Unpaginated, deliberately: a page parameter is an interface promise, and inventing one
 * before there is a Merchant with enough Products to need it would fix its shape by
 * guesswork. The list has an envelope (`{ products }`) precisely so pagination can arrive
 * beside it rather than by breaking the response.
 */
export async function listProducts(db: Database): Promise<Product[]> {
  return (
    db
      .select({ id: product.id, title: product.title, metadata: product.metadata })
      .from(product)
      // `id` breaks the tie, so two Products created in the same instant still come back in
      // one stable order rather than in whichever order Postgres happened to read them.
      .orderBy(desc(product.createdAt), desc(product.id))
  );
}

/**
 * One Product with its Variants and their Prices, or `undefined` when there is no such
 * Product — including when `id` is not an identifier at all, which is the same answer for
 * the caller and avoids handing Postgres a value it would refuse to cast.
 */
export async function readProduct(
  db: Database,
  id: string,
): Promise<ProductDetail | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select({ id: product.id, title: product.title, metadata: product.metadata })
    .from(product)
    .where(eq(product.id, id))
    .limit(1);
  if (!row) return undefined;

  return { ...row, variants: await readVariants(db, row.id) };
}

/**
 * The Variants of one Product, each carrying its Prices.
 *
 * Two queries rather than a join, because a join multiplies each Variant by its Prices and
 * the rows then have to be folded back apart in TypeScript anyway — and a Variant with no
 * Price yet has to survive that fold, which is exactly the row an inner join drops.
 */
export async function readVariants(db: Database, productId: string): Promise<Variant[]> {
  const variants = await db
    .select({ id: variant.id, sku: variant.sku, metadata: variant.metadata })
    .from(variant)
    .where(eq(variant.productId, productId))
    // By SKU: it is unique, so the order is total and stable, and it is the only column here
    // a Merchant would recognise. `created_at` would tie for Variants created together, and
    // they always are.
    .orderBy(asc(variant.sku));
  if (variants.length === 0) return [];

  const prices = await db
    .select({
      id: price.id,
      variantId: price.variantId,
      amount: price.amount,
      currency: price.currency,
      metadata: price.metadata,
    })
    .from(price)
    .where(
      inArray(
        price.variantId,
        variants.map((row) => row.id),
      ),
    )
    .orderBy(asc(price.createdAt), asc(price.id));

  const byVariant = new Map<string, Price[]>();
  for (const row of prices) {
    const { variantId, ...reported } = row;
    const existing = byVariant.get(variantId);
    if (existing) existing.push(reported);
    else byVariant.set(variantId, [reported]);
  }

  // A third query rather than a join, for the reason the second one is: a Variant that nobody
  // counts has no row, and it must survive being read about.
  const stock = await readInventoryOf(
    db,
    variants.map((row) => row.id),
  );

  return variants.map((row) => ({
    ...row,
    prices: byVariant.get(row.id) ?? [],
    inventory: stock.get(row.id) ?? null,
  }));
}
