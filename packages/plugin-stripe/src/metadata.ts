/**
 * The two keys this Plugin reads and writes, and the one thing it does with them.
 *
 * A module of their own because both halves of the Plugin need them and neither owns them:
 * {@link ./payments.ts | the provider} writes the Cart onto an intent and reads the intent off
 * an order, and {@link ./refund-unplaced-payment.ts | the refund} writes the Cart again onto
 * what it gives back. Keeping them here is what stops those two importing each other.
 */

/**
 * The key the PaymentIntent's id travels under on `POST /store/orders`.
 *
 * ADR-0013's open context: everything the caller sent that Core does not model reaches a
 * provider verbatim in `PaymentRequest.metadata`, and this is the one key this Plugin reads
 * out of it. Both callers send it — the Shopper's returning browser and the Project's webhook
 * route — because both are making the same kobai call (ADR-0070).
 */
export const STRIPE_PAYMENT_INTENT_KEY = "stripePaymentIntent";

/**
 * The key the Cart identifier travels under in a PaymentIntent's `metadata`.
 *
 * Stripe hands the whole intent — metadata included — to a webhook, and the Cart is the only
 * thing that says which purchase a payment was for. So this is what turns
 * `payment_intent.succeeded` into `POST /store/orders` for a Cart, and it is what makes the
 * Shopper's return and the webhook the *same* kobai call rather than two designs (ADR-0070).
 */
export const STRIPE_CART_ID_KEY = "kobaiCartId";

/**
 * The Cart a PaymentIntent was created for, or `null` for one this Plugin did not start.
 *
 * What a Project's webhook route reaches for. Stripe delivers `payment_intent.succeeded` with
 * the intent as `data.object` and nothing else, so this is how the event becomes a
 * `POST /store/orders` for a particular Cart — and `null` is what lets a Project ignore the
 * payments in its Stripe account that kobai never started, rather than having to guess.
 *
 * Takes `unknown` deliberately: what arrives at a webhook is a parsed JSON body, and asking a
 * Project to assert a type before it may ask this question would be asking it to trust a
 * shape Stripe promises and this Plugin can check.
 */
export function cartIdOfPaymentIntent(intent: unknown): string | null {
  if (typeof intent !== "object" || intent === null) return null;
  const metadata = (intent as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;

  const cartId = (metadata as Record<string, unknown>)[STRIPE_CART_ID_KEY];
  return typeof cartId === "string" && cartId !== "" ? cartId : null;
}
