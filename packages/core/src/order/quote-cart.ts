import type { WorkflowContext } from "../workflow/context.ts";
import { runSteps, type WorkflowRun } from "../workflow/run.ts";
import type { WorkflowStep } from "../workflow/workflow.ts";
import type { LoadCartRefusal } from "./load-cart.ts";
import {
  type Adjustment,
  inWholeMinorUnits,
  oneCurrency,
  orderTotalOf,
  type PlaceOrderRequest,
  type PlaceOrderWorkflow,
  type TaxedLine,
  type TaxedLines,
  totalOf,
} from "./place-order.ts";
import type { SelectShippingRefusal } from "./select-shipping.ts";

/**
 * **What a Cart comes to, asked before anything is bought** (ADR-0077).
 *
 * A storefront that is about to send a Shopper to their bank has to create the payment for a
 * figure, and until this existed there was none to create it for: `place-order` works out the
 * lines, the Adjustments and the tax at Capture, and a Cart carries no totals on purpose
 * (ADR-0009). So the amount on the intent was the storefront's own guess, and a guess that is
 * wrong buys an expensive Cart with a cheap payment.
 *
 * **This is not the total ADR-0009 refuses, and the difference is where the figure comes from.**
 * A `total` on the Cart shape would be a field on an object that is mutable, disposable and
 * unauthoritative — a number nothing stands behind, sitting on the thing everybody would read it
 * as a property of. What is here instead is an *answer to a question asked now*: it runs this
 * deployment's own `place-order` declaration as far as the tax, composes the figure with the
 * very expression Capture composes it with, and says when it did. Nothing is held, nothing is
 * charged, nothing is written, and nothing binds a later placement to it.
 *
 * **It prices through the deployment's own declaration, and that is the whole design.** The
 * Steps run are the ones `place-order` would run — the same `load-cart`, the same `price-lines`
 * invoking the deployment's `resolve-price`, the same `apply-adjustments`, the same
 * `calculate-tax`, replacements and inserted Steps included. A quote computed any other way
 * would disagree with the charge by construction for any Project that replaced a pricing Step,
 * which is the same bug this route exists to close, wearing a route's clothes.
 */

/** One Adjustment as a quote reports it: what an Order's would say, without the row's identity. */
export type QuotedAdjustment = {
  readonly code: string;
  readonly description: string;
  /** **Signed** minor units: negative discounts, positive surcharges — {@link Adjustment.amount}. */
  readonly amount: number;
  readonly metadata: Record<string, unknown>;
};

/**
 * One Adjustment on the Cart as a whole, with the tax the Step worked out for it (#117).
 *
 * The same split an Order makes, and for the same reason: a line's own Adjustments are inside
 * that line's `tax`, because tax is charged on the adjusted line — so only these carry a figure
 * of their own.
 */
export type QuotedLevelAdjustment = QuotedAdjustment & { readonly tax: number };

/** One line of the Cart, priced — what an Order's Line Item would say if it were placed now. */
export type QuoteLineItem = {
  /**
   * The **Cart's** Line Item this prices, because there is no Order and no Line Item of one.
   *
   * Named rather than `id` for exactly that reason: nothing here was created, so an `id` would
   * be the identifier of a record that does not exist.
   */
  readonly lineItemId: string;
  readonly variantId: string;
  /** As it is **now**, not as a snapshot — nothing here is frozen, because nothing is recorded. */
  readonly sku: string;
  readonly quantity: number;
  readonly unitAmount: number;
  readonly tax: number;
  readonly adjustments: readonly QuotedAdjustment[];
  /** `unitAmount` × `quantity`, plus this line's Adjustments, plus `tax` — Capture's own sum. */
  readonly total: number;
};

/**
 * What a Cart comes to, as at one instant.
 *
 * There is deliberately **no deadline on it and nothing that could be quoted back at kobai.**
 * A quote that expired would be one that was good until it did, which is a promise; a handle a
 * storefront could present at `POST /store/orders` would be the pending Order ADR-0009 refuses,
 * reached from the other side. What holds a Cart's stock is
 * `POST /store/carts/{id}/reservations`, and what decides what is charged is the placement.
 */
export type CartQuote = {
  readonly cartId: string;
  /** ISO 4217, and the one currency every amount here is in. */
  readonly currency: string;
  /** In the Cart's own order — the order `GET /store/carts/{id}` reports its lines in. */
  readonly lineItems: readonly QuoteLineItem[];
  /** The ones belonging to no line: a basket-wide discount, a delivery surcharge (ADR-0022). */
  readonly adjustments: readonly QuotedLevelAdjustment[];
  /** What the whole Cart comes to, composed by the expression Capture composes a total with. */
  readonly total: number;
  /**
   * When this was worked out — the whole of what makes the answer a quote rather than a promise.
   *
   * Read in this process rather than from Postgres, unlike a Cart's deadline: a deadline is
   * compared against later and so has to come from the clock that will judge it, and nothing
   * ever compares against this one.
   */
  readonly quotedAt: Date;
};

/**
 * Every way Core's own Steps can refuse a quote.
 *
 * `place-order`'s minus everything the pricing half never reaches: no payment is asked for, so
 * `no-payment-provider` and `payment-declined` are unreachable, and nothing is claimed, so a
 * Reservation provider is never asked either. What is left is reading the Cart, pricing its
 * lines and deciding what it costs to deliver — and `resolve-price`'s own refusals travel out of
 * `price-lines` as themselves, exactly as they do when an Order is placed, so the store surface
 * maps them the same way.
 *
 * **`select-shipping`'s two are in the prefix and so are here** (#321), which is what makes *this
 * Cart has nowhere to be sent* reachable from the quote as well as from the placement — the
 * property ADR-0077 exists for, arriving at a refusal rather than at a figure.
 */
export type QuoteCartRefusal = LoadCartRefusal | SelectShippingRefusal;

/**
 * The slot the pricing half ends **before**, and the one place that boundary is written down.
 *
 * Everything from here on *does* something — claims stock, moves money, writes an Order — and a
 * quote does none of the three. Expressing it as "before the first Step that acts" rather than
 * as "the first four" is what keeps it true for a deployment that inserted a Step of its own
 * into the pricing half: an inserted Step sits at a position of its own, so counting would drop
 * it and stop the quote short of the tax it is asking for.
 */
const FIRST_SLOT_THAT_ACTS = "hold-reservations";

/**
 * This deployment's declaration, up to the point where placing an Order starts doing things.
 *
 * The declaration is read off the *value* the surface was handed — Core's own, or the one the
 * Project's config rebuilt — so a replaced `price-lines` and a Step inserted after
 * `apply-adjustments` are both in the prefix, and a quote and a placement run the same code.
 *
 * A declaration with no such slot is a bug rather than a configuration: `rewireWorkflow` cannot
 * remove one and the type says which Workflow this is, so the only way here is somebody having
 * renamed the slot in Core without reading this. It throws for that reason — a quote that
 * silently ran the whole of `place-order` would charge a Shopper for asking a question.
 */
function pricingStepsOf(workflow: PlaceOrderWorkflow): readonly WorkflowStep[] {
  const acts = workflow.steps.findIndex((entry) => entry.slot === FIRST_SLOT_THAT_ACTS);
  if (acts === -1) {
    throw new Error(
      `The Workflow ${JSON.stringify(workflow.name)} has no Step ${JSON.stringify(FIRST_SLOT_THAT_ACTS)}, so there is no point at which quoting a Cart could stop before it starts claiming stock and taking money.`,
    );
  }
  return workflow.steps.slice(0, acts);
}

/**
 * Runs the pricing half of this deployment's `place-order`, and composes what it produced.
 *
 * The result is a {@link WorkflowRun} rather than a plain value because a refusal is an ordinary
 * answer here — a Cart that has expired, a line whose Variant has lost its Price — and because
 * the Steps that ran are part of what a caller is told, for the reason a resolved price reports
 * them: it is what lets a Developer who replaced a Step see that theirs ran.
 *
 * **Two things are asked of the figures before they are reported, and both are Capture's own
 * questions asked earlier.** {@link oneCurrency} rejects a deployment whose Steps priced one
 * Cart two ways, and {@link inWholeMinorUnits} rejects one that produced a fraction of a penny —
 * each a bug in a Step rather than a decision the Workflow made, so each travels as one. Asking
 * them here means a storefront finds out before it creates a payment for the answer, rather than
 * at the placement.
 */
export async function quoteCart(
  workflow: PlaceOrderWorkflow,
  request: PlaceOrderRequest,
  context: WorkflowContext,
): Promise<WorkflowRun<CartQuote>> {
  // The cast is the one the runner already makes at every Step boundary, and it is sound for
  // the reason the declaration exists: `calculate-tax` produces `TaxedLines`, a replacement may
  // neither widen nor narrow that, and an inserted Step takes and gives the value flowing past
  // it — so what is in hand where `hold-reservations` would have been given something is a
  // `TaxedLines` whatever this deployment wired.
  const run = await runSteps<TaxedLines>(pricingStepsOf(workflow), request, context);
  if (!run.ok) return run;

  return { ok: true, output: quoteOf(run.output), steps: run.steps };
}

/** What the Steps produced, as the answer a storefront reads. */
function quoteOf(priced: TaxedLines): CartQuote {
  inWholeMinorUnits(priced);

  return {
    cartId: priced.cart.id,
    currency: oneCurrency(priced.lines),
    lineItems: priced.lines.map(quotedLine),
    adjustments: priced.adjustments.map((adjustment) => ({
      ...quotedAdjustment(adjustment),
      tax: adjustment.tax,
    })),
    total: orderTotalOf(priced),
    quotedAt: new Date(),
  };
}

function quotedLine(line: TaxedLine): QuoteLineItem {
  return {
    lineItemId: line.id,
    variantId: line.variantId,
    sku: line.sku,
    quantity: line.quantity,
    unitAmount: line.unitAmount,
    tax: line.tax,
    adjustments: line.adjustments.map(quotedAdjustment),
    // The line's own sum, from the function that writes an Order's `total` — so the two agree
    // by construction rather than by two implementations of the same arithmetic.
    total: totalOf(line),
  };
}

/** An Adjustment a Step described, with the empty bag Capture would have written for it. */
function quotedAdjustment(adjustment: Adjustment): QuotedAdjustment {
  return {
    code: adjustment.code,
    description: adjustment.description,
    amount: adjustment.amount,
    metadata: adjustment.metadata ?? {},
  };
}
