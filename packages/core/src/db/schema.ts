import { sql } from "drizzle-orm";
import { boolean, check, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Core's tables. Every one of them is prefixed `core_`, which is what this package's
 * `tablesFilter` is scoped to.
 *
 * Core's schema shape is explicitly **not** part of the stability promise (ADR-0003). A
 * Plugin may not add a column here; a Project may add columns to its own tables freely.
 */

/**
 * The Store — the single commercial identity this deployment represents.
 *
 * A **singleton**, enforced in DDL rather than by convention: the primary key is a boolean
 * pinned to `true`, so the table can physically hold at most one row and there is no
 * identifier for anything else to point at. That is deliberate. One deployment serves
 * exactly one Store (ADR-0005), so the Store is never a scoping key, never a foreign key on
 * another entity, and never appears in a `where` clause. If it starts to, multi-tenancy is
 * being smuggled in.
 */
export const store = pgTable(
  "core_store",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    name: text("name").notNull(),
    /** ISO 4217, e.g. `USD`. The Store's default — Regions carry their own, later. */
    defaultCurrency: text("default_currency").notNull(),
    /**
     * ADR-0004's cheap escape hatch: unindexed and untyped by design, for the case where
     * someone just needs to stash a field. A Plugin that needs an index or a type needs its
     * own table.
     */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("core_store_is_singleton", sql`${table.singleton}`),
    check(
      "core_store_currency_is_iso4217",
      sql`char_length(${table.defaultCurrency}) = 3`,
    ),
  ],
);

export type StoreRow = typeof store.$inferSelect;
