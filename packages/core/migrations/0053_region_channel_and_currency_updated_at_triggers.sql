-- `updated_at` on the three tables 0051 created — the second half of adding a Core table, three
-- times.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- `core_store_currency` is a row nothing in Core ever updates — enabling a currency inserts one
-- and disabling it deletes one — and it carries the column and this trigger all the same, for
-- `core_product_collection`'s reason under 0050: under ADR-0004 the writer that moves one may
-- perfectly well be a Project's own migration or a hand-run `UPDATE`, and a Core table whose
-- `updated_at` was a `now()` frozen at insert would be lying to whichever of them looked.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019, 0023, 0043, 0045, 0047 and 0050: a sweep
-- would silently adopt whatever else happened to be in the schema, which is a larger claim than
-- the one being made.
CREATE TRIGGER core_store_currency_set_updated_at
  BEFORE UPDATE ON core_store_currency
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_region_set_updated_at
  BEFORE UPDATE ON core_region
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_channel_set_updated_at
  BEFORE UPDATE ON core_channel
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
