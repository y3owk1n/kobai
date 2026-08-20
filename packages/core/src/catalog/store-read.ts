import { and, asc, desc, eq } from "drizzle-orm";
import type { Database, Queryable } from "../db/client.ts";
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
import type { Media } from "../media/media.ts";
import type { MediaStorage } from "../media/storage.ts";
import { type Collection, inCollection, readProductCollections } from "./collection.ts";
import { readProductMedia, readVariantMedia } from "./media.ts";
import { readProductOptions, readVariantOptionValues } from "./options.ts";
import { PUBLISHED } from "./status.ts";

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
 * - **The options and their values, kept, and they are the reason this ticket exists.** A
 *   storefront cannot draw a Size picker out of a list of SKUs, so a Product publishes the
 *   options it is chosen by in the order a Merchant put them in, and each Variant publishes its
 *   value for each — which is together everything needed to map a chosen combination to a SKU
 *   **client-side**. The combination no Variant answers is simply absent from that mapping,
 *   which is story 21's "unavailable rather than an error" falling out of the shape rather than
 *   being a rule anybody enforces. What is dropped is the option's **identifier**: a storefront
 *   addresses nothing by it, the name is unique within the Product and is what a Variant's
 *   values are keyed by, and it is `PATCH /admin/products/{id}` that needs one.
 * - **The Media, kept — and it is a shape of its own rather than the admin one.** A product page
 *   with no picture is not a product page (story 19), and the leading image is what a catalog
 *   grid is made of, so both shapes carry the list in the Merchant's own order and a Variant
 *   carries its own beside it. What is dropped is everything on a Media that is about the
 *   *file* rather than about the picture: `filename` is the name it had on the Merchant's own
 *   machine, and `contentType` and `byteSize` are facts the thing fetching the bytes is told by
 *   the response that carries them — publishing any of the three would be promising a browser
 *   something about an object a CDN in front is free to change (ADR-0060 makes taking one back
 *   out a major). What is left is what a page lays out with: the address, the alt text, and the
 *   dimensions that let it reserve the space before the image arrives.
 * - **The Collections, kept — and that is the field #256 added here.** A storefront browsing a
 *   Collection has to be able to say what it is browsing and offer the way back out, and a
 *   Product page has to draw its breadcrumbs; both are questions about *this* Product, so the
 *   answer travels with it rather than costing a second request. It is a shape of its own for
 *   `StoreMedia`'s reason, and it drops nothing today — a Collection's whole record is its title
 *   and its `metadata`, and the second is ADR-0004's escape hatch doing on a Collection what it
 *   already does on a Product: it is where a Project's own copy for one lives until the content
 *   Plugin has a page (#216). What is deliberately **not** here is a route: nothing on the store
 *   surface enumerates Collections, so a storefront's navigation is built from what the Products
 *   it read are in. Adding one is additive under ADR-0060 the day something needs it.
 * - **`status`, dropped — and not merely dropped: never carried.** It is a Merchant's field, and
 *   it is the one this whole split was argued about. A `status` on these shapes would tell every
 *   browser holding a publishable key which Products a Merchant has not finished writing and
 *   which have been taken off sale, and under ADR-0060 taking a field back out is a major. What
 *   the storefront gets instead is that **the reads below answer `published` and nothing else**,
 *   which is the same fact from the useful end: there is nothing to filter and nothing to forget
 *   to filter.
 *
 * **That filtering is in the route rather than a parameter, deliberately.** `?status=` on
 * `/store/products` would be a client able to ask for drafts, and a client that can is one that
 * will — so a storefront would be publishing what a Merchant had not, by a query string.
 * **`?collection=` is the filter this list *does* take, and it is no way round that** (#256):
 * it narrows to the Products in one Collection and sits beside `IS_PUBLISHED` in the same `and`,
 * so a draft in a Collection is answered by neither the filtered list nor the whole one.
 * `GET /store/products/{idOrHandle}` answers a draft or an archived Product with the same
 * `product-not-found` an unknown handle gets, so a draft is **invisible** rather than forbidden:
 * a 403 there would tell an anonymous browser that a handle is taken, which is the leak the
 * shared refusal is avoiding.
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

/**
 * One image, as a storefront sees it — where it is, what it shows, and how big it is.
 *
 * Declared apart from {@link Media} for {@link StoreVariantFulfilment}'s reason, and here the
 * split does real work rather than merely holding the line: three of that shape's eight fields
 * are about the **file** — its name on a Merchant's machine, its content type, its weight — and
 * none of them is something a page renders. The `url` is still the deployment's `MediaStorage`'s
 * own answer, asked at read time (ADR-0078), so it is absolute for a Store on a CDN and
 * root-relative for the storage kobai ships, and a storefront renders both.
 */
export type StoreMedia = {
  readonly id: string;
  readonly url: string;
  readonly alt: string | null;
  readonly width: number | null;
  readonly height: number | null;
};

/**
 * One Collection a Product is in, as a storefront sees it.
 *
 * The same three fields {@link Collection} carries, and deliberately a type of its own for
 * {@link StoreVariantFulfilment}'s reason: two shapes that happen to agree is the cheap half of
 * #207's split, and one shape two surfaces share is the expensive half, arriving later and as a
 * major. The `id` is published because it is what `?collection=` takes — a storefront listing a
 * Collection sends back the identifier the Product it was looking at reported.
 */
export type StoreCollection = {
  readonly id: string;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
};

/** One option a Product is chosen by, as a storefront sees it: the name, and no identifier. */
export type StoreProductOption = {
  readonly name: string;
};

/** A Variant's value for one option — `Size` is `M` — named as its Product names it. */
export type StoreVariantOptionValue = {
  readonly name: string;
  readonly value: string;
};

/** A Variant as a storefront sees it: no count, and no Prices. */
export type StoreVariant = {
  readonly id: string;
  readonly sku: string;
  readonly fulfilment: StoreVariantFulfilment;
  /** What this Variant is, in its Product's option order — the storefront's half of the pair. */
  readonly options: readonly StoreVariantOptionValue[];
  /**
   * The images of **this** Variant, in the Merchant's order — empty unless somebody attached
   * one, which is the ordinary Variant.
   *
   * It does not fall back to the Product's, deliberately: a storefront with both lists in front
   * of it decides whether picking Red replaces the gallery or adds to it, and a kobai that
   * copied one into the other would have taken that decision on its behalf and left it with no
   * way to tell an inherited picture from an attached one.
   */
  readonly media: readonly StoreMedia[];
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
  /**
   * The images this Product shows, in the Merchant's own order — the first one leads (story 9).
   *
   * On the list shape as well as on the detail, unlike the options: a catalog grid is nothing
   * but leading images, and a storefront that had to open every Product to draw one would be
   * making a request per tile.
   */
  readonly media: readonly StoreMedia[];
  /**
   * The Collections this Product is in, by title — **so a storefront renders breadcrumbs without
   * a second request** (#256, story 18).
   *
   * On the list shape as well as on the detail, because a catalog grid is where a storefront
   * decides what to link each tile to and one that had to open every Product to find out would
   * be making a request per tile — the same argument `media` makes one field up. Empty for a
   * Product nobody has grouped.
   */
  readonly collections: readonly StoreCollection[];
  readonly metadata: Record<string, unknown>;
};

/** A Product opened — its Variants, so a product page is one request rather than N. */
export type StoreProductDetail = StoreProduct & {
  /** The options a Shopper chooses by, in the order the Merchant put them in. */
  readonly options: readonly StoreProductOption[];
  readonly variants: readonly StoreVariant[];
};

/**
 * What the store's Product list was asked for: a page, and the one thing it may be narrowed by.
 *
 * **`collection` and deliberately nothing else** — a storefront browses a Collection (story 18)
 * and has no business asking for a status, which is the one rule this route enforces rather than
 * offers. `contract.StoreProductPageQuery` produces this shape.
 */
export type StoreProductPageRequest = PageRequest & { readonly collection?: string };

/**
 * A page of Products, newest first and paged exactly as every other list is (ADR-0064).
 *
 * The same ordering and the same `(created_at, id)` index as the Merchant's list, because the
 * failure a cursor prevents is the same one on both: a Product created between one page and the
 * next must neither hide a row nor repeat one. What differs is the shape each answers with, and
 * the cursor's own name — see {@link PagedList}.
 *
 * **`collection` narrows it and `published` is not negotiable**: the two sit in one `and`, so
 * this route answers the published Products of one Collection and there is no spelling of the
 * parameter that reaches a draft.
 */
export async function listStoreProducts(
  db: Database,
  storage: MediaStorage,
  page: StoreProductPageRequest,
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
    .where(
      and(
        rowsAfter(page, product.createdAt, product.id),
        IS_PUBLISHED,
        // `undefined` where nothing was asked, which `and` drops: absent means unfiltered.
        page.collection === undefined ? undefined : inCollection(page.collection),
      ),
    )
    // `id` breaks the tie, so two Products created in the same instant come back in one stable
    // order and the cursor above names one row rather than a group of them.
    .orderBy(desc(product.createdAt), desc(product.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // One query for the whole page rather than one per Product, which is what makes a catalog grid
  // one request. A Product nobody has attached an image to is absent from the map.
  const shown = await readProductMedia(
    db,
    storage,
    found.map((row) => row.id),
  );

  // A second, for the same reason: a Product nobody has grouped has no row there at all, and a
  // storefront drawing a grid decides what to link each tile to from this.
  const grouped = await readProductCollections(
    db,
    found.map((row) => row.id),
  );

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about. A Product reports seven fields here and these are them.
  return {
    items: found.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      handle: row.handle,
      media: asStoreMedia(shown.get(row.id)),
      collections: asStoreCollections(grouped.get(row.id)),
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
  storage: MediaStorage,
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
      and(
        isUuid(idOrHandle) ? eq(product.id, idOrHandle) : eq(product.handle, idOrHandle),
        IS_PUBLISHED,
      ),
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

  // The declared options and the answers to them are read through the same two functions the
  // admin reader asks, because *which* rows are a Product's options is not a question the two
  // surfaces may come to different answers about. What differs is the shape each publishes,
  // and that is decided here — the identifier is projected away one line down.
  const options = await readProductOptions(db, row.id);
  const chosenBy = await readVariantOptionValues(
    db,
    variants.map((one) => one.id),
  );

  // The Product's images and the Variants' are two reads and two lists, because they are two
  // facts: what this Product shows, and what picking one of its Variants shows instead.
  const shownOnProduct = await readProductMedia(db, storage, [row.id]);
  const shownOnVariants = await readVariantMedia(
    db,
    storage,
    variants.map((one) => one.id),
  );

  return {
    ...row,
    media: asStoreMedia(shownOnProduct.get(row.id)),
    collections: asStoreCollections(
      (await readProductCollections(db, [row.id])).get(row.id),
    ),
    options: options.map((one) => ({ name: one.name })),
    variants: variants.map((one) =>
      asStoreVariant(one, chosenBy.get(one.id) ?? [], shownOnVariants.get(one.id)),
    ),
  };
}

/**
 * The one status a storefront is answered with, and the one place it is said.
 *
 * **All three reads take it**, because they are the three ways the catalog is reached here and a
 * filter on two of them is a filter a client works around by using the third — which is exactly
 * what #276 found: the Variant read carried no such clause, so a Shopper holding a `variantId`
 * could price a draft, put it in a Cart and buy it while its Product was invisible. It is
 * deliberately a constant rather than an argument: this reader has no caller that may ask for
 * anything else, which is what "enforced in the route" means.
 */
const IS_PUBLISHED = eq(product.status, PUBLISHED);

/**
 * One Variant, or `undefined` when there is no such Variant **a Shopper may see**.
 *
 * A route of its own rather than a field of the Product, because a Cart line carries a
 * `variantId` and nothing else: rebuilding a page from one should not mean fetching the whole
 * Product it happens to belong to.
 *
 * **It joins its Product to ask one question of it, and only that one** (#276). A Variant is the
 * sellable thing and carries no status of its own — whether a Shopper may see it is its
 * Product's answer — so a read that stopped at `core_variant` answered for a Product the two
 * reads above had already refused. The Product's own fields are not selected and are not
 * reported: what a storefront gets back is still a Variant.
 */
export async function readStoreVariant(
  db: Database,
  storage: MediaStorage,
  id: string,
): Promise<StoreVariant | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select(STORE_VARIANT_COLUMNS)
    .from(variant)
    .innerJoin(product, eq(product.id, variant.productId))
    .where(and(eq(variant.id, id), IS_PUBLISHED))
    .limit(1);
  if (!row) return undefined;

  const chosenBy = await readVariantOptionValues(db, [row.id]);
  const shown = await readVariantMedia(db, storage, [row.id]);
  return asStoreVariant(row, chosenBy.get(row.id) ?? [], shown.get(row.id));
}

/**
 * Whether there is a Variant here **a Shopper may select** — the same question
 * {@link readStoreVariant} answers, for the two callers that need the answer and not the
 * Variant (#276).
 *
 * `POST /store/carts/{id}/line-items` asks it before it writes a Line Item, and
 * `GET /store/variants/{id}/price` asks it before it runs `resolve-price`. Both are on the
 * store surface and both would otherwise answer for a Product this module has already decided
 * a Shopper cannot see — which is the whole of #276: *invisible* and *unbuyable* were two
 * different facts, and only the first was enforced.
 *
 * **It is here rather than at either caller, and that is the answer to where the guard goes.**
 * {@link IS_PUBLISHED} is the one statement of what a Shopper may see; a second `eq(product.status, …)`
 * written in `cart/write.ts` would be a second statement of it, and the two would drift the day
 * a fourth status arrives. So the Cart still selects the Variant and never the Product — what it
 * now asks is whether *the store surface has such a Variant at all*, and that is the catalog's
 * question rather than the Cart's.
 */
export async function storeVariantExists(db: Queryable, id: string): Promise<boolean> {
  // Checked before Postgres sees it, exactly as the readers above do: a malformed uuid raises,
  // and an unhandled raise is a 500 about something that does not exist.
  if (!isUuid(id)) return false;

  const [row] = await db
    .select({ id: variant.id })
    .from(variant)
    .innerJoin(product, eq(product.id, variant.productId))
    .where(and(eq(variant.id, id), IS_PUBLISHED))
    .limit(1);

  return row !== undefined;
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
function asStoreVariant(
  row: {
    readonly id: string;
    readonly sku: string;
    readonly fulfilmentStrategy: string;
    readonly metadata: Record<string, unknown>;
  },
  options: readonly StoreVariantOptionValue[],
  media: readonly Media[] | undefined,
): StoreVariant {
  return {
    id: row.id,
    sku: row.sku,
    fulfilment: { strategy: row.fulfilmentStrategy },
    options,
    media: asStoreMedia(media),
    metadata: row.metadata,
  };
}

/**
 * The Media the admin surface reports, narrowed to what a storefront is published — and the one
 * place that narrowing happens.
 *
 * Field by field rather than by omission, so a field added to {@link Media} for a Merchant
 * reaches the store surface only by somebody editing this function. That is #207's split
 * expressed as code rather than as a rule: the alternative is a spread with three `delete`s
 * beside it, where the *next* field is published by the deploy that adds it.
 *
 * `undefined` is the map having no entry, which is a subject nobody attached anything to.
 */
function asStoreMedia(media: readonly Media[] | undefined): StoreMedia[] {
  return (media ?? []).map((one) => ({
    id: one.id,
    url: one.url,
    alt: one.alt,
    width: one.width,
    height: one.height,
  }));
}

/**
 * The Collections the admin surface reports, narrowed to what a storefront is published — and
 * the one place that narrowing happens.
 *
 * Field by field rather than by spread, for {@link asStoreMedia}'s reason: it drops nothing
 * today, and the *next* field added to a Collection for a Merchant reaches a browser only by
 * somebody editing this function. A three-field record whose fields all happen to be published
 * is exactly where a spread would look harmless.
 *
 * `undefined` is the map having no entry, which is a Product nobody has grouped.
 */
function asStoreCollections(
  collections: readonly Collection[] | undefined,
): StoreCollection[] {
  return (collections ?? []).map((one) => ({
    id: one.id,
    title: one.title,
    metadata: one.metadata,
  }));
}
