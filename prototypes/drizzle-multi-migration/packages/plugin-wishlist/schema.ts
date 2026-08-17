// PROTOTYPE. A second plugin, to prove two plugins don't collide with each other either.
import { pgTable, uuid, text } from "drizzle-orm/pg-core";

export const wishlistEntry = pgTable("wishlist_entry", {
  id: uuid("id").primaryKey().defaultRandom(),
  variantId: uuid("variant_id").notNull(), // → core_variant.id, by ID, no FK constraint
  shopperEmail: text("shopper_email").notNull(),
});
