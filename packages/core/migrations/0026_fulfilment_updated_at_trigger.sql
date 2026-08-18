-- `updated_at` on the Fulfilment table 0025 created — the second half of adding a Core table.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- Fulfilment's case is neither `core_order`'s nor `core_inventory`'s. An Order carries the column
-- as a tamper detector, because nothing should ever move it; Inventory carries it because two
-- numbers move constantly. A Fulfilment is the one part of an Order that is *expected* to move
-- and cannot yet — dispatched, delivered, cancelled belong to the spec that builds fulfilling —
-- so the column is here from the first row rather than added to a table with history in it, and
-- the trigger with it. Under ADR-0004 the writer that moves it may well be a Plugin's.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019 and 0023: a sweep would silently adopt
-- whatever else happened to be in the schema, which is a larger claim than the one being made.
CREATE TRIGGER core_fulfilment_set_updated_at
  BEFORE UPDATE ON core_fulfilment
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
