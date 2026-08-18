import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * This Plugin's tables. There is one, and there is meant to be one.
 *
 * The absences are the same ones `@kobai/plugin-price-log`'s schema spells out, and they are
 * the point (ADR-0004):
 *
 * - no import of Core's schema and no `.references()` into it. Core's rows are referenced **by
 *   ID** and never by foreign key, which is what keeps Core free to alter its own tables — and
 *   what makes install order irrelevant, because Postgres then imposes no ordering between one
 *   package's migration set and another's.
 * - no column added to a Core table. A Plugin cannot; a **Project** can, because it owns its
 *   own repository and its own migrations.
 * - no `updated_at`, and none of Core's machinery for one. Whether a Plugin's table advances
 *   such a column is the Plugin's business (ADR-0037), and this one has no use for it: a row
 *   here records that a surcharge was applied to a placement, and is deleted rather than
 *   updated when that placement is unwound.
 *
 * Every table here is prefixed `made_to_order_`, which is what this package's `tablesFilter`
 * is scoped to.
 */

/**
 * One Lead Time surcharge, as it was applied — written by the Step this Plugin offers.
 *
 * **Why a Plugin that only adds an Adjustment keeps a table at all.** The Adjustment itself
 * lands on the Order, where Core keeps it (ADR-0022), and Core's row is the record of what was
 * charged. This is the record of what was *asked for*: the lead time the caller requested and
 * the terms in force when it was priced, neither of which Core models and neither of which the
 * Adjustment's own amount can be worked back to. That is exactly the sort of thing ADR-0004
 * says belongs to the Plugin that knows about it.
 *
 * A row is written before the Order exists — `apply-adjustments` runs well in front of Capture
 * — so it names the **Cart**, which is what a placement is identified by at that point. A
 * placement that fails after this Step has run takes its rows with it, through the Step's
 * compensation (ADR-0036).
 */
export const madeToOrderSurcharge = pgTable("made_to_order_surcharge", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The Cart this surcharge was applied to — Core's row, by ID, with no foreign key onto it.
   * `text` rather than a type borrowed from Core, because borrowing one would be depending on
   * a shape Core has not promised (ADR-0003).
   */
  cartId: text("cart_id").notNull(),
  /** The Variant the surcharged line was for, on the same terms. */
  variantId: text("variant_id").notNull(),
  /** What the caller asked for, in days, as this Plugin read it out of the open context. */
  requestedLeadTimeDays: integer("requested_lead_time_days").notNull(),
  /** The lead time this Plugin's terms treat as ordinary, recorded because terms change. */
  standardLeadTimeDays: integer("standard_lead_time_days").notNull(),
  /** Minor units of `currency` — what the Adjustment came to for this line. */
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MadeToOrderSurchargeRow = typeof madeToOrderSurcharge.$inferSelect;
