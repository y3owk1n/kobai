-- `updated_at` on the two tables 0012 created — the second half of adding a Core table.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- An Order is immutable (ADR-0009), so nothing in Core ever updates one of these rows and the
-- column should equal `created_at` forever. That is why it is worth attaching the trigger rather
-- than dropping the column: under ADR-0004 the writers Core does not mediate are the normal case,
-- so `updated_at > created_at` on an Order is visible evidence that somebody wrote to a record
-- that is never supposed to be written to. A column nothing should ever move is a tamper
-- detector, and it can only be one if something moves it when a write does happen.
--
-- Named rather than swept, like 0011: a sweep would silently adopt whatever else happened to be
-- in the schema, which is a larger claim than the one being made.
CREATE TRIGGER core_order_set_updated_at
  BEFORE UPDATE ON core_order
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_order_line_item_set_updated_at
  BEFORE UPDATE ON core_order_line_item
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
