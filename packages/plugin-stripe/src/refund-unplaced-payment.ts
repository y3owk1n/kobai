import type { Database } from "@kobai/core";
import { eq } from "drizzle-orm";
import {
  callStripe,
  integerOrUndefined,
  type StripeOptions,
  stringOrUndefined,
} from "./api.ts";
import { type StripeUnplacedRefundRow, stripeUnplacedRefund } from "./db/schema.ts";
import { STRIPE_CART_ID_KEY } from "./payments.ts";

/**
 * The Project's ask, and the one operation on this Plugin that Core's interface has no room
 * for.
 *
 * **Why the Project asks rather than Core.** A hold can lapse while a Shopper is in a banking
 * app, so a payment that really was confirmed can meet a placement kobai refuses. Core answered
 * that refusal and wrote nothing — no Payment, no Order, nothing to unwind — so refunding from
 * inside Core would mean putting money-moving logic in the one place ADR-0053 keeps it out of,
 * for an Order that never existed. The Plugin made the payment and the Plugin reverses it
 * (ADR-0070), and the thing that knows a placement was refused is the Project's own route: the
 * webhook handler, or whatever the Shopper returns to.
 *
 * ```ts
 * const placed = await kobai.fetch(placeOrder(cartId, paymentIntentId));
 * if (!placed.ok) {
 *   await stripe.refundUnplacedPayment({
 *     db: kobai.db,
 *     reference: paymentIntentId,
 *     cartId,
 *     refusal: (await placed.json()).reason,
 *   });
 * }
 * ```
 */
export type UnplacedPaymentRefund = {
  /**
   * Where the row goes — the Project's own handle, `kobai.db`.
   *
   * Given per call rather than held by this Plugin, because a Plugin that opened its own pool
   * would be a second connection to a database it does not own, and because the handle does
   * not exist until `createKobai` has run while `kobai.config.ts` is read before it. It also
   * leaves a Project free to pass a transaction of its own.
   */
  readonly db: Database;
  /** The PaymentIntent that was confirmed — the same string `charge` answers with. */
  readonly reference: string;
  /** The Cart whose placement was refused. */
  readonly cartId: string;
  /** kobai's own word for why, recorded verbatim — `insufficient-stock` is the case in view. */
  readonly refusal: string;
};

/**
 * Give the whole payment back, and write down that it happened.
 *
 * In that order, and it matters: a row here means the money went back, so writing one for a
 * refund Stripe declined would put a Merchant's books further from Stripe's than having no row
 * at all. A refusal from Stripe therefore throws and leaves the table untouched — the Project
 * is the only thing that can decide what to do about money it could not return.
 *
 * Both callers of `POST /store/orders` can meet the same refusal and so can both arrive here,
 * which is what the two safeguards are for. Stripe's `Idempotency-Key` makes the second ask
 * answer with the first refund rather than making a second one; the unique constraint on
 * `payment_intent_id` makes the second write find the row already there instead of claiming
 * the same money went back twice. Neither alone is enough — the first keeps Stripe honest, the
 * second keeps the books honest — and what comes back is the one row either way.
 */
export async function refundUnplacedPayment(
  options: StripeOptions,
  { db, reference, cartId, refusal }: UnplacedPaymentRefund,
): Promise<StripeUnplacedRefundRow> {
  const result = await callStripe(options, {
    method: "POST",
    path: "/v1/refunds",
    form: {
      payment_intent: reference,
      // No `amount`: the whole payment goes back, and what it came to is Stripe's to say.
      // Core never took this one, so kobai holds no figure that is not a guess.
      metadata: { [STRIPE_CART_ID_KEY]: cartId, kobaiRefusal: refusal },
    },
    idempotencyKey: `kobai-unplaced-refund-${reference}`,
  });

  if (!result.ok) {
    throw new Error(
      `Stripe would not refund ${reference}, whose placement kobai refused with ${JSON.stringify(refusal)}: ${result.error.message ?? "it said nothing about why."}`,
    );
  }

  const refundId = stringOrUndefined(result.body.id);
  const amount = integerOrUndefined(result.body.amount);
  const currency = stringOrUndefined(result.body.currency);
  if (refundId === undefined || amount === undefined || currency === undefined) {
    throw new Error(
      `Stripe refunded ${reference} and answered without an id, an amount or a currency, so there is nothing to write down.`,
    );
  }

  const [written] = await db
    .insert(stripeUnplacedRefund)
    .values({
      cartId,
      paymentIntentId: reference,
      refundId,
      amount,
      // Stripe's currencies are lower case; kobai writes ISO 4217 as ISO 4217 writes it, and
      // a Merchant reconciling this against an Order should not have to notice the difference.
      currency: currency.toUpperCase(),
      refusal,
    })
    .onConflictDoNothing({ target: stripeUnplacedRefund.paymentIntentId })
    .returning();

  // Nothing written means this payment was already recorded — the other caller got here
  // first. The row it wrote is the answer to this call too.
  return written ?? (await existingRefund(db, reference));
}

async function existingRefund(
  db: Database,
  reference: string,
): Promise<StripeUnplacedRefundRow> {
  const [row] = await db
    .select()
    .from(stripeUnplacedRefund)
    .where(eq(stripeUnplacedRefund.paymentIntentId, reference));

  if (row === undefined) {
    // Only reachable if something deleted the row between the insert and this read, which is
    // nothing this Plugin does. Saying so beats returning a shape nobody wrote.
    throw new Error(
      `Stripe refunded ${reference} and this Plugin could not find or write the record of it.`,
    );
  }
  return row;
}
