import { asc, desc, eq, inArray } from "drizzle-orm";
import type { Database, Queryable } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
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

/** How this Variant is delivered — the Strategy it points at, by name (ADR-0014). */
export type VariantFulfilment = {
  /**
   * The name the deployment wired this Strategy under: `physical`, `digital`, or a Plugin's.
   *
   * The name and not the answers. Does it ship, does it consume stock, does it have a Lead
   * Time are questions the Strategy answers when Core asks — reporting them here would put a
   * cached copy of a live decision in a catalog read, and a Project that rewired the Strategy
   * would have to be trusted to remember this one too. Where the answers are recorded is on
   * the Fulfilments of an Order, because there they are a snapshot of what was true at Capture
   * and must never move again (ADR-0009).
   */
  readonly strategy: string;
};

/** The sellable thing, with every Price that has been set on it. */
export type Variant = {
  readonly id: string;
  readonly sku: string;
  /** The Fulfilment Strategy this Variant points at — `physical` unless it was created saying. */
  readonly fulfilment: VariantFulfilment;
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
 * A page of Products, newest first — a Merchant listing them has just created one and is
 * looking for it.
 *
 * One page rather than all of them (ADR-0064), and located by a cursor rather than an offset:
 * this is the list where an unbounded response hurts first, because a Merchant's catalog grows
 * and nothing about the route said when to stop. `page.after` is the record the caller last
 * saw, so a Product created since changes nothing about what follows it.
 */
export async function listProducts(
  db: Database,
  page: PageRequest,
): Promise<Page<Product>> {
  const rows = await db
    .select({
      id: product.id,
      title: product.title,
      metadata: product.metadata,
      cursorAt: cursorAt(product.createdAt),
    })
    .from(product)
    .where(rowsAfter(page, product.createdAt, product.id))
    // `id` breaks the tie, so two Products created in the same instant still come back in
    // one stable order rather than in whichever order Postgres happened to read them — and
    // so that the cursor above names one row rather than a group of them.
    .orderBy(desc(product.createdAt), desc(product.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about — the same reason a Payment is rebuilt rather than
  // spread. A Product reports three fields, and these are them.
  return {
    items: found.map((row) => ({ id: row.id, title: row.title, metadata: row.metadata })),
    nextCursor,
  };
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
 *
 * **`Queryable`, so a write can read its own work back inside its transaction** — which is how
 * `catalog/update.ts` answers with the Variant it just corrected rather than with whatever the
 * next request left. It takes no lock of its own either way: these are plain reads, and a plain
 * read in Postgres blocks on nothing.
 */
export async function readVariants(db: Queryable, productId: string): Promise<Variant[]> {
  const variants = await db
    .select({
      id: variant.id,
      sku: variant.sku,
      fulfilmentStrategy: variant.fulfilmentStrategy,
      metadata: variant.metadata,
    })
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

  return variants.map(({ fulfilmentStrategy, ...row }) => ({
    ...row,
    fulfilment: { strategy: fulfilmentStrategy },
    prices: byVariant.get(row.id) ?? [],
    inventory: stock.get(row.id) ?? null,
  }));
}
