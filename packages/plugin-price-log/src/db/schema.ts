import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

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
 * - no `updated_at`, and none of Core's machinery for one. Core advances that column with a
 *   trigger on every table of its own that carries it (ADR-0037); whether a Plugin does the
 *   same is **the Plugin's business**, because a Plugin owns its tables and Core reaching in
 *   to attach a trigger would be ADR-0004's line crossed from the wrong side. A Plugin that
 *   wants the guarantee writes its own function and its own trigger in its own migration
 *   set — not by calling Core's `core_set_updated_at()`, which is a detail of a schema Core
 *   has promised nothing about (ADR-0003, ADR-0019) and may rename without a version bump.
 *
 * Every table here is prefixed `price_log_`, which is what this package's `tablesFilter` is
 * scoped to.
 */

/**
 * One record of a price having been resolved — written by the Step this Plugin offers.
 *
 * `amount` and `currency` arrived after this table shipped, added when the Step that writes
 * rows here was built. Nothing in Core moved to make room for them, and no Core migration
 * mentions them: a Plugin's schema evolves on its own timetable, in its own migration set,
 * which is the property the whole no-foreign-key rule buys (ADR-0004).
 *
 * They arrived in **three** migrations, and that is the part worth copying (ADR-0038). Both
 * columns are `notNull()` here, but `ALTER TABLE … ADD COLUMN … NOT NULL` — which is the one
 * statement drizzle-kit generates from a declaration like this — is refused by Postgres
 * against a table that already holds a single row, because the column must have a value for
 * each of them and the statement offers none. Under ADR-0030 this set runs against a live
 * database at boot, and a failed migration refuses to start the application, so the Project
 * that hit it would get no service rather than a bad column. So:
 *
 * 1. `0001_widen_with_amount_and_currency` — **generated**, from these two fields written
 *    without `.notNull()`. Adding a nullable column is safe at any size.
 * 2. `0002_backfill_amount_and_currency` — **hand-written**, as a `--custom` migration,
 *    because it changes data rather than schema and drizzle-kit's diff can neither write it
 *    nor miss it. It sets the rows that predate the columns to `0` and ISO 4217's `XXX`,
 *    the code for "no currency involved" — the only honest thing to say about a resolution
 *    recorded before anything recorded amounts.
 * 3. `0003_require_amount_and_currency` — **generated**, from `.notNull()` going back on.
 *
 * That leaves no column DEFAULT behind, which is deliberate: a default would silently supply
 * `0 XXX` to a future row whose writer forgot the amount, and a log that invents prices is
 * worse than one that refuses to be written. `migrations.test.ts` beside this file proves
 * the whole sequence against a table seeded with a row first.
 *
 * `resolved_at` and no `updated_at`, which is this Plugin's answer to the question above
 * rather than an omission: a row here records that something happened, and is never updated.
 * A column that would never move is worse than no column — it is the defect ADR-0037 was
 * written against, kept alive by convention.
 */
export const priceLogEntry = pgTable("price_log_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The Variant whose price was resolved — Core's row, by ID, with no foreign key onto it.
   * `text` rather than a type borrowed from Core, because borrowing one would be depending
   * on a shape Core has not promised (ADR-0003).
   */
  variantId: text("variant_id").notNull(),
  /** Minor units of `currency`, copied as served — 1250 is `USD` 12.50. */
  amount: integer("amount").notNull(),
  currency: text("currency").notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PriceLogEntryRow = typeof priceLogEntry.$inferSelect;
