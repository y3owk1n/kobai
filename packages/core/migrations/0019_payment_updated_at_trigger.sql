-- `updated_at` on the table 0018 created — the second half of adding a Core table.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- A Payment belongs to an Order and an Order is immutable (ADR-0009), so nothing in Core ever
-- updates one of these rows and the column should equal `created_at` forever. That is exactly why
-- it is worth attaching, for the reason 0013 gives for `core_order` and 0015 for its Adjustments:
-- under ADR-0004 the writers Core does not mediate are the normal case, and on a table that says
-- what a Shopper paid, `updated_at > created_at` is visible evidence that somebody rewrote the
-- record of money received.
--
-- Named rather than swept, like 0011, 0013 and 0015: a sweep would silently adopt whatever else
-- happened to be in the schema, which is a larger claim than the one being made.
CREATE TRIGGER core_payment_set_updated_at
  BEFORE UPDATE ON core_payment
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
