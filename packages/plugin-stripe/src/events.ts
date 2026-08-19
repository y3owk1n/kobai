import { cartIdOfPaymentIntent } from "./metadata.ts";

/**
 * Reading Stripe's own events, for the route a **Project** mounts.
 *
 * A Plugin cannot add one — routes are not one of ADR-0003's five Extension Points — and here
 * that is the right shape rather than a limit (ADR-0070): signature verification, logging and
 * whatever a bank does that nobody anticipated belong to the deployment. What a Project should
 * not have to write is Stripe's shapes, so this module is the half of the webhook that is
 * this Plugin's: which payment an event is about, and whether it is one that settles anything.
 */

/**
 * The event type that means the money has left the Shopper's bank.
 *
 * **One type, deliberately.** `payment_intent.processing` says a payment is on its way and
 * `payment_intent.created` says nothing at all, and placing an Order for either would be
 * writing kobai's immutable record of a completed purchase (ADR-0009) before the purchase
 * completed. A Project that wants to hear about more subscribes to more and reads the id
 * itself; what this answers for is the one event a placement may follow.
 */
export const STRIPE_SETTLING_EVENT_TYPE = "payment_intent.succeeded";

/**
 * Which payment an event is about, or `null` for one that settles nothing.
 *
 * `null` covers the two ordinary cases and they are worth telling apart in the reading rather
 * than in the answer: an event of some other type, and a payment in this Store's Stripe
 * account that kobai never started — a subscription, a payment link, an invoice. A Store's
 * endpoint is told about every event it subscribed to, so both arrive at a Project that has
 * done nothing wrong, and both are **acknowledged rather than acted on**.
 *
 * Takes `unknown` deliberately: what arrives at a webhook is a parsed JSON body, and asking a
 * Project to assert a type before it may ask this question would be asking it to trust exactly
 * the shape this Plugin is here to check.
 */
export function paymentIntentIdOfEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) return null;
  if ((event as { type?: unknown }).type !== STRIPE_SETTLING_EVENT_TYPE) return null;

  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;

  const intent = (data as { object?: unknown }).object;
  // The Cart is what makes this kobai's payment at all. Without it there is nothing to place
  // and nothing to settle, so the event is a stranger's however well-formed it is.
  if (cartIdOfPaymentIntent(intent) === null) return null;

  const id = (intent as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : null;
}
