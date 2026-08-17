import { asc, eq } from "drizzle-orm";
import { cartHasExpired } from "../cart/read.ts";
import type { Transaction } from "../db/client.ts";
import {
  cart,
  cartLineItem,
  order,
  orderLineItem,
  product,
  variant,
} from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { priceResolutionWorkflow } from "../pricing/resolve-price.ts";
import { runWorkflow } from "../workflow/run.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import { defineWorkflow } from "../workflow/workflow.ts";
import { type Order, type OrderShopper, readOrder } from "./read.ts";

/**
 * **`place-order`** — a Cart becomes an immutable Order, in one request.
 *
 * A declared Workflow like `resolve-price`, and for the same reason: a Developer can read what
 * placing an Order does — `placeOrderWorkflow.describe()` names every Step in order — before
 * changing any of it, and a replacement is checked against the slot it fills by the compiler
 * (ADR-0017).
 *
 * **ADR-0009 decides the Step order, and it is not a matter of taste.** An Order is never
 * edited, so no compensation can ever undo the Order write — which means the Order write has to
 * be the *last thing that can fail*. Everything that can fail happens before it, and
 * `capture-order` declares no compensation because there is nothing it could honestly do. The
 * slots this Workflow grows later — holding Reservations, taking Payment — arrive *between*
 * `price-lines` and `capture-order` for exactly that reason, and consuming Reservations joins
 * the same transaction the Order is written in rather than becoming a fourth thing that can
 * fail afterwards (ADR-0018).
 *
 * Three slots today:
 *
 * - **`load-cart`** reads the Cart and its lines, and refuses a Cart that is missing, expired
 *   or empty. It applies no pricing rule; it hands over what was selected.
 * - **`price-lines`** invokes `resolve-price` for each line, through the deployment's own
 *   declaration (ADR-0054) — so a Project that replaced `select-price` charges its own prices
 *   at Capture without wiring the same customisation twice.
 * - **`capture-order`** writes the Order and its snapshot Line Items in one transaction.
 */

/** What a storefront sends: the Cart to place, and nothing else to orchestrate. */
export type PlaceOrderRequest = {
  readonly cartId: string;
};

/**
 * Every way Core's own Steps can refuse to place an Order.
 *
 * A closed union rather than the bare strings `StepFailure` carries, because the store surface
 * has to turn each of these into a status and should not be able to forget one — see the
 * `satisfies` in `http/store.ts`. A Step belonging to a Project or a Plugin refuses with
 * whatever reason it likes and is not in this union, which is the whole reason the union
 * exists.
 *
 * The refusals `resolve-price` makes are *not* listed here and still reach the caller: they
 * travel out of `price-lines` as themselves, and the store surface maps them from
 * `PriceResolutionRefusal` in the same exhaustive way.
 */
export type PlaceOrderRefusal = "cart-not-found" | "cart-expired" | "cart-empty";

/** One line of the Cart being placed, with everything the snapshot will need. */
export type CartLineToPlace = {
  readonly id: string;
  readonly variantId: string;
  /** The Product's title **now**, which is what Capture freezes onto the Order. */
  readonly title: string;
  readonly sku: string;
  readonly quantity: number;
  /**
   * The Line Item's own open data (ADR-0004), carried through to the Order's snapshot.
   *
   * This is the door a Shopper's unmodelled choice comes through, and a Project's replaced
   * Step is what reads it — so dropping it at Capture would lose the one record of what was
   * asked for.
   */
  readonly metadata: Record<string, unknown>;
};

/** The Cart's own fields that become the Order's, copied rather than referenced. */
export type CartToPlace = {
  readonly id: string;
  readonly shopper: OrderShopper | null;
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

/** One line, priced by `resolve-price` at the moment of Capture. */
export type PricedLine = CartLineToPlace & {
  /** Minor units of `currency` — what one of it costs, resolved now rather than read off the Cart. */
  readonly unitAmount: number;
  readonly currency: string;
};

/** What `price-lines` produces and `capture-order` writes. */
export type PricedLines = {
  readonly cart: CartToPlace;
  readonly lines: readonly PricedLine[];
};

/**
 * Reads the Cart, and refuses the three states it cannot be placed from.
 *
 * It reads the Product's title and the Variant's SKU here rather than at Capture because they
 * are what the snapshot freezes, and reading them in the Step that loads keeps `capture-order`
 * a write: by the time the point of no return is reached, everything it needs is in hand.
 *
 * **It takes no lock on the Cart, unlike every route that changes one.** `cart/write.ts` holds
 * the row `for update` for the length of one mutation, which is a few milliseconds; this
 * Workflow runs on past here to hold Reservations and take Payment, so a lock held from here to
 * Capture would be a database row held across a call to somebody else's payment processor. What
 * that costs is that a line added to the Cart while an Order is being placed is not on the
 * Order — which is the right answer anyway: an Order records what was placed, and what was
 * placed is what this Step read.
 */
export const loadCart = defineStep(
  "load-cart",
  async (input: PlaceOrderRequest, context): Promise<LoadedCart> => {
    // Checked before Postgres sees it: a malformed uuid raises, and an unhandled raise is a
    // 500 that reports a broken server for a request about something that does not exist.
    if (!isUuid(input.cartId)) throw noSuchCart(input.cartId);

    const [found] = await context.db
      .select({
        id: cart.id,
        shopperEmail: cart.shopperEmail,
        shopperExternalId: cart.shopperExternalId,
        metadata: cart.metadata,
        // The same expression the Cart's own routes judge expiry with, imported rather than
        // rewritten: a second spelling of it would be a second answer to whether a Cart is
        // still alive.
        expired: cartHasExpired,
      })
      .from(cart)
      .where(eq(cart.id, input.cartId))
      .limit(1);
    if (!found) throw noSuchCart(input.cartId);

    if (found.expired) {
      throw refuse(
        "cart-expired",
        "This Cart has expired, so it can no longer be placed. It is still readable and its Line Items are still there — start a new Cart.",
      );
    }

    const lines = await context.db
      .select({
        id: cartLineItem.id,
        variantId: variant.id,
        title: product.title,
        sku: variant.sku,
        quantity: cartLineItem.quantity,
        metadata: cartLineItem.metadata,
      })
      .from(cartLineItem)
      .innerJoin(variant, eq(variant.id, cartLineItem.variantId))
      .innerJoin(product, eq(product.id, variant.productId))
      .orderBy(asc(cartLineItem.createdAt), asc(cartLineItem.id))
      .where(eq(cartLineItem.cartId, found.id));

    if (lines.length === 0) {
      throw refuse(
        "cart-empty",
        "This Cart has nothing in it. An Order with no Line Items would be a financial record of nothing, so placing one is refused rather than written.",
      );
    }

    return {
      cart: {
        id: found.id,
        shopper:
          found.shopperEmail === null
            ? null
            : { email: found.shopperEmail, externalId: found.shopperExternalId },
        metadata: found.metadata,
      },
      lines,
    };
  },
);

/**
 * Prices every line, by invoking `resolve-price` — the Workflow, not a query.
 *
 * This is the point of composition (ADR-0054): a Project that replaced `select-price` so its
 * storefront quotes its own prices is charging those same prices at Capture, without wiring the
 * customisation a second time. `runWorkflow` is what makes that true — it resolves the
 * *deployment's* declaration through the registry on the context, where `resolvePrice.run(…)`
 * would run Core's own Steps whatever the Project had wired.
 *
 * An inner refusal is passed on as itself, so a Plugin's or a Project's Step declining a
 * purchase reaches the storefront with its own reason. The outer run then reports `price-lines`
 * as the slot that failed, because that is the only position this declaration has a name for.
 *
 * In series rather than in parallel. A Cart has few lines, and the first refusal a Shopper is
 * told about should be the first line that has one rather than whichever query lost a race.
 */
export const priceLines = defineStep(
  "price-lines",
  async (input: LoadedCart, context): Promise<PricedLines> => {
    const lines: PricedLine[] = [];

    for (const line of input.lines) {
      const run = await runWorkflow(
        priceResolutionWorkflow,
        { variantId: line.variantId },
        context,
      );
      // A refusal is a value the invoking Step decides about, and passing it on is the
      // decision: a line that cannot be priced is an Order that cannot be placed.
      if (!run.ok) throw new StepFailure(run.reason, run.detail);

      lines.push({
        ...line,
        unitAmount: run.output.price.amount,
        currency: run.output.price.currency,
      });
    }

    return { cart: input.cart, lines };
  },
);

/**
 * **Capture** — the Order comes into existence and becomes immutable.
 *
 * One transaction, and it is the last thing in this Workflow that can fail. Nothing here is
 * compensable: ADR-0009 makes an Order immutable, so there is no edit that could undo this
 * write, and the database is what unwinds a failure rather than a compensating Step. When
 * Reservations arrive they are consumed *in this transaction* for the same reason — stock and
 * Orders can never disagree if neither can be written without the other (ADR-0018).
 *
 * The Order is read back inside the transaction rather than assembled from what went in, so
 * what a Capture reports is the same bytes a later `GET` reports — same columns, same line
 * order, produced by the same code.
 */
export const captureOrder = defineStep(
  "capture-order",
  async (input: PricedLines, context): Promise<Order> => {
    const currency = oneCurrency(input.lines);
    const lines = input.lines.map((line) => ({
      variantId: line.variantId,
      title: line.title,
      sku: line.sku,
      unitAmount: line.unitAmount,
      currency: line.currency,
      quantity: line.quantity,
      // `tax` is left to its zero default until the tax spec puts a real Step in
      // `calculate-tax`; the column exists now so that adding tax later is not a change to
      // what an Order means (ADR-0022).
      total: line.unitAmount * line.quantity,
      metadata: line.metadata,
    }));

    return context.db.transaction(async (tx: Transaction): Promise<Order> => {
      const [written] = await tx
        .insert(order)
        .values({
          cartId: input.cart.id,
          shopperEmail: input.cart.shopper?.email ?? null,
          shopperExternalId: input.cart.shopper?.externalId ?? null,
          currency,
          total: lines.reduce((sum, line) => sum + line.total, 0),
          metadata: input.cart.metadata,
        })
        .returning({ id: order.id });
      if (!written) throw new Error("Writing an Order returned no row.");

      await tx
        .insert(orderLineItem)
        .values(lines.map((line) => ({ ...line, orderId: written.id })));

      const captured = await readOrder(tx, written.id);
      if (!captured) throw new Error("An Order was written and could not be read back.");
      return captured;
    });
  },
);

/**
 * The one currency this Order is in.
 *
 * Every Price carries the Store's default currency and may carry no other (#5), so Core's own
 * Steps cannot produce a mixture — but a Project's replacement of `select-price` can, and an
 * Order carrying one `total` in one currency has nowhere to put a second one. That is a bug in
 * the Step that produced it rather than a decision the Workflow made, so it travels as one: a
 * refusal would tell a storefront its request was declined, when what actually happened is that
 * this deployment is wired to price the same Order two ways.
 *
 * Multi-currency is out of scope by decision, and is additive when it arrives — a Price is a
 * row, so the shape that would represent it is more rows rather than a different Order.
 */
function oneCurrency(lines: readonly PricedLine[]): string {
  const currencies = [...new Set(lines.map((line) => line.currency))];
  const [only] = currencies;
  if (only === undefined) throw new Error("An Order was captured with no Line Items.");
  if (currencies.length > 1) {
    throw new Error(
      `This Order's lines were priced in ${currencies.join(", ")}, and an Order is in one currency. A Step replacing \`select-price\` returned a currency this Store does not price in.`,
    );
  }
  return only;
}

/**
 * Placing an Order, declared.
 *
 * Exported as a value rather than described in documentation, so "what does kobai do to place
 * an Order" is answered by the same object that answers "what does kobai run".
 */
export const placeOrderWorkflow = defineWorkflow<PlaceOrderRequest>("place-order")
  .step(loadCart)
  .step(priceLines)
  .step(captureOrder)
  .build();

/**
 * The declaration above, as a type.
 *
 * What a Project overrides is measured against this, and what the store surface runs is a value
 * of it — Core's own, or the one a Project's config rebuilt. The surface holds the type rather
 * than the value for exactly that reason: a route that imported the declaration directly would
 * run Core's Steps no matter what the Project had wired.
 */
export type PlaceOrderWorkflow = typeof placeOrderWorkflow;

function noSuchCart(cartId: string): StepFailure {
  return refuse(
    "cart-not-found",
    `No Cart ${JSON.stringify(cartId)} exists. A Cart is addressed by the identifier it was created with, and holding that identifier is the whole of the authority to act on it.`,
  );
}

/**
 * A refusal from one of Core's own Steps.
 *
 * The narrowed `reason` is the point: it is what ties every refusal this Workflow can make to
 * {@link PlaceOrderRefusal}, so adding one here without saying what status it means is a build
 * failure rather than a status nobody chose.
 */
function refuse(reason: PlaceOrderRefusal, detail: string): StepFailure {
  return new StepFailure(reason, detail);
}
