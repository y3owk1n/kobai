import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * This Project's own tables.
 *
 * The asymmetry here is the teachable rule, and it is the other half of the comment in
 * `@kobai/plugin-price-log`'s schema. A **Plugin** may not add a column to a Core table:
 * Core's tables are closed to it (ADR-0004), because a Plugin ships to Projects it has
 * never seen and Core has to stay free to alter its own schema. A **Project** is under no
 * such rule — it owns its repository, its database and its own migration set, so it adds
 * whatever columns it likes to whatever tables it owns, on its own timetable.
 *
 * That freedom needs somewhere to be exercised or it is only a claim, which is what this
 * table is for. Adding a column to it is two steps and no coordination with anybody:
 * write the column here, then `devbox run db:generate`. Nothing in Core moves, no Plugin
 * is consulted, and the migration lands in this Project's own set, tracked in this
 * Project's own table.
 *
 * Every table here is prefixed `project_`, which is what `drizzle.config.ts` scopes this
 * Project's `tablesFilter` to — so a generate here can never write a migration touching
 * Core's tables or a Plugin's.
 */

/**
 * A note a Merchant left against a Variant — this Project's idea, and Core has never heard
 * of it.
 *
 * It is deliberately something Core does **not** model, because a Project-owned table that
 * duplicated a Core one would prove nothing. Core knows about Variants; it does not know
 * that this deployment wants to scribble on them, and it does not need to.
 */
export const projectVariantNote = pgTable("project_variant_note", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * The Variant this note is about — Core's row, **by ID, with no foreign key onto it**.
   *
   * A Project *may* put a foreign key here, unlike a Plugin, and this one deliberately does
   * not: the constraint would tie this table's migrations to Core's table still being
   * called what it is called today, which is exactly the coupling that makes an upgrade a
   * merge instead of a version bump (ADR-0001).
   */
  variantId: text("variant_id").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectVariantNoteRow = typeof projectVariantNote.$inferSelect;
