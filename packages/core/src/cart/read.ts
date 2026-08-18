import { asc, eq, sql } from "drizzle-orm";
import type { Queryable } from "../db/client.ts";
import { cart, cartLineItem, order, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";

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
 */

/**
 * Whether this Cart has passed its deadline, **as Postgres judges it**.
 *
 * One expression, exported, because there are now three places that ask — reading a Cart,
 * changing one, and placing one — and a second spelling of it is a second answer to the
 * question of whether a Cart is still alive. Judged in SQL rather than against `Date.now()` so
 * that one clock both sets the deadline and decides it has passed.
 *
 * The table is named as well as the column because Drizzle renders a column inside a
 * select-list `sql` template **unqualified** — `"expires_at"` — which resolves against whatever
 * Postgres finds first the moment the query joins anything. That is not hypothetical: the first
 * version of the Variant lookup in `write.ts` was written that way and silently compared
 * `core_price.variant_id` to `core_price.id`.
 */
export const cartHasExpired = sql<boolean>`now() > ${cart}.${cart.expiresAt}`;

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
export const cartHasBeenPlaced = sql<boolean>`exists (select 1 from ${order} where ${order}.${order.cartId} = ${cart}.${cart.id})`;

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

export type Cart = {
  /**
   * The identifier, and the whole of the authority to act on this Cart.
   *
   * There is no Shopper session to hang one off (ADR-0020), so holding this value is what
   * lets a storefront read and change the Cart. It is 122 bits from the platform CSPRNG, so
   * it encodes nothing and orders by nothing, and no route lists Carts.
   */
  readonly id: string;
  readonly shopper: CartShopper | null;
  /** In the order the lines were first added — a total order, so it never varies. */
  readonly lineItems: readonly CartLineItem[];
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
      metadata: cart.metadata,
      expiresAt: cart.expiresAt,
      expired: cartHasExpired,
      placed: cartHasBeenPlaced,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    })
    .from(cart)
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
    shopper:
      row.shopperEmail === null
        ? null
        : { email: row.shopperEmail, externalId: row.shopperExternalId },
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
