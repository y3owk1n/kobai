// PROTOTYPE. Check D: the reviews plugin evolves independently. One added column.
import { pgTable, uuid, text, integer, boolean } from "drizzle-orm/pg-core";

export const reviewsReview = pgTable("reviews_review", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id").notNull(),
  rating: integer("rating").notNull(),
  body: text("body"),
  verifiedPurchase: boolean("verified_purchase").notNull().default(false), // ← new in v2
});
