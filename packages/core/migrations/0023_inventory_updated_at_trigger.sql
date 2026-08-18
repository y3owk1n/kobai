-- `updated_at` on the Inventory table 0022 created — the second half of adding a Core table.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- Inventory is the strongest case for it in Core so far, and the opposite one to `core_payment`'s.
-- These two numbers move constantly and from more than one direction — a Merchant counting a
-- shelf, a hold claiming units, a Capture taking them — so `updated_at` is a fact somebody
-- reconciling stock actually wants, and under ADR-0004 a hand-run `UPDATE` against a stock level
-- is exactly the writer Core does not mediate.
--
-- `core_reservation` deliberately gets nothing, because it carries no `updated_at` at all: its
-- only two transitions each have a timestamp column of their own (`consumed_at`, `released_at`),
-- which is `core_session`'s argument (ADR-0045) applied to a row with two endings instead of one.
--
-- Named rather than swept, like 0011, 0013, 0015 and 0019: a sweep would silently adopt whatever
-- else happened to be in the schema, which is a larger claim than the one being made.
CREATE TRIGGER core_inventory_set_updated_at
  BEFORE UPDATE ON core_inventory
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
