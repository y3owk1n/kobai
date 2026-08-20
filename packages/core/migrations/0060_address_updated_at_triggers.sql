-- `updated_at` on the two tables 0059 created — the second half of adding a Core table, twice.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- The two tables want the column for opposite reasons, and both want the trigger. `core_address`
-- is a row a Shopper corrects, so its `updated_at` is an ordinary one and moves whenever the
-- Address does. `core_order_address` is a **snapshot** and nothing in Core ever writes it twice,
-- so this one is `core_order`'s tamper detector rather than `core_fulfilment`'s expectation of
-- movement: the value should equal `created_at` forever, and a value that has moved is evidence
-- somebody wrote to a record ADR-0009 says is never written to. A column that only ever advances
-- because a trigger advanced it is the one that can say that; one frozen at insert could not.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019, 0023, 0043, 0045, 0047, 0050 and 0053: a
-- sweep would silently adopt whatever else happened to be in the schema, which is a larger claim
-- than the one being made.
CREATE TRIGGER core_address_set_updated_at
  BEFORE UPDATE ON core_address
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_order_address_set_updated_at
  BEFORE UPDATE ON core_order_address
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
