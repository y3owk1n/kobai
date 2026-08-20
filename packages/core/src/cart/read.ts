import { and, asc, desc, eq, getTableName, not, type SQL, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import type { Address } from "../address/address.ts";
import type { Queryable } from "../db/client.ts";
import { joined } from "../db/join.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { address, cart, cartLineItem, order, region, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import type { RegionIdentity } from "../store/region.ts";

/**
 * Reading a Cart.
 *
 * One shape, and every route on the Cart answers with it: creating one, adding a line,
 * changing a quantity and removing a line all hand back the whole Cart, so a storefront
 * renders after any of them without a second round trip.
 *
 * **A Cart carries no totals and no prices.** ADR-0009 makes it unauthoritative — what a
 * Shopper pays is resolved at Capture, by the `place-order` Workflow, through the same
 * `resolve-price` a storefront reads a price with. A total on this shape would be a figure
 * nothing stands behind, and the first thing anybody would mistake for one.
 *
 * **There is a route that answers what a Cart comes to, and it is not this** (ADR-0077).
 * `POST /store/carts/{id}/quote` runs the pricing half of this deployment's own `place-order`
 * and says when it did — a question asked and answered at an instant, rather than a field on a
 * mutable object. The rule above is unchanged and is what decides where that figure lives.
 */

/**
 * Whether this Cart has passed its deadline, **as Postgres judges it**.
 *
 * One expression, exported, because there are now three places that ask — reading a Cart,
 * changing one, and placing one — and a second spelling of it is a second answer to the
 * question of whether a Cart is still alive. Judged in SQL rather than against `Date.now()` so
 * that one clock both sets the deadline and decides it has passed.
 *
 * The table is named as well as the column, through {@link qualified}, because Drizzle renders
 * a column inside a select-list `sql` template **unqualified** — `"expires_at"` — which resolves
 * against whatever Postgres finds first the moment the query joins anything. That is not
 * hypothetical: the first version of the Variant lookup in `write.ts` was written that way and
 * silently compared `core_price.variant_id` to `core_price.id`.
 */
export const cartHasExpired = sql<boolean>`now() > ${qualified(cart.expiresAt)}`;

/**
 * Whether this Cart has already become an Order — and is therefore **spent** (#102).
 *
 * Asked of the Order rather than recorded on the Cart, because the Order *is* the record that
 * this Cart was placed: a column here would be a second copy of that fact, and a second copy is
 * something that can disagree. The unique index on `core_order.cart_id` is what makes the
 * question cheap and what makes the answer atomic — the check and the claim are the same
 * operation, so no pair of simultaneous requests can both find no Order and both write one.
 *
 * Correlated on the Cart of whatever query this is used in, and every one of those selects from
 * `core_cart`. Both sides are table-qualified for the reason {@link cartHasExpired} spells out:
 * an unqualified `id` inside this subquery would bind to `core_order`'s own.
 */
export const cartHasBeenPlaced = sql<boolean>`exists (select 1 from ${order} where ${qualified(order.cartId)} = ${qualified(cart.id)})`;

/**
 * A column, named with its table, in the one spelling that reads the same in every clause.
 *
 * **Drizzle qualifies a `Column` chunk differently depending on where the template lands**: it
 * renders `"expires_at"` in a select list and `"core_cart"."expires_at"` everywhere else. So
 * `${cart}.${cart.expiresAt}`, which is right in a select list, becomes
 * `"core_cart"."core_cart"."expires_at"` the moment the same expression is used in a `where` —
 * a syntax error, and a 500 rather than a wrong answer, which is how it was found (#227). The
 * two expressions above are now read in both places, because `GET /admin/carts` filters by
 * exactly what it reports, so they name their columns as identifiers instead: an identifier
 * renders as itself wherever it lands. Through the Drizzle column rather than as a literal
 * string, so a rename in `schema.ts` still reaches this.
 */
function qualified(column: PgColumn): SQL {
  return sql`${sql.identifier(getTableName(column.table))}.${sql.identifier(column.name)}`;
}

/**
 * The Region an Address falls in, under a name of its own.
 *
 * A Cart already joins `core_region` for the Region it is *bought* in, and these are two
 * different facts about one Cart — where it is being bought, and where it is going. Without the
 * alias the second join is the same table twice under one name, which Postgres refuses.
 */
const addressRegion = alias(region, "core_cart_address_region");

/** The Address columns both readers select. Two levels rather than one nested object, because
 * the Region comes from a second join and so cannot sit inside the first. */
const addressColumns = {
  address: {
    id: address.id,
    country: address.country,
    lines: address.lines,
    postalCode: address.postalCode,
  },
  addressRegion: {
    id: addressRegion.id,
    name: addressRegion.name,
    currency: addressRegion.currency,
  },
} as const;

/**
 * The Address a Cart carries, or `null` where it carries none.
 *
 * `joined` on both halves rather than `?? null`, for the reason that helper exists: Drizzle
 * answers an unjoined nested selection as an object of `null`s, which is truthy.
 */
function addressOf(row: {
  readonly address: {
    readonly id: string;
    readonly country: string;
    readonly lines: readonly string[];
    readonly postalCode: string | null;
  } | null;
  readonly addressRegion: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
  } | null;
}): Address | null {
  const found = joined(row.address);
  if (!found) return null;

  return {
    country: found.country,
    lines: found.lines,
    postalCode: found.postalCode,
    region: joined<RegionIdentity>(row.addressRegion),
  };
}

/** One line of a Cart: a Variant, and how many of it. */
export type CartLineItem = {
  readonly id: string;
  /**
   * The Variant this line selects — **live**, not a snapshot. That is the asymmetry ADR-0009
   * asks for: an Order's Line Items snapshot title, SKU and price as at capture, and a Cart's
   * are the opposite kind of row.
   */
  readonly variant: { readonly id: string; readonly sku: string };
  readonly quantity: number;
  readonly metadata: Record<string, unknown>;
};

/**
 * The Shopper a storefront has asserted this Cart belongs to, or `null` for a guest.
 *
 * Keyed by email with an optional external identity, exactly as ADR-0020 puts it: Core stores
 * a *reference* and no credential, and trusts the identity a storefront asserts over a secret
 * key. A guest is the ordinary path, and Core assumes an authenticated Shopper nowhere.
 */
export type CartShopper = {
  readonly email: string;
  readonly externalId: string | null;
};

/**
 * A Cart as a **list** reports it — everything but its lines.
 *
 * The split {@link Cart} makes with this is the one an Order and its summary already make: a
 * list is not a detail view, and a Merchant scanning what is being held is looking for whose it
 * is, what has become of it and when it lapses rather than for every line of every Cart at
 * once.
 */
export type CartSummary = {
  /**
   * The identifier, and the whole of the authority to act on this Cart.
   *
   * There is no Shopper session to hang one off (ADR-0020), so holding this value is what
   * lets a storefront read and change the Cart. It is 122 bits from the platform CSPRNG, so
   * it encodes nothing and orders by nothing, and it cannot be guessed from another.
   *
   * **A Merchant may enumerate these and the public may not** (ADR-0071). `GET /admin/carts`
   * is behind a Merchant session and `cart:read`; nothing on the store surface lists anything.
   */
  readonly id: string;
  readonly shopper: CartShopper | null;
  /**
   * The one currency this Cart is denominated in, and what every line of it is priced in
   * (#293, ADR-0074).
   *
   * **Stamped when the Region was set rather than read through it**, which is why it is a field
   * of its own beside {@link CartSummary.region} rather than something a reader derives: a
   * Merchant may move a Region onto another currency, and a Cart that read its currency through
   * one would be repriced by that under a Shopper who is already paying. So the two can differ,
   * and where they do it is this that decides what the Cart costs.
   */
  readonly currency: string;
  /**
   * Where this Cart is being bought — the Region its lines are priced in, or `null` for a Cart
   * started before kobai recorded one.
   *
   * `null` is priced for the Store's default Region, which is exactly what every Cart was
   * priced for before this column existed. It is `RegionIdentity` rather than the whole
   * `Region` for `market.ts`'s reason: `metadata` is the Merchant's and the Project's, and a
   * bag travelling to a storefront on every Cart read is a field nobody asked for.
   */
  readonly region: RegionIdentity | null;
  /**
   * Where what is in this Cart is to be delivered, or `null` for a Cart nobody has said (#319,
   * ADR-0072).
   *
   * **Live, not a snapshot** — the same asymmetry {@link CartLineItem.variant} carries. An Order
   * holds a copy taken at Capture, so correcting this one afterwards changes nothing about where
   * a past parcel went (ADR-0009).
   *
   * On the summary as well as on the detail, because it is a fact about the Cart rather than
   * about what is in it — a Merchant looking down a list of Carts for the one a Shopper is
   * asking about is looking at where it goes.
   */
  readonly address: Address | null;
  readonly metadata: Record<string, unknown>;
  readonly expiresAt: string;
  /**
   * Whether this Cart has passed `expiresAt`, as the **server** judges it.
   *
   * A boolean beside the timestamp rather than instead of it, because a storefront comparing
   * `expiresAt` against a browser's clock would be asking the one clock that is routinely
   * wrong. An expired Cart still reads — a storefront can say what happened rather than
   * showing nothing — and refuses every change.
   */
  readonly expired: boolean;
  /**
   * Whether this Cart has already become an Order, and is therefore **spent** (#102).
   *
   * A Cart becomes exactly one Order, so a `true` here is final: it reads for as long as the
   * row lives and refuses every change and every further placement. Distinct from `expired`
   * because the two are different things to tell a Shopper — one Cart ran out of time, and the
   * other has already been bought.
   */
  readonly placed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** A Cart opened: everything a list carries, and what is actually in it. */
export type Cart = CartSummary & {
  /** In the order the lines were first added — a total order, so it never varies. */
  readonly lineItems: readonly CartLineItem[];
};

/**
 * What has become of a Cart, as the one filter `GET /admin/carts` takes (ADR-0071).
 *
 * The three **partition** the table, which is what makes the filter worth having rather than
 * three overlapping questions: a Cart that became an Order is `spent` whatever its deadline
 * says, one that has not and is past its deadline is `expired`, and everything else is `live`.
 * Without it the default list is mostly history, and `live` is the one a Merchant asking *why
 * is that stock unavailable* actually wants (ADR-0070).
 */
export type CartState = "live" | "expired" | "spent";

/**
 * What the Cart list was asked for: a page, and the one state it may be narrowed to.
 *
 * One argument rather than two, because it is one request — `contract.CartPageQuery` produces
 * exactly this, so the route hands over what it was given instead of taking the same object
 * apart and passing half of it twice.
 */
export type CartPageRequest = PageRequest & { readonly state?: CartState };

/**
 * The rows of one {@link CartState}, or nothing to constrain at all when none was asked for.
 *
 * Written from the same two expressions the response reports `expired` and `placed` from, so a
 * Cart cannot be filtered into one bucket and read as being in another — which is precisely
 * what a second spelling of "is this Cart still alive" would eventually do.
 */
function inState(state: CartState | undefined): SQL | undefined {
  switch (state) {
    case "spent":
      return cartHasBeenPlaced;
    case "expired":
      return and(not(cartHasBeenPlaced), cartHasExpired);
    case "live":
      return and(not(cartHasBeenPlaced), not(cartHasExpired));
    default:
      return undefined;
  }
}

/**
 * A page of Carts, newest first — what a Merchant lists (ADR-0071).
 *
 * **Without their lines**, like every other list on this surface: opening one is what answers
 * what is in it. The filter is applied in the same statement as the page, so a filtered page
 * that comes back short is still a page — `nextCursor` is what says whether there is more, and
 * this is the first list where that distinction does any work.
 */
export async function listCarts(
  db: Queryable,
  page: CartPageRequest,
): Promise<Page<CartSummary>> {
  const fetched = await db
    .select({
      id: cart.id,
      shopperEmail: cart.shopperEmail,
      shopperExternalId: cart.shopperExternalId,
      currency: cart.currency,
      region: { id: region.id, name: region.name, currency: region.currency },
      ...addressColumns,
      metadata: cart.metadata,
      expiresAt: cart.expiresAt,
      expired: cartHasExpired,
      placed: cartHasBeenPlaced,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
      cursorAt: cursorAt(cart.createdAt),
    })
    .from(cart)
    // `left`, because a Cart started before Regions existed names none — an inner join would
    // drop exactly those rows out of the Merchant's list rather than reporting them.
    .leftJoin(region, eq(region.id, cart.regionId))
    // `left` for the same reason twice over: most Carts carry no Address, and an Address may
    // name no Region — or name one that has since been deleted, which clears the reference.
    .leftJoin(address, eq(address.id, cart.addressId))
    .leftJoin(addressRegion, eq(addressRegion.id, address.regionId))
    .where(and(rowsAfter(page, cart.createdAt, cart.id), inState(page.state)))
    // `id` breaks the tie, so two Carts started in the same instant come back in one stable
    // order rather than in whichever order Postgres happened to read them — and so that a
    // cursor cut from the last of them names one row rather than a group.
    .orderBy(desc(cart.createdAt), desc(cart.id))
    .limit(pageSize(page));

  const { rows, nextCursor } = takePage(fetched, page);

  return {
    items: rows.map((row) => ({
      id: row.id,
      shopper: shopperOf(row),
      currency: row.currency,
      region: joined<RegionIdentity>(row.region),
      address: addressOf(row),
      metadata: row.metadata,
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expired,
      placed: row.placed,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor,
  };
}

/** `null` for a guest, which is the ordinary case — Core assumes a Shopper nowhere (ADR-0020). */
function shopperOf(row: {
  readonly shopperEmail: string | null;
  readonly shopperExternalId: string | null;
}): CartShopper | null {
  return row.shopperEmail === null
    ? null
    : { email: row.shopperEmail, externalId: row.shopperExternalId };
}

/**
 * One Cart with its Line Items, or `undefined` when there is no such Cart — including when
 * `id` is not an identifier at all, which is the same answer for the caller.
 */
export async function readCart(db: Queryable, id: string): Promise<Cart | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select({
      id: cart.id,
      shopperEmail: cart.shopperEmail,
      shopperExternalId: cart.shopperExternalId,
      currency: cart.currency,
      region: { id: region.id, name: region.name, currency: region.currency },
      ...addressColumns,
      metadata: cart.metadata,
      expiresAt: cart.expiresAt,
      expired: cartHasExpired,
      placed: cartHasBeenPlaced,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    })
    .from(cart)
    // `left`, for the list's reason: a Cart that names no Region still reads.
    .leftJoin(region, eq(region.id, cart.regionId))
    .leftJoin(address, eq(address.id, cart.addressId))
    .leftJoin(addressRegion, eq(addressRegion.id, address.regionId))
    .where(eq(cart.id, id))
    .limit(1);
  if (!row) return undefined;

  const lines = await db
    .select({
      id: cartLineItem.id,
      variantId: variant.id,
      sku: variant.sku,
      quantity: cartLineItem.quantity,
      metadata: cartLineItem.metadata,
    })
    .from(cartLineItem)
    .innerJoin(variant, eq(variant.id, cartLineItem.variantId))
    // `id` breaks the tie, so two lines added in the same instant still come back in one
    // stable order rather than in whichever order Postgres happened to read them.
    .orderBy(asc(cartLineItem.createdAt), asc(cartLineItem.id))
    .where(eq(cartLineItem.cartId, row.id));

  return {
    id: row.id,
    shopper: shopperOf(row),
    currency: row.currency,
    // `joined` rather than `row.region ?? null`, because Drizzle answers an unjoined nested
    // selection as an object of nulls rather than as `null` — see `db/join.ts`.
    region: joined<RegionIdentity>(row.region),
    address: addressOf(row),
    lineItems: lines.map((line) => ({
      id: line.id,
      variant: { id: line.variantId, sku: line.sku },
      quantity: line.quantity,
      metadata: line.metadata,
    })),
    metadata: row.metadata,
    expiresAt: row.expiresAt.toISOString(),
    expired: row.expired,
    placed: row.placed,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
