import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * This Plugin's tables. There is one, and there is meant to be one.
 *
 * Note what is deliberately **absent**, because the absences are the point (ADR-0004):
 *
 * - no import of Core's schema, and no `.references()` into it. A Plugin references Core
 *   rows **by ID**, never by foreign-key constraint. That is what keeps Core free to alter
 *   its own tables — and, as the prototype found, it is also what makes install order
 *   irrelevant: with no FK crossing the boundary, Postgres imposes no ordering on the
 *   migration sets, so a Plugin's may apply before Core's.
 * - no column added to a Core table. A Plugin cannot; a **Project** can, because it owns its
 *   own repository and its own migrations. That asymmetry is the teachable rule.
 *
 * Every table here is prefixed `price_log_`, which is what this package's `tablesFilter` is
 * scoped to.
 */

/**
 * One record of a price having been resolved.
 *
 * It carries no amount yet, because Price does not exist yet — this Plugin is here to prove
 * that a Plugin can own a table, not to be useful. The Step that writes rows into it arrives
 * with the price-resolution Workflow; a Plugin *offers* that Step and the Project wires it
 * (ADR-0017).
 */
export const priceLogEntry = pgTable("price_log_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The Variant whose price was resolved — Core's row, by ID, with no foreign key onto it.
   * `text` rather than a type borrowed from Core, because borrowing one would be depending
   * on a shape Core has not promised (ADR-0003).
   */
  variantId: text("variant_id").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PriceLogEntryRow = typeof priceLogEntry.$inferSelect;
