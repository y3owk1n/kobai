import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * This Plugin's tables. There is one, and there is meant to be one.
 *
 * The absences are the same ones `@kobai/plugin-price-log`'s and
 * `@kobai/plugin-made-to-order`'s schemas spell out, and they are the point (ADR-0004):
 *
 * - no import of Core's schema and no `.references()` into it. Core's rows — a Cart, here —
 *   are referenced **by ID** and never by foreign key, which is what keeps Core free to alter
 *   its own tables and what makes install order irrelevant.
 * - no column added to a Core table. A Plugin cannot; a **Project** can, because it owns its
 *   own repository and its own migrations.
 * - no `updated_at`, and none of Core's machinery for one. Whether a Plugin's table advances
 *   such a column is the Plugin's business (ADR-0037), and a row here records that money was
 *   given back at a moment. It is never updated.
 *
 * Every table here is prefixed `stripe_`, which is what this package's `tablesFilter` is
 * scoped to.
 */

/**
 * One payment this Plugin gave back because the purchase it paid for never became an Order.
 *
 * **Why this Plugin owns a table at all, when Core owns the Payment record.** Core's record
 * exists for money that produced an Order (ADR-0053, ADR-0056), and this table is for exactly
 * the money that did not. A redirect method like FPX is a real-time debit — the funds leave
 * when the Shopper authorises at their bank — so a hold that lapses while they are in a banking
 * app produces a confirmed payment meeting a refused placement. Core answered that refusal and
 * wrote nothing, so Core does not refund and Core has nothing to record; the Plugin made the
 * payment and the Plugin reverses it, here (ADR-0070). Without this table the only account of
 * that money is Stripe's, and a Merchant's books have to agree with Stripe's from somewhere.
 *
 * It is deliberately **not** an account of every refund this Plugin makes. The other one —
 * `take-payment`'s compensation, when a Step after it fails inside `place-order` — reaches this
 * Plugin through `PaymentProvider.refund`, which Core hands a reference, an amount and a
 * currency and no database at all, so there is nothing there to write with and Core promises a
 * provider none. That is a named limit rather than an omission: the case this table exists for
 * is the one where kobai never learned the money existed, and it is the one a Merchant cannot
 * reconstruct — Core's own refusal reaches the caller, and an unwound `place-order` reports
 * what it did.
 *
 * `payment_intent_id` is unique, and that is what makes a duplicated webhook safe in the books
 * rather than only at Stripe. The Shopper's return and the provider's webhook race into the
 * same placement (ADR-0070), so both can meet the same refusal and both can ask for the same
 * refund; Stripe's idempotency key answers the second with the first refund, and this
 * constraint keeps the second from becoming a second row saying the same money went back twice.
 */
export const stripeUnplacedRefund = pgTable("stripe_unplaced_refund", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The Cart whose placement was refused — Core's row, by ID, with no foreign key onto it.
   * `text` rather than a type borrowed from Core, because borrowing one would be depending on
   * a shape Core has not promised (ADR-0003).
   */
  cartId: text("cart_id").notNull(),
  /**
   * The PaymentIntent that was confirmed — Stripe's own handle, and the same string this
   * Plugin's `charge` answers with as a `reference`. It is what a Merchant quotes to find this
   * money in Stripe's dashboard.
   */
  paymentIntentId: text("payment_intent_id").notNull().unique(),
  /** Stripe's handle on the refund itself, which is the other half of that reconciliation. */
  refundId: text("refund_id").notNull(),
  /**
   * Minor units of `currency` — what Stripe reported it actually gave back, rather than what
   * this Plugin asked for. The two agree today and the books should record the answer.
   */
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  /**
   * Why kobai refused the placement, verbatim — `insufficient-stock` is the case this whole
   * mechanism was written for, and it is not the only refusal `POST /store/orders` can make.
   * Stored as sent, because it is Core's word and this Plugin has no business normalising it.
   */
  refusal: text("refusal").notNull(),
  refundedAt: timestamp("refunded_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StripeUnplacedRefundRow = typeof stripeUnplacedRefund.$inferSelect;
