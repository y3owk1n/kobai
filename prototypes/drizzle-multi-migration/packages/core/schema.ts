// PROTOTYPE. Core's tables. Core knows nothing about any plugin.
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const coreProduct = pgTable("core_product", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const coreVariant = pgTable("core_variant", {
  id: uuid("id").primaryKey().defaultRandom(),
  // A FK *within* Core is fine — it's ADR-0004's rule about plugins reaching in that matters.
  productId: uuid("product_id")
    .notNull()
    .references(() => coreProduct.id),
  sku: text("sku").notNull(),
});
