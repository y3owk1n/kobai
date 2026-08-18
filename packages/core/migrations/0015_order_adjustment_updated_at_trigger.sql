-- `updated_at` on the table 0014 created — the second half of adding a Core table.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- An Adjustment is part of an Order and an Order is immutable (ADR-0009), so nothing in Core
-- ever updates one of these rows and the column should equal `created_at` forever. That is
-- exactly why it is worth attaching the trigger rather than dropping the column, for the reason
-- 0013 gives for `core_order` itself: under ADR-0004 the writers Core does not mediate are the
-- normal case, so `updated_at > created_at` here is visible evidence that somebody moved money
-- on a record that is never supposed to be written to.
--
-- Named rather than swept, like 0011 and 0013: a sweep would silently adopt whatever else
-- happened to be in the schema, which is a larger claim than the one being made.
CREATE TRIGGER core_order_adjustment_set_updated_at
  BEFORE UPDATE ON core_order_adjustment
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
