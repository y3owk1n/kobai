/**
 * `@kobai/plugin-stripe` — taking money is a dependency and a config line.
 *
 * kobai ships no Payment Provider at all, deliberately (ADR-0053): Core defines
 * `PaymentProvider` and implements it nowhere, so that dependency substitution has an
 * implementation from outside kobai rather than another of Core's own. The cost of that
 * decision is that the first thing every Developer would otherwise write is the payment
 * integration, and ADR-0069's bar is that an agency can build a client's storefront without
 * writing a Plugin. This package is what pays it.
 *
 * **PaymentIntents with `automatic_payment_methods`** — one integration covering cards, FPX and
 * GrabPay, with Elements in whatever storefront a Developer builds. Which methods a Shopper is
 * offered is decided by Stripe from the intent's currency and the Store's own dashboard, so
 * "FPX only for MYR" needs no kobai code at all and adding a method is a setting rather than a
 * release. Hosted Checkout was rejected: it would put the purchase on pixels kobai does not own
 * (ADR-0002), and would make the API prove less (ADR-0070).
 *
 * **Installing it changes nothing.** Every export below is inert until a Project names it in
 * `kobai.config.ts` (ADR-0017) — the migration set for the table, the provider for the money:
 *
 * ```ts
 * const stripe = stripePayments({ secretKey: process.env.STRIPE_SECRET_KEY ?? "" });
 *
 * export default defineKobaiConfig({
 *   migrationSets: [stripeMigrationSet],
 *   payments: { provider: stripe },
 * });
 * ```
 *
 * **The three calls a Project makes itself**, because a Plugin may not add a route — routes are
 * not one of ADR-0003's five Extension Points, and here that is the right shape (ADR-0070):
 *
 * - {@link stripePayments}'s `startPayment`, from the Project route a storefront calls before
 *   sending the Shopper to their bank. It puts the Cart in the intent's metadata.
 * - {@link cartIdOfPaymentIntent}, in the Project's own `/webhooks/stripe` route, so signature
 *   verification and logging stay the Project's. It is what turns the event into a
 *   `POST /store/orders` for a Cart.
 * - {@link stripePayments}'s `refundUnplacedPayment`, when that placement is refused. A hold can
 *   lapse while a Shopper is in a banking app, and a real-time debit has already taken the money
 *   by then; Core answered a refusal and wrote nothing, so the Plugin gives it back and records
 *   what it did in {@link stripeUnplacedRefund} — its own table, under ADR-0004.
 *
 * `PaymentProvider` and `PaymentOutcome` are untouched by any of it. `charge` is still only ever
 * called after the redirect completed and still answers `ok` or `declined`, because the
 * **Project** starts the payment rather than Core (ADR-0070).
 */
/**
 * How this Plugin reaches Stripe — the secret key, and the two seams a deployment may move:
 * where Stripe is, and the `fetch` every call goes through. Nothing else from that module is
 * on this surface, because everything else there is how a request is built rather than
 * something a Project says (ADR-0019).
 */
export type { StripeOptions } from "./api.ts";
export type { StripeUnplacedRefundRow } from "./db/schema.ts";
export { stripeUnplacedRefund } from "./db/schema.ts";
export { stripeMigrationSet } from "./migration-set.ts";
export type {
  StartedPayment,
  StartPaymentRequest,
  StripePaymentProvider,
} from "./payments.ts";
export {
  cartIdOfPaymentIntent,
  STRIPE_CART_ID_KEY,
  STRIPE_PAYMENT_INTENT_KEY,
  stripePayments,
} from "./payments.ts";
export type { UnplacedPaymentRefund } from "./refund-unplaced-payment.ts";
