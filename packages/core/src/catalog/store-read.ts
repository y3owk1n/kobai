import { asc, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";

/**
 * Reading the catalog **as a storefront sees it**, which is deliberately not how a Merchant
 * does.
 *
 * `catalog/read.ts` is the admin surface's reader and this is the store surface's, and the two
 * are separate modules rather than one with a flag because the difference between them is the
 * whole point: a field added for a Merchant must not be published to every browser holding a
 * publishable key on the next deploy — and under ADR-0060 taking one back out again is a major.
 * A shared shape makes that leak the default and a review the only thing standing against it;
 * two shapes make it an edit somebody had to make here, on purpose.
 *
 * What a Shopper is shown, and what they are not:
 *
 * - **`handle`, kept**, and it is the field this reader exists to publish: it is the address a
 *   storefront's own URL is built out of, so a Product that could not report it would leave a
 *   storefront with nothing but the UUID this column was added to replace.
 * - **`description`, kept**, and it was the first field this reader gained after the split. It is
 *   copy a Merchant writes *for a Shopper to read*, so a storefront that could not read it would
 *   be missing the thing it was written for — which is what makes publishing it a decision taken
 *   here rather than a field inherited by accident.
 * - **`metadata`, kept**, on both a Product and a Variant. Until the rest of catalog breadth
 *   lands, ADR-0004's escape hatch is a Project's only way to attach imagery and the rest of the
 *   copy, and a product page with nothing but a title is not a product page.
 * - **`inventory`, dropped.** The admin `Variant` carries a count. Publishing exact stock levels
 *   to any key a browser holds is a business-information leak, and ADR-0018 makes availability a
 *   conditional write rather than a readable fact anyway — an `available` a storefront rendered
 *   would be stale by the time it was painted.
 * - **`prices`, dropped.** The admin `Variant` carries every Price row, and a storefront reading
 *   them would pick one itself and so bypass `resolve-price` — the Workflow that decides, and one
 *   a Project may have replaced (ADR-0017). `GET /store/variants/{id}/price` is the question.
 * - **`fulfilment.strategy`, kept.** It is already published to a Merchant, it is what tells a
 *   storefront a download is a download, and ADR-0014 makes the set open rather than secret.
 *
 * There is no Store parameter and no scoping key, for the same reason `readStore` has none: one
 * deployment is one Store (ADR-0005).
 */

/**
 * Every way one of these reads is refused, as the store catalog module's own set.
 *
 * Two words, and they are **not** the admin catalog module's two of the same spelling: each
 * module owns its own vocabulary (ADR-0060), so the enum a storefront branches on is the one
 * these routes can actually answer rather than a nine-member set inherited from the routes a
 * Merchant calls. `contract.ts` binds this union to that enum with a mapped `satisfies`, which
 * is what makes a rename here a build failure there rather than a description that quietly says
 * something else.
 */
export type StoreCatalogRefusal = "product-not-found" | "variant-not-found";

/** How this Variant is delivered — the Strategy it points at, by name (ADR-0014). */
export type StoreVariantFulfilment = {
  /** `physical`, `digital`, or whatever key this deployment wired a Plugin's Strategy under. */
  readonly strategy: string;
};

/** A Variant as a storefront sees it: no count, and no Prices. */
export type StoreVariant = {
  readonly id: string;
  readonly sku: string;
  readonly fulfilment: StoreVariantFulfilment;
  readonly metadata: Record<string, unknown>;
};

/** A Product as a list reports it: no Variants, because a list is not a detail view. */
export type StoreProduct = {
  readonly id: string;
  readonly title: string;
  /** What a Merchant wrote about it, or `null` where nobody has written anything. */
  readonly description: string | null;
  /** The address it is known by — what `/products/blue-poster` is built out of. */
  readonly handle: string;
  readonly metadata: Record<string, unknown>;
};

/** A Product opened — its Variants, so a product page is one request rather than N. */
export type StoreProductDetail = StoreProduct & {
  readonly variants: readonly StoreVariant[];
};

/**
 * A page of Products, newest first and paged exactly as every other list is (ADR-0064).
 *
 * The same ordering and the same `(created_at, id)` index as the Merchant's list, because the
 * failure a cursor prevents is the same one on both: a Product created between one page and the
 * next must neither hide a row nor repeat one. What differs is the shape each answers with, and
 * the cursor's own name — see {@link PagedList}.
 */
export async function listStoreProducts(
  db: Database,
  page: PageRequest,
): Promise<Page<StoreProduct>> {
  const rows = await db
    .select({
      id: product.id,
      title: product.title,
      description: product.description,
      handle: product.handle,
      metadata: product.metadata,
      cursorAt: cursorAt(product.createdAt),
    })
    .from(product)
    .where(rowsAfter(page, product.createdAt, product.id))
    // `id` breaks the tie, so two Products created in the same instant come back in one stable
    // order and the cursor above names one row rather than a group of them.
    .orderBy(desc(product.createdAt), desc(product.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about. A Product reports five fields here and these are them.
  return {
    items: found.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      handle: row.handle,
      metadata: row.metadata,
    })),
    nextCursor,
  };
}

/**
 * One Product with its Variants, addressed **by its id or by its handle**, or `undefined` when
 * neither names one.
 *
 * **A UUID is read as an id and anything else as a handle**, which is the whole resolution rule
 * and the reason `catalog/handle.ts` refuses a handle that parses as a UUID at creation: a
 * Product whose address were one would be looked up by the wrong column and could never be
 * reached by it. Nothing here has to fall back from one to the other — the two spaces do not
 * overlap, so a miss is a miss, and a second query would only make the same absence cost twice.
 *
 * It is one function rather than two for the reason `STORE_VARIANT_COLUMNS` is one constant:
 * what a Product looks like to a storefront must not depend on which way it was asked for, and
 * two readers is exactly how that comes apart.
 *
 * The admin reader beside this one deliberately stays id-only. A handle is an address for the
 * storefront that publishes it; a Merchant's screen holds an identifier that never changes,
 * which is the one thing a correctable handle is not.
 */
export async function readStoreProduct(
  db: Database,
  idOrHandle: string,
): Promise<StoreProductDetail | undefined> {
  const [row] = await db
    .select({
      id: product.id,
      title: product.title,
      description: product.description,
      handle: product.handle,
      metadata: product.metadata,
    })
    .from(product)
    .where(
      isUuid(idOrHandle) ? eq(product.id, idOrHandle) : eq(product.handle, idOrHandle),
    )
    .limit(1);
  if (!row) return undefined;

  const variants = await db
    .select(STORE_VARIANT_COLUMNS)
    .from(variant)
    .where(eq(variant.productId, row.id))
    // By SKU, as the admin surface reports them: it is unique, so the order is total and
    // stable, where `created_at` ties for Variants created together — and they always are.
    .orderBy(asc(variant.sku));

  return { ...row, variants: variants.map(asStoreVariant) };
}

/**
 * One Variant, or `undefined` when there is no such Variant.
 *
 * A route of its own rather than a field of the Product, because a Cart line carries a
 * `variantId` and nothing else: rebuilding a page from one should not mean fetching the whole
 * Product it happens to belong to.
 */
export async function readStoreVariant(
  db: Database,
  id: string,
): Promise<StoreVariant | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select(STORE_VARIANT_COLUMNS)
    .from(variant)
    .where(eq(variant.id, id))
    .limit(1);

  return row && asStoreVariant(row);
}

/**
 * The columns a Variant is read from, and the one place they are named.
 *
 * Both readers above select this rather than each writing the list out, because the projection
 * is the half that can actually drift: two copies that fell out of step would answer two shapes
 * from one surface, and only whichever route a test happened to assert on would say so. What
 * turns these columns into a response is {@link asStoreVariant}, and there is one of that too.
 */
const STORE_VARIANT_COLUMNS = {
  id: variant.id,
  sku: variant.sku,
  fulfilmentStrategy: variant.fulfilmentStrategy,
  metadata: variant.metadata,
} as const;

/**
 * One Variant row as the store surface reports it — the one place a column name becomes a
 * response field, so both readers above answer in the same shape by construction.
 */
function asStoreVariant(row: {
  readonly id: string;
  readonly sku: string;
  readonly fulfilmentStrategy: string;
  readonly metadata: Record<string, unknown>;
}): StoreVariant {
  return {
    id: row.id,
    sku: row.sku,
    fulfilment: { strategy: row.fulfilmentStrategy },
    metadata: row.metadata,
  };
}
