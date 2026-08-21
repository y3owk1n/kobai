-- `updated_at` on the table 0063 created — the second half of adding a Core table (#321).
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- `core_shipping_method` is an ordinary one rather than a tamper detector: a Merchant renames a
-- rate and reprices one, so the value moves whenever `PATCH /admin/regions/{id}` writes the
-- Region's list — including for a rate that only changed position, which is a real edit to what
-- a Shopper is offered.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019, 0023, 0043, 0045, 0047, 0050, 0053 and
-- 0060: a sweep would silently adopt whatever else happened to be in the schema, which is a
-- larger claim than the one being made.
CREATE TRIGGER core_shipping_method_set_updated_at
  BEFORE UPDATE ON core_shipping_method
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
