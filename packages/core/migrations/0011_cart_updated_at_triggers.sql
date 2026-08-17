-- `updated_at` on the two tables 0010 created — the second half of adding a Core table.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- Named rather than swept, unlike 0009: that migration was repairing a rule across seven tables
-- that already existed, and this one is finishing two tables this release added. A sweep here
-- would silently adopt whatever else happened to be in the schema, which is a different and
-- larger claim than the one being made.
CREATE TRIGGER core_cart_set_updated_at
  BEFORE UPDATE ON core_cart
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_cart_line_item_set_updated_at
  BEFORE UPDATE ON core_cart_line_item
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
