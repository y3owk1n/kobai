import { asc, eq } from "drizzle-orm";
import { cartHasBeenPlaced, cartHasExpired } from "../cart/read.ts";
import { lockVariants } from "../catalog/lock.ts";
import type { Transaction } from "../db/client.ts";
import { violatesUniqueIndex } from "../db/errors.ts";
import {
  cart,
  cartLineItem,
  order,
  orderAdjustment,
  orderLineItem,
  payment,
  product,
  variant,
} from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { keyOf, writeFulfilments } from "../fulfilment/fulfilment.ts";
import {
  type AppliedFulfilment,
  CORE_FULFILMENT_STRATEGIES,
  type FulfilmentStrategies,
  fulfilmentAnswersFor,
} from "../fulfilment/strategy.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import { priceResolutionWorkflow } from "../pricing/resolve-price.ts";
import type { ReservationRefusal } from "../reservation/provider.ts";
import {
  consumeReservations,
  type HeldReservation,
  holdReservations as holdReservationsFor,
  releaseReservations,
} from "../reservation/reservation.ts";
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
 * `capture-order` declares no compensation because there is nothing it could honestly do. That
 * is why `take-payment` sits immediately in front of it — money is the one thing here that moves
 * outside the database, so it is the one thing a compensation has to undo — and why
 * `hold-reservations` sits in front of *that*: stock is claimed before a Shopper is charged for
 * it, and consuming the claims joins the transaction the Order is written in rather than becoming
 * another thing that can fail afterwards (ADR-0018).
 *
 * Seven slots today:
 *
 * - **`load-cart`** reads the Cart and its lines, and refuses a Cart that is missing, expired,
 *   already placed or empty. It applies no pricing rule; it hands over what was selected, with
 *   each line's Fulfilment Strategy already asked about it (ADR-0052) — once, here, so that
 *   nothing later in the run can get a different answer.
 * - **`price-lines`** invokes `resolve-price` for each line, through the deployment's own
 *   declaration (ADR-0054) — so a Project that replaced `select-price` charges its own prices
 *   at Capture without wiring the same customisation twice.
 * - **`apply-adjustments`** attaches discounts and surcharges as their own lines (ADR-0022).
 *   Core's own implementation attaches none; the slot is where a Plugin's or a Project's rule
 *   goes.
 * - **`calculate-tax`** works out the tax on each line, and Core's own implementation returns
 *   **zero** — see {@link calculateTax}.
 * - **`hold-reservations`** claims everything scarce in the Cart, atomically, and **its
 *   compensation releases** — see {@link holdReservations}. A Cart of lines whose Strategies
 *   consume nothing scarce claims nothing at all.
 * - **`take-payment`** asks the deployment's Payment Provider for what the Order comes to, and
 *   **its compensation refunds** — see {@link takePayment}. Core implements no provider
 *   (ADR-0053), so a deployment wired with none refuses here and nowhere else.
 * - **`capture-order`** consumes those Reservations and writes the Order, its snapshot Line
 *   Items, its Adjustments, its Fulfilments and the Payment — in one transaction.
 *
 * **`apply-adjustments` runs before `calculate-tax`, and that is arithmetic rather than
 * ordering taste.** ADR-0022 says an Adjustment changes what a line total means in every Order
 * snapshot, tax base and refund; a discount applied after the tax had been worked out would
 * leave the Order taxed on a figure nobody was charged.
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
export type PlaceOrderRefusal =
  | "cart-not-found"
  | "cart-expired"
  | "cart-placed"
  | "cart-empty"
  | "no-payment-provider"
  | "payment-declined"
  | "unknown-fulfilment-strategy"
  // Every way a Reservation provider can say the Store has not got it, folded in rather than
  // spelled out: a second provider adds a member to that union and this one grows with it, so
  // the store surface's status map goes red naming the new reason instead of answering it 422.
  | ReservationRefusal;

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

/** What `price-lines` produces and `apply-adjustments` adjusts. */
export type PricedLines = {
  readonly cart: CartToPlace;
  readonly lines: readonly PricedLine[];
};

/**
 * A discount or a surcharge — **its own line, never a number folded into an amount**
 * (ADR-0022).
 *
 * That is the whole shape and the whole point. An Adjustment that had been subtracted from a
 * `unitAmount` would leave an Order saying a Variant cost something it does not cost, with no
 * record of why, and every downstream figure — the tax base, a refund, the Merchant's revenue —
 * derived from a price that was never charged. So a Step declares what it is adding and Core
 * writes it as a row beside the line it belongs to.
 *
 * There is no `id` here because a Step is describing an Adjustment rather than reading one
 * back; Capture gives it one, and {@link OrderAdjustment} is what a caller then sees.
 */
export type Adjustment = {
  /**
   * Machine-readable, and the Step's to choose — `lead-time-surcharge`, `loyalty-discount`.
   *
   * Core defines none of its own and validates none: an Adjustment kobai understood would be a
   * discount engine, and that is not what ADR-0022 asked for.
   */
  readonly code: string;
  /** For a person — what a Shopper reads on a confirmation and a Merchant reads in the Admin. */
  readonly description: string;
  /**
   * **Signed** minor units of the Order's currency: negative discounts, positive surcharges.
   *
   * One signed column rather than a `kind` and a magnitude, because the arithmetic is then the
   * same in both directions and a total is a sum — the alternative is a branch at every place
   * money is added up, and one of them eventually gets the sign wrong.
   */
  readonly amount: number;
  /** The Adjustment's own open data (ADR-0004) — why it was applied, in the Step's own terms. */
  readonly metadata?: Record<string, unknown>;
};

/** One priced line, with whatever `apply-adjustments` attached to it. */
export type AdjustedLine = PricedLine & {
  readonly adjustments: readonly Adjustment[];
};

/** What `apply-adjustments` produces and `calculate-tax` taxes. */
export type AdjustedLines = {
  readonly cart: CartToPlace;
  readonly lines: readonly AdjustedLine[];
  /**
   * Adjustments on the **Order as a whole** — the ones that belong to no single line, such as a
   * basket-wide discount or a delivery surcharge (ADR-0022, `CONTEXT.md`).
   *
   * Two places rather than one because the distinction is real and unrecoverable afterwards: an
   * Adjustment on a line is part of what that line came to, and so part of what a Return for
   * that line refunds, while one on the Order is not attributable to any of them.
   */
  readonly adjustments: readonly Adjustment[];
};

/** One adjusted line, with the tax `calculate-tax` worked out for it. */
export type TaxedLine = AdjustedLine & {
  /** Minor units, on the **adjusted** figure — which is why this slot runs after that one. */
  readonly tax: number;
};

/**
 * One **Order-level** Adjustment, with the tax `calculate-tax` worked out for it (#117).
 *
 * A delivery surcharge belongs to no line and is taxable in most jurisdictions, so this is where
 * that figure goes: an Order-level Adjustment has no Line Item whose `tax` could carry it. The
 * shape is a tax **per Adjustment** rather than one figure beside the Order's total, because a
 * real tax engine answers per taxable item and a receipt has to show tax against the thing that
 * bore it — see `core_order_adjustment.tax` in `db/schema.ts` for the full argument and for what
 * was rejected.
 *
 * There is deliberately no counterpart on {@link AdjustedLine.adjustments}: `calculate-tax` taxes
 * the *adjusted* line, so a line's own Adjustments are already inside {@link TaxedLine.tax}, and
 * a second figure would be charged twice or dropped.
 */
export type TaxedAdjustment = Adjustment & {
  /** Minor units, signed with the Adjustment: a taxed discount reduces the tax it is on. */
  readonly tax: number;
};

/** What `calculate-tax` produces and `hold-reservations` claims against. */
export type TaxedLines = {
  readonly cart: CartToPlace;
  readonly lines: readonly TaxedLine[];
  /**
   * The Order's own, each now carrying its tax — which is why this is not simply what
   * `apply-adjustments` handed over.
   *
   * A replaced `calculate-tax` has to state one for every Adjustment here, and the compiler is
   * what asks: a tax Step that silently left the carriage untaxed is exactly the bug this slot
   * exists to make impossible.
   */
  readonly adjustments: readonly TaxedAdjustment[];
};

/**
 * What `hold-reservations` produces and `take-payment` charges for: the same Order, with the
 * claims it is holding on everything scarce in it.
 *
 * The Reservations travel on the value rather than in bookkeeping beside it because
 * `capture-order` is what consumes them, and it consumes them *inside the transaction it writes
 * the Order in* (ADR-0018). A Step in between that rebuilt this object without them would
 * therefore write an Order whose stock was never taken — which is why they are part of the
 * contract each slot is checked against rather than a detail Core remembers privately.
 */
export type ReservedLines = TaxedLines & {
  /** Empty when nothing in this Cart is scarce — a Cart of digital Variants holds nothing. */
  readonly reservations: readonly HeldReservation[];
};

/**
 * The money a Payment Provider took, as `take-payment` reports it and `capture-order` records it.
 *
 * A copy rather than a reference to anything: `provider` is what took it and `reference` is that
 * provider's own handle on it, so an Order placed a year ago still says which system holds the
 * money and what to quote at it. Core parses neither.
 */
export type TakenPayment = {
  readonly provider: string;
  readonly reference: string;
  /** Minor units of `currency` — what was actually charged, which is the Order's total. */
  readonly amount: number;
  readonly currency: string;
  /**
   * Whether the money arrived, or was only arranged for — the provider's own answer.
   *
   * `true` unless a provider said otherwise, because `ok: true` has meant *takes the money*
   * since {@link PaymentProvider} shipped. A provider that arranges instead — an invoice, a bank
   * transfer, the reference Project's `manual` one — answers `received: false`, and this is what
   * carries that as far as the record.
   */
  readonly received: boolean;
};

/** What `take-payment` produces and `capture-order` writes: the Order, and the money for it. */
export type PaidOrder = ReservedLines & {
  readonly payment: TakenPayment;
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
 * Capture would be a database row held across a call to somebody else's Payment Provider. What
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
        placed: cartHasBeenPlaced,
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

    // Refused here so that nothing is priced and — when they arrive — no Reservation is held
    // and no Payment is taken for a Cart that already has an Order. It is not what *makes* the
    // rule true: the unique index on `core_order.cart_id` is, and it is what catches the pair
    // of requests that get past this check at the same instant. See {@link captureOrder}.
    if (found.placed) throw alreadyPlaced(input.cartId);

    const selected = await context.db
      .select({
        id: cartLineItem.id,
        variantId: variant.id,
        title: product.title,
        sku: variant.sku,
        quantity: cartLineItem.quantity,
        metadata: cartLineItem.metadata,
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

    // Asked once per line, here, and carried from here on: the answers decide what is claimed
    // and become the Order's Fulfilment snapshot, and a placement that asked twice could get
    // two answers (ADR-0052).
    const lines = selected.map(
      ({ fulfilmentStrategy, variantMetadata, ...line }): CartLineToPlace => ({
        ...line,
        fulfilment: fulfilmentOf(context.fulfilment, fulfilmentStrategy, {
          id: line.variantId,
          sku: line.sku,
          metadata: variantMetadata,
        }),
      }),
    );

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
 * Attaches Adjustments — and **Core attaches none**.
 *
 * That is not an oversight and it is not a placeholder. ADR-0022 puts the *shape* in Core
 * because omitting it makes "line total" wrong in every Order, tax base and refund; it does not
 * put a discount engine in Core, and there is no rule Core could apply that would be right for
 * anybody's Store. What ships here is the slot, positioned where the arithmetic needs it.
 *
 * A Plugin or a Project fills it either way round, and both are ordinary:
 *
 * - **Replacing** the slot owns it — the Step takes {@link PricedLines} and returns
 *   {@link AdjustedLines} with whatever it decided.
 * - **Inserting after** it composes — an inserted Step takes and gives {@link AdjustedLines}, so
 *   two rules that each add a surcharge stack rather than overwrite one another. That is the
 *   shape to reach for when more than one thing adjusts an Order.
 */
export const applyAdjustments = defineStep(
  "apply-adjustments",
  (input: PricedLines): AdjustedLines => ({
    cart: input.cart,
    lines: input.lines.map((line) => ({ ...line, adjustments: [] })),
    adjustments: [],
  }),
);

/**
 * Works out the tax on each line, and **returns zero**.
 *
 * Zero is the deliverable rather than a stub apologised for. ADR-0009 has an Order's Line Items
 * snapshot the tax as at Capture, so the figure has to exist from the very first Order — a
 * snapshot that gained one later would change what every Order written before it means, and
 * there would be no honest value to backfill. Core has no jurisdiction and will never have one,
 * so the only tax it can state truthfully is the tax it charged, which is none.
 *
 * A replaceable Step returning zero is therefore the extension surface being used as intended:
 * a Project whose rules Core will never model replaces this slot, and so does the tax spec when
 * it arrives — neither of them changing what an Order means, because the field was always there.
 *
 * It taxes the **adjusted** figure: `unitAmount × quantity` plus this line's Adjustments, which
 * is what `apply-adjustments` running first is for. A replacement that wants the tax base has
 * everything it needs on the input and nothing to ask Core for.
 *
 * **The Order's own Adjustments are taxed here too, and separately** (#117). A delivery surcharge
 * is on no line, so no line's tax can carry it; each one gets its own figure, and Core's is zero
 * for the same reason every other figure here is.
 */
export const calculateTax = defineStep(
  "calculate-tax",
  (input: AdjustedLines): TaxedLines => ({
    cart: input.cart,
    lines: input.lines.map((line) => ({ ...line, tax: 0 })),
    adjustments: input.adjustments.map((adjustment) => ({ ...adjustment, tax: 0 })),
  }),
);

/**
 * What a Step did, remembered for the compensation that has to undo it.
 *
 * Core hands a compensation **the very value** its `run` was given (ADR-0036), so that value is
 * the key: no bookkeeping crosses between runs, and a failure now can only ever undo what this
 * run did. Weak, so a run that succeeds leaves nothing behind to collect; and outside the Step
 * rather than on the value it passes along, because that value belongs to the Workflow.
 *
 * A **stack** rather than one entry per input, for the reason `@kobai/plugin-price-log` keeps
 * one: nothing stops a Project wiring a second Step doing the same kind of thing into the same
 * Workflow, both keyed on the same input, and Core unwinds in reverse — so each compensation
 * undoes what its own `run` put on top.
 *
 * Two Steps here keep one: `hold-reservations` and `take-payment`, the two that do something
 * outside their own transaction. Everything before them decides rather than does, and Capture's
 * work is undone by the database.
 */
function unwoundBy<Input extends object, Done>() {
  const stacks = new WeakMap<Input, Done[]>();
  return {
    /** Called before the Step returns, so a compensation can find it however the run ends. */
    push(input: Input, done: Done): void {
      stacks.set(input, [...(stacks.get(input) ?? []), done]);
    },
    /**
     * The newest thing this input had done to it, or nothing. Core would not call a compensation
     * unless the Step completed, but a compensation should not assume it is being called for the
     * reason it expects.
     */
    pop(input: Input): Done | undefined {
      return stacks.get(input)?.pop();
    },
  };
}

/** What each run is holding, for the run that holds it. */
const holding = unwoundBy<TaxedLines, readonly HeldReservation[]>();

/**
 * **`hold-reservations`** — the Store stops overselling (ADR-0018, ADR-0027).
 *
 * Everything scarce in this Cart is claimed here, atomically, through the one Reservation
 * interface: Inventory today, and Capacity as a second provider without a second mechanism.
 * What "atomically" means is not this Step's business and is the whole point of the interface —
 * a provider claims with a row lock or a conditional write, never a read followed by a write,
 * because two requests that both read the same last unit and then both write have implemented
 * the appearance of safety, which is worse than none.
 *
 * **Its position is the decision, and its compensation follows from it.** It sits *before*
 * `take-payment` so that a Shopper whose card is charged is a Shopper the stock was already
 * held for, and the compensation releases — a hold that outlived a failed placement would make
 * stock unsellable for no purchase. Consuming happens later and elsewhere: `capture-order` takes
 * these claims for good inside the transaction that writes the Order, so **nothing there needs
 * a compensation**, because the database unwinds a claim and an Order together or not at all.
 *
 * A Cart holding nothing scarce holds nothing: an untracked Variant produces no claim, so this
 * Step is free for a Store selling downloads and is not something such a Store has to switch
 * off.
 */
export const holdReservations = defineStep(
  "hold-reservations",

  async (input: TaxedLines, context): Promise<ReservedLines> => {
    const held = await holdReservationsFor(
      context.db,
      // The four things a provider may see, and no more: what was selected, how much of it,
      // the Line Item's own open data — which is where a Capacity provider will find the date a
      // Shopper asked for (ADR-0013) — and what this Variant's Fulfilment Strategy answered,
      // which is what tells each provider whether the line is its business at all (ADR-0052).
      input.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
        metadata: line.metadata,
        fulfilment: line.fulfilment,
      })),
    );
    // A provider's refusal is a refusal of the Order, with the provider's own reason — so a
    // Store that is out of stock says so, and Capacity will say its own thing here without this
    // Step learning a second word.
    if (!held.ok) throw new StepFailure(held.reason, held.detail);

    holding.push(input, held.reservations);

    return { ...input, reservations: held.reservations };
  },

  async (input, context) => {
    // Nothing held, nothing to give back.
    const reservations = holding.pop(input);
    if (reservations === undefined) return;

    await releaseReservations(context.db, reservations);
  },
);

/** What each run charged, for the run that charged it — see {@link unwoundBy}. */
const charged = unwoundBy<ReservedLines, ChargedTo>();

/** A payment, and the provider that took it — because that is the one that can give it back. */
type ChargedTo = {
  readonly provider: PaymentProvider;
  readonly payment: TakenPayment;
};

/**
 * **`take-payment`** — the money moves, through an interface Core does not implement (ADR-0053).
 *
 * Core defines {@link PaymentProvider} and ships no implementation of it, so what happens here
 * belongs to whoever wired one in `kobai.config.ts`. Three answers, and they are deliberately
 * three:
 *
 * - **No provider configured** is a refusal, `no-payment-provider`, and nothing else about the
 *   deployment is affected — it booted, it serves its catalog and it serves the Admin. A store
 *   that cannot yet be bought from is still a store worth reading (ADR-0048).
 * - **Declined** is a refusal too, `payment-declined`, and it leaves no Order at all: this Step
 *   runs before Capture precisely so that a Shopper whose card was refused has nothing in the
 *   Merchant's books.
 * - **A provider that throws** is a bug or an outage rather than a decision, so it travels as one
 *   and surfaces as a 500. A refusal would tell a storefront its purchase was declined when what
 *   actually happened is that the provider is unreachable.
 *
 * **The amount is Core's to compute, not a Step's to report.** It is composed from the lines,
 * their Adjustments and their tax by the same function `capture-order` writes the total with — so
 * the figure charged and the figure recorded are one expression, and cannot drift by anybody
 * forgetting to keep a running total in step.
 *
 * **Its compensation refunds, and this is where ADR-0036's unwinding meets real money.** A
 * payment taken against a Capture that fails must not keep a Shopper's money, so the compensation
 * asks the provider to give back exactly what was taken. A refund that itself throws is contained:
 * it is reported beside whatever stopped the run rather than in place of it, so the storefront
 * still learns why it was refused and an operator still learns that money is where it should not
 * be.
 */
export const takePayment = defineStep(
  "take-payment",

  async (input: ReservedLines, context): Promise<PaidOrder> => {
    const provider = context.paymentProvider;
    if (!provider) {
      throw refuse(
        "no-payment-provider",
        "This deployment has no Payment Provider configured, so it cannot take money. kobai ships none by design (ADR-0053): a Project supplies one through `payments.provider` in its `kobai.config.ts`. Everything else about this Store still works.",
      );
    }

    // In front of the money, not only in front of the write. A replaced `calculate-tax` applying
    // a percentage without rounding produces a figure no Shopper can pay and no `bigint` column
    // can hold — and charging it first and refunding it afterwards is a worse way to find out
    // than refusing to charge at all. `capture-order` asks again, because a replaced
    // `take-payment` need not have asked.
    inWholeMinorUnits(input);

    const request = {
      amount: orderTotalOf(input),
      currency: oneCurrency(input.lines),
      shopper: input.cart.shopper,
      // ADR-0013's open half, handed on untouched — a payment method token, a saved-card
      // handle, anything a real provider needs and Core has never modelled arrives this way.
      metadata: context.metadata,
    };
    const outcome = await provider.charge(request);

    if (!outcome.ok) throw refuse("payment-declined", outcome.detail);

    const payment: TakenPayment = {
      provider: provider.name,
      reference: outcome.reference,
      amount: request.amount,
      currency: request.currency,
      // Silence means the money moved, which is what `ok: true` has meant all along — so a
      // provider written before the field existed keeps meaning it and needs no edit (ADR-0019).
      received: outcome.received ?? true,
    };
    charged.push(input, { provider, payment });

    return { ...input, payment };
  },

  async (input) => {
    // Nothing taken, nothing to give back.
    const taken = charged.pop(input);
    if (taken === undefined) return;

    // Back to the provider that took it, rather than to whatever the context holds now: the money
    // is somewhere in particular, and only the system holding it can return it.
    await taken.provider.refund({
      reference: taken.payment.reference,
      amount: taken.payment.amount,
      currency: taken.payment.currency,
    });
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
 *
 * **Core composes the money here rather than trusting a Step to have done it.** A replaced
 * `apply-adjustments` says what it is adding and a replaced `calculate-tax` says what it is
 * charging; neither is asked for a total, because a Step that had to keep one in step with what
 * it changed is a Step that can forget to.
 *
 * **It has one refusal of its own, and it is the database's.** A Cart becomes exactly one Order
 * (#102), which `load-cart` checks and this index enforces — so a Capture that loses the race
 * for a Cart refuses with `cart-placed` rather than raising a constraint violation at a
 * storefront. Nothing else here is a refusal: everything a Step can decide has been decided by
 * now, which is what makes this the point of no return.
 */
export const captureOrder = defineStep(
  "capture-order",
  async (input: PaidOrder, context): Promise<Order> => {
    const currency = oneCurrency(input.lines);
    inWholeMinorUnits(input);
    const lines = input.lines.map((line) => ({
      variantId: line.variantId,
      title: line.title,
      sku: line.sku,
      unitAmount: line.unitAmount,
      currency: line.currency,
      quantity: line.quantity,
      tax: line.tax,
      // What the line came to: the goods, the Adjustments on it, and the tax on the adjusted
      // figure. Stored rather than derived, because a snapshot recomputed is not one.
      total: totalOf(line),
      metadata: line.metadata,
      adjustments: line.adjustments,
      fulfilment: line.fulfilment,
    }));
    const total = orderTotalOf(input);

    try {
      return await context.db.transaction(async (tx: Transaction): Promise<Order> => {
        // Which Variants are still there — and held, for the length of this transaction, so
        // that none of them can go while the lines are being written.
        //
        // A Merchant may delete a Variant at any moment (`catalog/delete.ts`), and this run
        // read its Cart before the Payment moved. Without this the insert below would meet a
        // foreign key pointing at a row that has just gone, and a Shopper who has *already
        // been charged* would be told the server broke. With it, the line is written with no
        // reference at all — which is precisely what `variant_id` being nullable means
        // (ADR-0009): the snapshot says what was bought and what it cost, and there is
        // nothing left to navigate to.
        //
        // Taken first, and it is the same order `catalog/delete.ts` takes its locks in; the
        // opposite order is a deadlock between a Capture and a delete over one Variant, and
        // `catalog/lock.ts` is where that order is written down.
        const stillThere = await lockVariants(
          tx,
          lines.map((line) => line.variantId),
        );

        const [written] = await tx
          .insert(order)
          .values({
            cartId: input.cart.id,
            shopperEmail: input.cart.shopper?.email ?? null,
            shopperExternalId: input.cart.shopper?.externalId ?? null,
            currency,
            total,
            metadata: input.cart.metadata,
          })
          .returning({ id: order.id });
        if (!written) throw new Error("Writing an Order returned no row.");

        // Before the lines, because a line names the Fulfilment it belongs to. One row per way
        // this Order is delivered, carrying what each Strategy answered — a snapshot, like
        // everything else about an Order (ADR-0009, ADR-0014).
        const fulfilmentIds = await writeFulfilments(tx, written.id, lines);

        const insertedLines = await tx
          .insert(orderLineItem)
          .values(
            lines.map(({ adjustments: _adjustments, fulfilment: applied, ...line }) => ({
              ...line,
              variantId: stillThere.has(line.variantId) ? line.variantId : null,
              orderId: written.id,
              fulfilmentId: fulfilmentIdOf(fulfilmentIds, applied),
            })),
          )
          // By SKU rather than by the order the rows came back in: a Cart holds one line per
          // Variant and a SKU is unique across the deployment, so this is a real correlation
          // rather than a bet on what `returning` happens to preserve.
          .returning({ id: orderLineItem.id, sku: orderLineItem.sku });
        const lineIdBySku = lineIdsBySku(insertedLines);

        const adjustments = [
          ...lines.flatMap((line) =>
            rowsFor(untaxed(line.adjustments), written.id, idOf(lineIdBySku, line.sku)),
          ),
          // The Order's own go in with a null line, which is what makes them the Order's.
          ...rowsFor(input.adjustments, written.id, null),
        ];
        // Skipped rather than run empty: an `insert … values ()` with no rows is a syntax error
        // in Postgres, and no Adjustment at all is the ordinary case.
        if (adjustments.length > 0) await tx.insert(orderAdjustment).values(adjustments);

        // The money, recorded against the Order in the same transaction that writes it — so an
        // Order and the account of what was paid for it can never exist without each other.
        // The payment itself moved a moment ago, outside any transaction, which is exactly why
        // `take-payment` is the Step that carries a compensation.
        await tx.insert(payment).values({
          orderId: written.id,
          provider: input.payment.provider,
          reference: input.payment.reference,
          amount: input.payment.amount,
          currency: input.payment.currency,
          received: input.payment.received,
        });

        // The Reservations this run has been holding since `hold-reservations`, taken for good
        // — **in this transaction**, which is the whole of ADR-0018's second half. Stock and
        // Orders cannot disagree if neither can be written without the other, so there is
        // nothing here for a compensation to undo: a failure after this line takes the Order
        // and the stock movement with it.
        await consumeReservations(tx, input.reservations, written.id);

        const captured = await readOrder(tx, written.id);
        if (!captured)
          throw new Error("An Order was written and could not be read back.");
        return captured;
      });
    } catch (cause) {
      // The other request won. `load-cart` asks the same question and this request got past
      // it, which is exactly the pair a check can never separate — so the answer comes from
      // the index the Order is written against, and the loser is told the same thing it would
      // have been told a moment earlier.
      if (violatesUniqueIndex(cause, ONE_ORDER_PER_CART)) {
        throw alreadyPlaced(input.cart.id);
      }
      throw cause;
    }
  },
);

/**
 * What this line's Fulfilment Strategy answers about it, or a refusal saying there is no such
 * Strategy here.
 *
 * A Variant may only be created pointing at a Strategy the deployment has wired, so the only way
 * to reach the refusal is for a Project to *unwire* one its Variants already point at. That is a
 * configuration change rather than a fault in anybody's request, and it is answered the way
 * `no-payment-provider` is: this Store cannot sell this thing until somebody changes the Store.
 * Refusing beats guessing — a Variant Core silently treated as `physical` would be one whose
 * stock it claimed and whose Order it recorded as shipping, neither of which anybody asked for.
 *
 * The context's Strategies are Core's own two when nothing was threaded, because that is what a
 * deployment which wired nothing has — not an empty set in which no Variant can be fulfilled.
 */
function fulfilmentOf(
  strategies: FulfilmentStrategies | undefined,
  strategy: string,
  variant: {
    readonly id: string;
    readonly sku: string;
    readonly metadata: Record<string, unknown>;
  },
): AppliedFulfilment {
  const answers = fulfilmentAnswersFor(
    strategies ?? CORE_FULFILMENT_STRATEGIES,
    strategy,
    variant,
  );
  if (!answers) {
    throw refuse(
      "unknown-fulfilment-strategy",
      `Variant ${JSON.stringify(variant.sku)} is fulfilled by ${JSON.stringify(strategy)}, and this deployment has no Fulfilment Strategy of that name. It was wired under \`fulfilment.strategies\` in this Project's \`kobai.config.ts\` when the Variant was created, and is not now.`,
    );
  }

  return { strategy, ...answers };
}

/** The unique index that makes a Cart become exactly one Order — see `db/schema.ts`. */
const ONE_ORDER_PER_CART = "core_order_cart_idx";

/**
 * Every amount about to be written is a **whole number of minor units**, or nothing is.
 *
 * Money is integer minor units everywhere in kobai — 1250 is USD 12.50 — and the columns are
 * `bigint`, so a fraction is not a rounding to argue about but a value Postgres will not hold.
 * Core's own Steps cannot produce one; a replaced `apply-adjustments` dividing a line in half,
 * or a `calculate-tax` applying a percentage without rounding, can and will.
 *
 * Asked **twice, by two Steps, and each has its own reason**. `take-payment` asks in front of the
 * money, because a fraction charged and then refunded is a worse way to discover this than a
 * charge that never happened. `capture-order` asks again in front of the write, for the same
 * reason {@link oneCurrency} does: it is the point of no return, and a deployment that replaced
 * `take-payment` need not have asked at all — the alternative is an Order half-written against a
 * database error naming a column rather than the Step that produced the value.
 *
 * It travels as a bug rather than a refusal — a refusal would tell a storefront its request was
 * declined, when what happened is that this deployment is wired to charge fractions of a penny.
 */
function inWholeMinorUnits(input: TaxedLines): void {
  const amounts = [
    ...input.adjustments.flatMap((adjustment) => [adjustment.amount, adjustment.tax]),
    ...input.lines.flatMap((line) => [
      line.unitAmount,
      line.quantity,
      line.tax,
      ...line.adjustments.map((adjustment) => adjustment.amount),
    ]),
  ];

  if (!amounts.every(Number.isSafeInteger)) {
    throw new Error(
      `This Order was priced, adjusted or taxed in something other than whole minor units: ${amounts.filter((amount) => !Number.isSafeInteger(amount)).join(", ")}. A Step of this deployment returned a fraction, and money in kobai is an integer count of the currency's minor unit.`,
    );
  }
}

/**
 * The Line Item rows just written, keyed by the SKU each one snapshotted.
 *
 * The keying is what attaches an Adjustment to the line it belongs to, so it has to be a real
 * correlation rather than a convenient one. Two lines sharing a SKU would collapse here and
 * silently move one line's money onto another, which Core's own Steps cannot produce — a Cart
 * holds one line per Variant in DDL, and a SKU is unique across the deployment — but a replaced
 * `price-lines` can. That is a bug in the Step that produced it rather than a decision the
 * Workflow made, so it travels as one and the transaction takes the Order with it.
 */
function lineIdsBySku(rows: readonly { id: string; sku: string }[]): Map<string, string> {
  const bySku = new Map(rows.map((row) => [row.sku, row.id]));
  if (bySku.size !== rows.length) {
    throw new Error(
      "This Order was captured with two Line Items carrying the same SKU, so an Adjustment on one cannot be told from an Adjustment on the other. A Step replacing `price-lines` returned a line per Variant more than once.",
    );
  }
  return bySku;
}

/**
 * The Fulfilment this line is part of. Absent is impossible and therefore worth saying out loud.
 *
 * The rows were written from these very lines a statement ago, so a miss would mean the key two
 * of them are grouped by had changed between the write and the read. Left to the column it would
 * be a `null` — the value that means "placed before Fulfilment existed" — and an Order would
 * quietly claim to be older than it is.
 */
function fulfilmentIdOf(ids: Map<string, string>, applied: AppliedFulfilment): string {
  const id = ids.get(keyOf(applied));
  if (id === undefined) {
    throw new Error(
      `An Order's Fulfilment for ${JSON.stringify(applied.strategy)} was not written back.`,
    );
  }
  return id;
}

/** The line a SKU names. Absent is impossible and therefore worth saying out loud. */
function idOf(lineIdBySku: Map<string, string>, sku: string): string {
  const id = lineIdBySku.get(sku);
  if (id === undefined) {
    throw new Error(
      `An Order's Line Item for ${JSON.stringify(sku)} was not written back.`,
    );
  }
  return id;
}

/** What one line came to: the goods, its own Adjustments, and the tax on the adjusted figure. */
function totalOf(line: TaxedLine): number {
  return line.unitAmount * line.quantity + sumOf(line.adjustments) + line.tax;
}

/**
 * What the whole Order comes to: every line total, plus the Adjustments belonging to no line and
 * the tax on each of them.
 *
 * One expression, read by **both** the Step that charges and the Step that writes — which is the
 * property worth having. A total computed twice is a total that can be computed two ways, and the
 * shape of that failure is a Shopper charged one figure while their Order records another.
 */
function orderTotalOf(input: TaxedLines): number {
  return (
    input.lines.reduce((sum, line) => sum + totalOf(line), 0) +
    input.adjustments.reduce(
      // The carriage and the tax on the carriage. An Order-level Adjustment is the only
      // Adjustment with a tax of its own, because it is the only one on no line (#117).
      (sum, adjustment) => sum + adjustment.amount + adjustment.tax,
      0,
    )
  );
}

/**
 * A line's Adjustments summed, which is all that is needed in either direction.
 *
 * A discount is a negative amount, so there is no branch here and there is deliberately none
 * anywhere else either — see {@link Adjustment.amount}. Amounts only: a line's Adjustments carry
 * no tax of their own, and {@link orderTotalOf} is where the Order's own bring theirs.
 */
function sumOf(adjustments: readonly Adjustment[]): number {
  return adjustments.reduce((sum, adjustment) => sum + adjustment.amount, 0);
}

/**
 * Adjustments as rows, keeping the order the Step produced them in.
 *
 * `position` is that order, and it is stored because Capture writes every row in one
 * transaction — nothing else about them distinguishes one from another afterwards.
 */
function rowsFor(
  adjustments: readonly TaxedAdjustment[],
  orderId: string,
  orderLineItemId: string | null,
) {
  return adjustments.map((adjustment, position) => ({
    orderId,
    orderLineItemId,
    position,
    code: adjustment.code,
    description: adjustment.description,
    amount: adjustment.amount,
    tax: adjustment.tax,
    metadata: adjustment.metadata ?? {},
  }));
}

/**
 * A line's Adjustments, as rows that carry no tax of their own.
 *
 * `calculate-tax` taxes the adjusted line, so their tax is already inside the line's own `tax`
 * and a figure on the row would be charged twice or dropped — which is why the type a Step
 * declares them with has no `tax` at all, and why the check constraint on
 * `core_order_adjustment` refuses one (#117).
 */
function untaxed(adjustments: readonly Adjustment[]): readonly TaxedAdjustment[] {
  return adjustments.map((adjustment) => ({ ...adjustment, tax: 0 }));
}

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
function oneCurrency(lines: readonly TaxedLine[]): string {
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
  .step(applyAdjustments)
  .step(calculateTax)
  .step(holdReservations)
  .step(takePayment)
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

/**
 * A Cart that has already become an Order, refused — from either of the two places that can
 * find out, so a Shopper who pressed the button twice is told the same thing whichever request
 * lost.
 */
function alreadyPlaced(cartId: string): StepFailure {
  return refuse(
    "cart-placed",
    `Cart ${JSON.stringify(cartId)} has already been placed, and a Cart becomes exactly one Order. The Order it became is still readable; start a new Cart to buy anything else.`,
  );
}

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
