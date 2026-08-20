import { asc, eq } from "drizzle-orm";
import { cartHasBeenPlaced, cartHasExpired } from "../cart/read.ts";
import { PUBLISHED } from "../catalog/status.ts";
import type { Queryable } from "../db/client.ts";
import { cart, cartLineItem, product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type AppliedFulfilment,
  CORE_FULFILMENT_STRATEGIES,
  type FulfilmentStrategies,
  fulfilmentAnswersFor,
} from "../fulfilment/strategy.ts";
import type { ReservableLine } from "../reservation/provider.ts";
import type { OrderShopper } from "./read.ts";

/**
 * **Reading a Cart for the two things that can claim against it** — `place-order`'s `load-cart`
 * Step, and the store route that holds a Cart's stock before a Shopper is sent to their bank
 * (ADR-0070).
 *
 * It lives in a file of its own because there are two callers and they must agree. What is in a
 * Cart, in what order, and what each line's Fulfilment Strategy answers about it are the facts
 * that decide *what is claimed* — so a second reading of them is a second answer, and the two
 * would drift into a hold that covers something other than what the placement then captures.
 * That is the overselling ADR-0018 is about, arriving through a door nobody was watching.
 *
 * The Product's title and the Variant's SKU are read here although only Capture snapshots them,
 * for the same reason: one query, one answer, and the hold route pays a join it does not use
 * rather than this repository keeping two queries in step.
 */

/** The Cart's own fields that become the Order's, copied rather than referenced. */
export type CartToPlace = {
  readonly id: string;
  readonly shopper: OrderShopper | null;
  readonly metadata: Record<string, unknown>;
};

/** One line of the Cart being placed, with everything the snapshot will need. */
export type CartLineToPlace = {
  readonly id: string;
  readonly variantId: string;
  /** The Product's title **now**, which is what Capture freezes onto the Order. */
  readonly title: string;
  readonly sku: string;
  readonly quantity: number;
  /**
   * How this line is delivered — its Variant's Fulfilment Strategy, asked here and carried
   * (ADR-0014, ADR-0052).
   *
   * Resolved by `load-cart` rather than by each Step that wants it, so one placement gets one
   * answer: it is what `hold-reservations` reads to decide whether anything is claimed, and what
   * `capture-order` snapshots onto the Order's Fulfilments. A Step in between may read it and a
   * replacement may decide differently about a line, which is the same latitude every other
   * field here carries.
   */
  readonly fulfilment: AppliedFulfilment;
  /**
   * The Line Item's own open data (ADR-0004), carried through to the Order's snapshot.
   *
   * This is the door a Shopper's unmodelled choice comes through, and a Project's replaced
   * Step is what reads it — so dropping it at Capture would lose the one record of what was
   * asked for.
   */
  readonly metadata: Record<string, unknown>;
};

/** What `load-cart` produces and `price-lines` prices. */
export type LoadedCart = {
  readonly cart: CartToPlace;
  /**
   * In the order they were added to the Cart — a total order, so two runs over one Cart price
   * the same lines in the same sequence.
   *
   * That is the Cart's order and not the Order's: an Order reports its Line Items in SKU order,
   * because Capture writes them all in one transaction and there is then no moment that tells
   * one from another. See `read.ts`.
   */
  readonly lines: readonly CartLineToPlace[];
};

/**
 * Every way reading a Cart for a claim can refuse.
 *
 * Its own union rather than a slice of `PlaceOrderRefusal`, because it is what *both* callers
 * can be told: `place-order` folds it into its own refusals and the hold route maps exactly
 * these to statuses. A word added here therefore turns both status maps red naming it, which is
 * the property that makes the sharing worth anything.
 */
export type LoadCartRefusal =
  | "cart-not-found"
  | "cart-expired"
  | "cart-placed"
  | "cart-empty"
  | "variant-unavailable"
  | "unknown-fulfilment-strategy";

/** The Cart as both callers read it, or the one word that says why it cannot be. */
export type LoadedCartResult =
  | { readonly ok: true; readonly loaded: LoadedCart }
  | {
      readonly ok: false;
      readonly reason: LoadCartRefusal;
      readonly detail: string;
    };

/**
 * Reads the Cart and its lines, and refuses the four states nothing may be claimed against.
 *
 * **It takes no lock on the Cart, unlike every route that changes one.** `cart/write.ts` holds
 * the row `for update` for the length of one mutation, which is a few milliseconds; `place-order`
 * runs on past here to hold Reservations and take Payment, so a lock held from here to Capture
 * would be a database row held across a call to somebody else's Payment Provider. What that
 * costs is that a line added to the Cart while an Order is being placed is not on the Order —
 * which is the right answer anyway: an Order records what was placed, and what was placed is
 * what this read returned.
 */
export async function readCartToPlace(
  db: Queryable,
  cartId: string,
  strategies: FulfilmentStrategies | undefined,
): Promise<LoadedCartResult> {
  // Checked before Postgres sees it: a malformed uuid raises, and an unhandled raise is a
  // 500 that reports a broken server for a request about something that does not exist.
  if (!isUuid(cartId)) return noSuchCart(cartId);

  const [found] = await db
    .select({
      id: cart.id,
      shopperEmail: cart.shopperEmail,
      shopperExternalId: cart.shopperExternalId,
      metadata: cart.metadata,
      // The same expression the Cart's own routes judge expiry with, imported rather than
      // rewritten: a second spelling of it would be a second answer to whether a Cart is
      // still alive.
      expired: cartHasExpired,
      placed: cartHasBeenPlaced,
    })
    .from(cart)
    .where(eq(cart.id, cartId))
    .limit(1);
  if (!found) return noSuchCart(cartId);

  if (found.expired) {
    return refused(
      "cart-expired",
      "This Cart has expired, so it can no longer be placed. It is still readable and its Line Items are still there — start a new Cart.",
    );
  }

  // Refused here so that nothing is priced, no Reservation is held and no Payment is taken for
  // a Cart that already has an Order. It is not what *makes* the rule true: the unique index on
  // `core_order.cart_id` is, and it is what catches the pair of requests that get past this
  // check at the same instant. See `captureOrder`.
  if (found.placed) return alreadyPlaced(cartId);

  const selected = await db
    .select({
      id: cartLineItem.id,
      variantId: variant.id,
      title: product.title,
      sku: variant.sku,
      quantity: cartLineItem.quantity,
      metadata: cartLineItem.metadata,
      // The Product's status, for the one question this read asks about it beyond the title
      // (#276). It is read here rather than at each claiming caller for this module's whole
      // reason: the hold route and the placement must agree about what is in a Cart, and
      // whether a line may still be bought is part of that.
      status: product.status,
      fulfilmentStrategy: variant.fulfilmentStrategy,
      // The Variant's own open data, for the Strategy rather than for the snapshot — a
      // made-to-order Strategy reads its own key out of it (ADR-0013), and Core reads none.
      variantMetadata: variant.metadata,
    })
    .from(cartLineItem)
    .innerJoin(variant, eq(variant.id, cartLineItem.variantId))
    .innerJoin(product, eq(product.id, variant.productId))
    .orderBy(asc(cartLineItem.createdAt), asc(cartLineItem.id))
    .where(eq(cartLineItem.cartId, found.id));

  const lines: CartLineToPlace[] = [];
  // Asked once per line, here, and carried from here on: the answers decide what is claimed
  // and become the Order's Fulfilment snapshot, and a placement that asked twice could get
  // two answers (ADR-0052).
  for (const { fulfilmentStrategy, variantMetadata, status, ...line } of selected) {
    // Asked before the Strategy, because it is the more fundamental answer and the one the
    // Shopper can act on: a line nothing may sell is refused whatever it would have been
    // fulfilled by, and telling somebody their Fulfilment Strategy is unwired about a Product
    // that is not for sale sends them after the wrong repair.
    if (status !== PUBLISHED) return notOnSale(line.sku);

    const answers = fulfilmentAnswersFor(
      strategies ?? CORE_FULFILMENT_STRATEGIES,
      fulfilmentStrategy,
      { id: line.variantId, sku: line.sku, metadata: variantMetadata },
    );
    if (!answers) return unknownStrategy(line.sku, fulfilmentStrategy);

    lines.push({ ...line, fulfilment: { strategy: fulfilmentStrategy, ...answers } });
  }

  if (lines.length === 0) {
    return refused(
      "cart-empty",
      "This Cart has nothing in it. An Order with no Line Items would be a financial record of nothing, so placing one is refused rather than written.",
    );
  }

  return {
    ok: true,
    loaded: {
      cart: {
        id: found.id,
        shopper:
          found.shopperEmail === null
            ? null
            : { email: found.shopperEmail, externalId: found.shopperExternalId },
        metadata: found.metadata,
      },
      lines,
    },
  };
}

/**
 * This Cart's lines as a Reservation provider sees them — the four things it may see, and no
 * more.
 *
 * What was selected, how much of it, the Line Item's own open data — which is where a Capacity
 * provider will find the date a Shopper asked for (ADR-0013) — and what this Variant's Fulfilment
 * Strategy answered, which is what tells each provider whether the line is its business at all
 * (ADR-0052).
 *
 * Written here rather than at each caller for `readCartToPlace`'s own reason: the hold route and
 * `hold-reservations` claim against the same Cart minutes apart, and two projections that drifted
 * would be two answers to what is being claimed.
 */
export function reservableLinesOf(loaded: {
  // The lines as they were loaded, or as any later Step is carrying them — `hold-reservations`
  // asks after four Steps have added prices, Adjustments and tax to each one.
  readonly lines: readonly CartLineToPlace[];
}): readonly ReservableLine[] {
  return loaded.lines.map((line) => ({
    variantId: line.variantId,
    quantity: line.quantity,
    metadata: line.metadata,
    fulfilment: line.fulfilment,
  }));
}

/**
 * A Cart that has already become an Order, in the words every place that finds out uses.
 *
 * Three places can: this read, `capture-order` losing the race for the unique index on
 * `core_order.cart_id`, and the hold route. A Shopper who pressed the button twice is told the
 * same thing whichever of them answered, which is why the prose is here rather than at each.
 */
export function cartAlreadyPlaced(cartId: string): {
  readonly reason: LoadCartRefusal;
  readonly detail: string;
} {
  return {
    reason: "cart-placed",
    detail: `Cart ${JSON.stringify(cartId)} has already been placed, and a Cart becomes exactly one Order. The Order it became is still readable; start a new Cart to buy anything else.`,
  };
}

function alreadyPlaced(cartId: string): LoadedCartResult {
  return { ok: false, ...cartAlreadyPlaced(cartId) };
}

function noSuchCart(cartId: string): LoadedCartResult {
  return refused(
    "cart-not-found",
    `No Cart ${JSON.stringify(cartId)} exists. A Cart is addressed by the identifier it was created with, and holding that identifier is the whole of the authority to act on it.`,
  );
}

/**
 * A line whose Product has left the storefront, refused rather than dropped (#276).
 *
 * A Shopper built this Cart while the Product was published and a Merchant has since made it a
 * draft again or archived it. **The line is refused and the Cart is left exactly as it is**,
 * which is the decision this refusal exists to carry:
 *
 * - **Not dropped.** Removing it silently would change what is being bought, in the one request
 *   where the Shopper is committing to what they are buying — ADR-0009's snapshot argument read
 *   forwards, and the failure a storefront finds out about from a confirmation email.
 * - **Not tolerated.** A Product a Merchant has taken off sale is one nothing may sell, and an
 *   Order placed for it is a promise the Store did not mean to make.
 * - **Refused with a repair the Shopper can carry out**, which is ADR-0059's rule and what makes
 *   refusing honest here rather than merely strict: the line comes off with
 *   `DELETE /store/carts/{id}/line-items/{lineItemId}` and the rest of the Cart places.
 *
 * The cost is accepted rather than avoided: a Shopper who did nothing wrong meets a dead end at
 * the last step. The three routes this read serves is what softens it — a storefront quoting or
 * holding stock meets this before the Shopper is sent anywhere near a bank.
 *
 * **One word for draft and archived alike**, because a storefront can act on neither
 * differently, and because the store surface deliberately publishes no status: telling a browser
 * *which* of the two would say whether a Merchant is preparing something or has retired it.
 */
function notOnSale(sku: string): LoadedCartResult {
  return refused(
    "variant-unavailable",
    `Variant ${JSON.stringify(sku)} is no longer on sale: its Product has been taken off the storefront since it was put in this Cart. Remove that Line Item and the rest of the Cart can still be placed.`,
  );
}

/**
 * A line whose Fulfilment Strategy this deployment no longer has, refused rather than guessed
 * at.
 *
 * A Variant may only be created pointing at a Strategy the deployment has wired, so the only way
 * to reach this is for a Project to *unwire* one its Variants already point at. That is a
 * configuration change rather than a fault in anybody's request, and it is answered the way
 * `no-payment-provider` is: this Store cannot sell this thing until somebody changes the Store.
 * Refusing beats guessing — a Variant Core silently treated as `physical` would be one whose
 * stock it claimed and whose Order it recorded as shipping, neither of which anybody asked for.
 *
 * The Strategies asked are Core's own two when nothing was threaded, because that is what a
 * deployment which wired nothing has — not an empty set in which no Variant can be fulfilled.
 */
function unknownStrategy(sku: string, strategy: string): LoadedCartResult {
  return refused(
    "unknown-fulfilment-strategy",
    `Variant ${JSON.stringify(sku)} is fulfilled by ${JSON.stringify(strategy)}, and this deployment has no Fulfilment Strategy of that name. It was wired under \`fulfilment.strategies\` in this Project's \`kobai.config.ts\` when the Variant was created, and is not now.`,
  );
}

function refused(reason: LoadCartRefusal, detail: string): LoadedCartResult {
  return { ok: false, reason, detail };
}
