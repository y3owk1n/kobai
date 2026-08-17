// PROTOTYPE. A plugin's tables. Note what is deliberately absent: any import of Core's
// schema, and any .references() into it. ADR-0004 — reference Core rows by ID only.
import { pgTable, uuid, text, integer } from "drizzle-orm/pg-core";

export const reviewsReview = pgTable("reviews_review", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id").notNull(), // → core_variant.id, by ID, no FK constraint
  rating: integer("rating").notNull(),
  body: text("body"),
});
