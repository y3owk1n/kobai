import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Database, Queryable } from "../db/client.ts";
import { joined } from "../db/join.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { channel, price, product, region, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import type { Media } from "../media/media.ts";
import type { MediaStorage } from "../media/storage.ts";
import type { VariantIdentity } from "../pricing/resolve-price.ts";
import { readInventoryOf, type VariantInventory } from "../reservation/inventory.ts";
import type { ChannelIdentity } from "../store/channel.ts";
import type { RegionIdentity } from "../store/region.ts";
import { type Collection, inCollection, readProductCollections } from "./collection.ts";
import { readProductMedia, readVariantMedia } from "./media.ts";
import {
  type ProductOption,
  readProductOptions,
  readVariantOptionValues,
  type VariantOptionValue,
} from "./options.ts";
import type { ProductStatus } from "./status.ts";

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
  /**
   * The Region this Price applies to, or `null` for **every** Region (#292, ADR-0008).
   *
   * The Region rather than its identifier, so a list of Prices reads as one (story 9): a client
   * that had to fetch `GET /admin/regions` to render a table of amounts would be making a second
   * request for a name kobai already has in hand — which is the same call `Product.collections`
   * takes one noun along.
   */
  readonly region: RegionIdentity | null;
  /** The Channel this Price applies to, or `null` for **every** Channel. */
  readonly channel: ChannelIdentity | null;
  readonly metadata: Record<string, unknown>;
};

/**
 * One Price as the **Prices list** reports it — the row, and the Variant it prices (#310).
 *
 * Declared apart from {@link Price} rather than adding a field to it (ADR-0060): a field added
 * to `Price` is promised at every route that answers one, and a Price nested under the Variant
 * it belongs to has no use for a copy of that Variant.
 *
 * **The pair of identifiers is the point rather than a courtesy.** `DELETE
 * /admin/variants/{id}/prices/{priceId}` takes both, so a row of this list is a Price a
 * Merchant can act on — which is exactly the test ADR-0059 applies to a refusal, and the reason
 * `core_price`'s cascade had to be re-argued once this list existed.
 */
export type ListedPrice = Price & {
  /** The Variant this Price prices — the identifier that addresses it, and the SKU a Merchant reads. */
  readonly variant: VariantIdentity;
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
  /**
   * What this Variant is, in its Product's own words — `Size` is `M`, `Colour` is `Red` —
   * **in the order its Product declared those options**, so a picker is drawn from the pair.
   *
   * Empty for a Variant of a Product that declares no options, which is the ordinary case
   * rather than the exception. A Variant that leaves one of its Product's options unanswered
   * is refused by every route that writes one; a Product that grew an option after its
   * Variants were written is the one way to arrive at a short list here, and correcting each
   * Variant is what ends it (`catalog/options.ts`).
   */
  readonly options: readonly VariantOptionValue[];
  /**
   * The Media attached to **this Variant**, in the order a Merchant set — so a storefront that
   * has just been told Red can swap the picture for the red one (story 10).
   *
   * Empty for a Variant nobody attached anything to, which is the ordinary Variant: the
   * Product's own images are what a page shows then, and the two lists are separate rather than
   * one inheriting from the other, because a storefront deciding that is a storefront with both
   * of them in front of it.
   */
  readonly media: readonly Media[];
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
  /**
   * What a Merchant wrote about this Product, or `null` where nobody has written anything.
   *
   * `null` rather than `""`, because the two are different facts: a Merchant who has not got
   * to the copy yet and one who deliberately says nothing are told apart by exactly this, and
   * a storefront handed an empty string draws an empty paragraph under every such title.
   */
  readonly description: string | null;
  /**
   * The address this Product is known by — `blue-poster` — unique across the Store.
   *
   * Always there and never empty: it is `NOT NULL` on the column, proposed from the title when
   * a create named none, and there is no way to take one back off. A Merchant reads it here
   * because it is what a storefront's URL will say, and correcting it is
   * `PATCH /admin/products/{id}`.
   */
  readonly handle: string;
  /**
   * Whether a Shopper may see this Product — `draft`, `published` or `archived`.
   *
   * **A Merchant's field, and it is on this shape and on neither store shape**, which is #207's
   * split doing the job it was made for: `/store` is opened by a publishable key, so a `status`
   * published there would tell every browser which Products a Merchant has not finished writing
   * — and under ADR-0060 taking a field back off is a major. The storefront is answered
   * published Products and nothing else instead, in the route.
   */
  readonly status: ProductStatus;
  /**
   * The Media this Product shows, **in the order the Merchant put them in** — so the first one
   * is the one that leads (story 9).
   *
   * On the list shape as well as on the detail, unlike {@link ProductDetail}'s options: a
   * catalog list is the one screen that is nothing but a grid of leading images, and a client
   * that had to open every Product to draw one would be making a request per tile.
   *
   * Attaching, reordering and detaching are one field of `PATCH /admin/products/{id}` —
   * `media`, the whole list in the order it should end up in. Detaching removes the attachment
   * and never the Media (ADR-0082).
   */
  readonly media: readonly Media[];
  /**
   * The Collections this Product is in, **by title** — a set rather than an ordered list, so
   * there is no position to report and nothing a Merchant has to keep in step (story 14).
   *
   * On the list shape as well as on the detail, which is the same answer `StoreProduct` gives
   * one surface along: which Collections a Product ended up in is the thing a Merchant checks
   * *after* grouping one, and a list they had to open every Product from would be a request per
   * row. Empty for a Product nobody has grouped, which is every Product until somebody does.
   *
   * Putting a Product in a Collection and taking it out of one are both `collections` on
   * `PATCH /admin/products/{id}` — the whole list of the Collections it should now be in.
   */
  readonly collections: readonly Collection[];
  readonly metadata: Record<string, unknown>;
};

/** A Product opened — its Variants and their Prices, which is the whole sellable picture. */
export type ProductDetail = Product & {
  /**
   * The options a Shopper chooses this Product by — Size, Colour — **in the order the Merchant
   * put them in**, because Size before Colour is a decision a storefront should not have to
   * invent (story 11).
   *
   * On the detail shape and not on {@link Product}, deliberately: a list is not a detail view,
   * and the options are only useful beside the Variants that answer them.
   */
  readonly options: readonly ProductOption[];
  readonly variants: readonly Variant[];
};

/**
 * What the Product list was asked for: a page, and the two things it may be narrowed by.
 *
 * One argument rather than three, exactly as `CartPageRequest` is one — `contract.ProductPageQuery`
 * produces this shape, so the route hands over what it was given instead of taking the same
 * object apart and passing pieces of it separately.
 *
 * **`collection` is an identifier rather than a word, and it is checked before the page is
 * read.** Whether a Collection exists is a fact about the Store rather than about the schema, so
 * `unknownCollection` is what refuses one this Store has not got and the route asks it — see
 * `catalog/collection.ts`. What arrives here is a Collection, or nothing.
 */
export type ProductPageRequest = PageRequest & {
  readonly status?: ProductStatus;
  readonly collection?: string;
};

/**
 * A page of Products, newest first — a Merchant listing them has just created one and is
 * looking for it.
 *
 * One page rather than all of them (ADR-0064), and located by a cursor rather than an offset:
 * this is the list where an unbounded response hurts first, because a Merchant's catalog grows
 * and nothing about the route said when to stop. `page.after` is the record the caller last
 * saw, so a Product created since changes nothing about what follows it.
 *
 * **`status` and `collection` narrow it, and absent means unfiltered** — the filtering
 * convention, whose second and fourth consumers these are. Both are applied in the same statement
 * as the page, so a filtered page that comes back short is still a page: `nextCursor` is what
 * says whether there is more, which is the clause of ADR-0064 a filter is the first thing to
 * exercise. **The two compose**, because they are two `undefined`-droppable predicates in one
 * `and` rather than two branches — a Merchant looking for the drafts in Summer asks for both and
 * gets what is in neither list alone.
 *
 * A Merchant's list is the one place a draft is visible at all — the store surface answers
 * `published` and nothing else, in the route rather than through a parameter.
 */
export async function listProducts(
  db: Database,
  storage: MediaStorage,
  page: ProductPageRequest,
): Promise<Page<Product>> {
  const rows = await db
    .select({
      id: product.id,
      title: product.title,
      description: product.description,
      handle: product.handle,
      status: product.status,
      metadata: product.metadata,
      cursorAt: cursorAt(product.createdAt),
    })
    .from(product)
    .where(
      and(
        rowsAfter(page, product.createdAt, product.id),
        // `undefined` where nothing was asked, which `and` drops: absent means unfiltered, and
        // that is the convention rather than this list's own choice.
        page.status === undefined ? undefined : eq(product.status, page.status),
        // The second of them, and the reason the two are spelled the same way: they compose in
        // one `and` rather than branching, so asking for both narrows by both.
        page.collection === undefined ? undefined : inCollection(page.collection),
      ),
    )
    // `id` breaks the tie, so two Products created in the same instant still come back in
    // one stable order rather than in whichever order Postgres happened to read them — and
    // so that the cursor above names one row rather than a group of them.
    .orderBy(desc(product.createdAt), desc(product.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // A second query rather than a join, for the reason `readVariants` takes four: a Product with
  // no Media has no row here at all, and that is every Product until somebody attaches
  // something. One query for the whole page rather than one per Product, which is what makes a
  // catalog list a grid of leading images at the cost of one more statement.
  const shown = await readProductMedia(
    db,
    storage,
    found.map((row) => row.id),
  );

  // A third, and the same reason again: a Product nobody has grouped has no row here at all, and
  // that is every Product until somebody puts it in something.
  const grouped = await readProductCollections(
    db,
    found.map((row) => row.id),
  );

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about — the same reason a Payment is rebuilt rather than
  // spread. A Product reports eight fields, and these are them.
  return {
    items: found.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      handle: row.handle,
      status: row.status,
      media: shown.get(row.id) ?? [],
      collections: grouped.get(row.id) ?? [],
      metadata: row.metadata,
    })),
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
  storage: MediaStorage,
  id: string,
): Promise<ProductDetail | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select({
      id: product.id,
      title: product.title,
      description: product.description,
      handle: product.handle,
      // No filter beside it, and that asymmetry with `catalog/store-read.ts` is the point: a
      // Merchant opens a draft to work on it, which is what drafting is for.
      status: product.status,
      metadata: product.metadata,
    })
    .from(product)
    .where(eq(product.id, id))
    .limit(1);
  if (!row) return undefined;

  return {
    ...row,
    media: (await readProductMedia(db, storage, [row.id])).get(row.id) ?? [],
    collections: (await readProductCollections(db, [row.id])).get(row.id) ?? [],
    options: await readProductOptions(db, row.id),
    variants: await readVariants(db, storage, row.id),
  };
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
export async function readVariants(
  db: Queryable,
  storage: MediaStorage,
  productId: string,
): Promise<Variant[]> {
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
      // Both `left`, because an unconstrained Price is the ordinary Price and an inner join
      // would drop every one of them — which is the same trap `readStore` reads its default
      // Region through, one table along.
      region: { id: region.id, name: region.name, currency: region.currency },
      channel: { id: channel.id, name: channel.name },
    })
    .from(price)
    .leftJoin(region, eq(region.id, price.regionId))
    .leftJoin(channel, eq(channel.id, price.channelId))
    .where(
      inArray(
        price.variantId,
        variants.map((row) => row.id),
      ),
    )
    .orderBy(asc(price.createdAt), asc(price.id));

  const byVariant = new Map<string, Price[]>();
  for (const row of prices) {
    const { variantId, region: appliesIn, channel: appliesThrough, ...reported } = row;
    // `db/join.ts` is the reading of a left join, and why it is not `appliesIn ?? null`.
    const applies = {
      ...reported,
      region: joined<RegionIdentity>(appliesIn),
      channel: joined<ChannelIdentity>(appliesThrough),
    };
    const existing = byVariant.get(variantId);
    if (existing) existing.push(applies);
    else byVariant.set(variantId, [applies]);
  }

  // A third query rather than a join, for the reason the second one is: a Variant that nobody
  // counts has no row, and it must survive being read about.
  const stock = await readInventoryOf(
    db,
    variants.map((row) => row.id),
  );

  // A fourth, and the same reason a third time: a Variant of a Product that declares no options
  // has no row here at all, and that is the ordinary Product rather than the exception.
  const chosenBy = await readVariantOptionValues(
    db,
    variants.map((row) => row.id),
  );

  // A fifth, and the same reason again: a Variant nobody attached an image to has no row here,
  // and that is the ordinary Variant — its Product's images are what a page shows for it.
  const shown = await readVariantMedia(
    db,
    storage,
    variants.map((row) => row.id),
  );

  return variants.map(({ fulfilmentStrategy, ...row }) => ({
    ...row,
    fulfilment: { strategy: fulfilmentStrategy },
    options: chosenBy.get(row.id) ?? [],
    media: shown.get(row.id) ?? [],
    prices: byVariant.get(row.id) ?? [],
    inventory: stock.get(row.id) ?? null,
  }));
}

/**
 * What the Prices list was asked for: a page, and the two constraints it may be narrowed by.
 *
 * One argument rather than three, exactly as {@link ProductPageRequest} is one —
 * `contract.PricePageQuery` produces this shape, so the route hands over what it was given.
 *
 * **Both are identifiers and both are checked before the page is read.** Whether a Region or a
 * Channel exists is a fact about the Store rather than about the schema, so `unusableRegion` and
 * `unusableChannel` are what refuse one this Store has not got and the route asks them. What
 * arrives here is a Region, a Channel, or nothing.
 */
export type PricePageRequest = PageRequest & {
  readonly region?: string;
  readonly channel?: string;
};

/**
 * A page of Prices, newest first — every Price this Store holds, whichever Variant carries it
 * (#310).
 *
 * **The question this answers is *which Prices name this Region*, and deliberately not *which
 * Prices would apply there*.** The second is `resolve-price`'s answer — the currency rule, then
 * best match, in a Workflow a Project may have replaced (ADR-0017) — and a `where` clause
 * claiming to give it would be a second implementation of pricing in the one place a
 * replacement cannot reach, which is the same argument that keeps `load-prices` unfiltered.
 * So a Price carrying no Region applies in every Region and is answered by the **unfiltered**
 * list rather than by every value of the parameter.
 *
 * **Each row names the Variant it prices**, which is what makes this a list a Merchant can act
 * on rather than a page of amounts: `DELETE /admin/variants/{id}/prices/{priceId}` takes both
 * identifiers, and until this list there was nowhere to read the pair but the Product the Price
 * hangs under (ADR-0059, and the argument at `core_price.region_id`).
 *
 * **The two filters compose**, because they are two `undefined`-droppable predicates in one
 * `and` rather than two branches — a Merchant asking what a marketplace charges in Malaysia is
 * answered by neither narrowing alone.
 */
export async function listPrices(
  db: Database,
  page: PricePageRequest,
): Promise<Page<ListedPrice>> {
  const rows = await db
    .select({
      id: price.id,
      amount: price.amount,
      currency: price.currency,
      metadata: price.metadata,
      // `inner`, because a Price without a Variant is a row the schema cannot hold — where the
      // two below are `left` for the opposite reason: an unconstrained Price is the ordinary
      // Price, and an inner join would drop every one of them.
      variant: { id: variant.id, sku: variant.sku },
      region: { id: region.id, name: region.name, currency: region.currency },
      channel: { id: channel.id, name: channel.name },
      cursorAt: cursorAt(price.createdAt),
    })
    .from(price)
    .innerJoin(variant, eq(variant.id, price.variantId))
    .leftJoin(region, eq(region.id, price.regionId))
    .leftJoin(channel, eq(channel.id, price.channelId))
    .where(
      and(
        rowsAfter(page, price.createdAt, price.id),
        // `undefined` where nothing was asked, which `and` drops: absent means unfiltered, and
        // that is the convention rather than this list's own choice.
        page.region === undefined ? undefined : eq(price.regionId, page.region),
        page.channel === undefined ? undefined : eq(price.channelId, page.channel),
      ),
    )
    // `id` breaks the tie, so two Prices written in the same instant — which is what a form
    // superseding one does — come back in one stable order rather than in whichever order
    // Postgres happened to read them.
    .orderBy(desc(price.createdAt), desc(price.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about.
  return {
    items: found.map((row) => ({
      id: row.id,
      amount: row.amount,
      currency: row.currency,
      // `db/join.ts` is the reading of a left join, and why it is not `row.region ?? null`.
      region: joined<RegionIdentity>(row.region),
      channel: joined<ChannelIdentity>(row.channel),
      metadata: row.metadata,
      variant: { id: row.variant.id, sku: row.variant.sku },
    })),
    nextCursor,
  };
}
