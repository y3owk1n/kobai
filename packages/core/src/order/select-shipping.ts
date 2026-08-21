import type { Queryable } from "../db/client.ts";
import {
  asShippingOption,
  readShippingMethods,
  type ShippingMethod,
  type ShippingOption,
  shippingRegionOf,
} from "../store/shipping-method.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import type { CartLineToPlace, CartToPlace } from "./load-cart.ts";
import type { Adjustment, PricedLine, PricedLines } from "./place-order.ts";

/**
 * **`select-shipping`** — what it costs to get this Order to the Shopper, as an Adjustment
 * (#321, ADR-0022).
 *
 * A slot of `place-order`, sitting between `price-lines` and `apply-adjustments`, and Core's own
 * implementation offers the flat rates the Cart's Region carries. A Project that wants real
 * carrier rates replaces it — Extension Point 2 doing its job rather than a new interface
 * (ADR-0017).
 *
 * **The charge is an Order-level Adjustment and never a `shipping_total` column**, which is the
 * decision doing the most work here. An Order-level Adjustment already carries its own tax —
 * which is exactly what carriage needs and what no Line Item's `tax` could hold, because
 * carriage belongs to no line — and refunds already know what an Adjustment is. A column would
 * have needed a special case in tax, in refunds, and in every place money is totted up, forever.
 * It also means `orderTotalOf` is untouched: an Order's total is still the sum of its lines and
 * its Adjustments, computed by the expression it always was.
 *
 * **It runs before `apply-adjustments`, and therefore before `calculate-tax`.** That is
 * arithmetic rather than ordering taste — carriage is taxed, and `place-order.test.ts` already
 * holds that adjustment precedes tax — and it has a second consequence worth knowing: a
 * deployment's own Adjustment rule *sees* the carriage, so `free delivery over fifty` is a
 * discount an `apply-adjustments` can write against a figure that is already there.
 *
 * **`calculate-tax` still returns zero** (spec 7, #213), and the shipping Adjustment carries a
 * tax figure from the day it ships regardless: a replaced `calculate-tax` has to state one for
 * every Order-level Adjustment it is handed, so one that left the carriage untaxed does not
 * compile.
 *
 * ## What it charges, and the three ways it charges nothing
 *
 * - **Nothing in the Cart ships.** The filter is `line.fulfilment.requiresShipping`, asked of
 *   the answer `load-cart` already carried, and it belongs here for the reason
 *   `inventoryProvider.claimsFor` puts the equivalent decision for Inventory in the provider:
 *   deciding which lines are its business is what this layer is for, and *not shipping* is no
 *   claim rather than a claim of zero. So a Cart of downloads needs no Address, is offered
 *   nothing, and places in one step.
 * - **This Store prices no delivery into the Cart's Region.** Every Region starts that way and
 *   kobai has sold physical things that way since the beginning, so a Store that has not said
 *   what carriage costs is charged none — the alternative would have made every existing
 *   deployment unable to place a physical Order until somebody configured shipping.
 * - **The Shopper has chosen nothing**, which is refused rather than free — see below.
 *
 * Otherwise: one Adjustment, at the chosen method's flat rate, in the Cart's own currency,
 * whatever the Cart holds. **A mixed Cart takes exactly one charge and the digital part
 * contributes nothing to it**, because the rate is the Region's and not a sum over lines — which
 * is the whole of what a flat rate means.
 *
 * ## The two refusals, and why they are in this order
 *
 * **`shipping-address-required`** comes first, because a Shopper who has said nothing about
 * where the parcel goes cannot usefully be asked which of two rates they want. **A Cart that
 * requires shipping and has no Address is refused**, and it is reachable from the quote and from
 * the placement alike, because both run this Step (ADR-0077).
 *
 * **`shipping-method-required`** comes second: this Store prices delivery where the Cart is
 * going and the Shopper has not picked one. Refusing beats charging zero — an Order that shipped
 * for nothing because a storefront skipped a step is a Merchant paying for carriage — and beats
 * picking the cheapest, which would be kobai deciding on the Shopper's behalf what they were
 * willing to pay for.
 *
 * Both are **422** on the store surface, on `cart-empty`'s distinction: the request is well
 * formed and what refuses it is the state of the Cart, and the repair is a control the storefront
 * already has.
 */

/** The code the Adjustment carries. Core's only one, and a Step's to recognise. */
export const SHIPPING_ADJUSTMENT_CODE = "shipping";

/** Refused because something in this Cart ships and nobody has said where. */
export const SHIPPING_ADDRESS_REQUIRED = "shipping-address-required";

/** Refused because this Store delivers there and the Shopper has chosen no way. */
export const SHIPPING_METHOD_REQUIRED = "shipping-method-required";

/** Every way Core's own `select-shipping` can refuse a Cart. */
export type SelectShippingRefusal =
  | typeof SHIPPING_ADDRESS_REQUIRED
  | typeof SHIPPING_METHOD_REQUIRED;

/**
 * What `select-shipping` produces and `apply-adjustments` adjusts.
 *
 * It is {@link PricedLines} with the Order's own Adjustments started — the carriage, where
 * anything ships — rather than a `shipping` field of its own, and that is the shape the
 * Adjustment decision forces: a field would be a `shipping_total` living one layer up, and
 * `orderTotalOf` would have had to learn about it.
 *
 * **A replacement of `apply-adjustments` therefore has to carry `adjustments` forward**, and
 * Core's own does. The compiler cannot make it — a Step declaring the narrower `PricedLines` as
 * its input is still assignable there — so **the slot asks at run time**: `carriesAdjustmentsForward`
 * in `place-order.ts` is the guard, it is carried onto a replacement rather than living in the
 * Step, and it is where the whole argument is written (#339). Until it existed the guarantee was
 * a coincidence — the reference Project happens to replace that slot, so
 * `tests/a-storefront-buys-something.test.ts` would have caught it for kobai's own Project and
 * for nobody else's.
 *
 * **Every slot after it carries the same guard**, because this list travels through all of them
 * and each returns a value of its own — `calculate-tax`, `hold-reservations` and `take-payment`
 * alike. `calculate-tax`'s return type asks every Adjustment it gets back for a tax and cannot
 * ask it for any Adjustments at all, so it refuses the untaxed pass-through and never the drop;
 * the last two are past the quote, so the placement is where a deployment finds out.
 */
export type ShippedLines = {
  readonly cart: CartToPlace;
  readonly lines: readonly PricedLine[];
  /** The Order's own Adjustments so far. One entry where this Cart is being delivered. */
  readonly adjustments: readonly Adjustment[];
};

export const selectShipping = defineStep(
  "select-shipping",
  async (input: PricedLines, context): Promise<ShippedLines> => {
    // Which lines are this Step's business, asked of the answer `load-cart` carried rather than
    // of the Strategy again: a Strategy is asked *about a Variant* and may read its `metadata`
    // (ADR-0013), so asking twice could get two answers.
    if (!shipsAnything(input.lines)) return { ...input, adjustments: [] };

    const regionId = await shippingRegionOf(context.db, input.cart.regionId);
    // A deployment with no default Region to fall back to cannot price a Cart at all, and
    // `price-lines` has already said so a slot earlier — so there is nothing here to add.
    const offered =
      regionId === null ? [] : await readShippingMethods(context.db, regionId);
    if (offered.length === 0) return { ...input, adjustments: [] };

    if (input.cart.address === null) {
      throw new StepFailure(
        SHIPPING_ADDRESS_REQUIRED,
        "Something in this Cart is to be shipped and it carries no Address, so there is nowhere to send it. Set one with `PATCH /store/carts/{id}` — `address` — and ask again. A Cart of things that are not shipped needs none.",
      );
    }

    const chosen = offered.find((method) => method.id === input.cart.shippingMethodId);
    if (!chosen) {
      throw new StepFailure(
        SHIPPING_METHOD_REQUIRED,
        `Something in this Cart is to be shipped and no way of delivering it has been chosen. \`GET /store/carts/{id}/shipping-options\` offers ${offered.map((method) => JSON.stringify(method.name)).join(", ")}; choose one with \`PATCH /store/carts/{id}\` — \`shippingMethodId\` — and ask again.`,
      );
    }

    return { ...input, adjustments: [carriage(chosen)] };
  },
);

/** Whether anything in this Cart is delivered rather than sent — the filter, said once. */
function shipsAnything(lines: readonly CartLineToPlace[]): boolean {
  return lines.some((line) => line.fulfilment.requiresShipping);
}

/**
 * The chosen method as an Adjustment on the Order.
 *
 * `description` is the method's own name, because that is what a Shopper picked and what a
 * Merchant reads on the Order — Core writes no prose of its own over it. `metadata` records
 * which method it was, so an Order placed a year ago still says what was chosen even after the
 * rate has been renamed or deleted: the Adjustment is the record, and nothing on an Order points
 * back at `core_shipping_method` (ADR-0009).
 */
function carriage(chosen: ShippingMethod): Adjustment {
  return {
    code: SHIPPING_ADJUSTMENT_CODE,
    description: chosen.name,
    // Positive: a surcharge adds. A rate is never negative, so there is no branch here and no
    // sign to get wrong — a delivery that paid the Shopper would be a discount, which ADR-0022
    // already has a shape for.
    amount: chosen.amount,
    metadata: { shippingMethodId: chosen.id, shippingMethodName: chosen.name },
  };
}

/**
 * The options a Cart is offered — the reading `GET /store/carts/{id}/shipping-options` answers
 * with, and the same three questions the Step above asks.
 *
 * It is a function beside the Step rather than a second reading of the Cart, because the two
 * must agree: a storefront offered a method that would then be refused, or offered nothing for a
 * Cart that is about to be told to choose, is the disagreement this shares one function to
 * prevent.
 */
export type ShippingOptions = {
  /** Whether anything in this Cart is delivered at all — `false` needs no Address and no choice. */
  readonly requiresShipping: boolean;
  /** Empty where nothing ships, or where this Store prices no delivery into the Cart's Region. */
  readonly options: readonly ShippingOption[];
};

export async function shippingOptionsFor(
  db: Queryable,
  cart: CartToPlace,
  lines: readonly CartLineToPlace[],
): Promise<ShippingOptions> {
  if (!shipsAnything(lines)) return { requiresShipping: false, options: [] };

  const regionId = await shippingRegionOf(db, cart.regionId);
  const offered = regionId === null ? [] : await readShippingMethods(db, regionId);

  // Down to what a storefront may see, field by field: this route is opened by a publishable
  // key, and a Merchant's `metadata` on a rate is not a browser's (#207).
  return { requiresShipping: true, options: offered.map(asShippingOption) };
}
