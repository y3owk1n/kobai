-- `updated_at` on the two tables 0049 created — the second half of adding a Core table, twice.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- `core_product_collection` is a row kobai writes by deleting a Product's whole set and
-- inserting the one the request carried, so nothing Core does today moves its `updated_at` after
-- the row is written. It carries the column and this trigger all the same, exactly as
-- `core_product_media` does under the same treatment: under ADR-0004 the writer that moves one
-- may perfectly well be a Project's own migration or a hand-run `UPDATE`, and a Core table whose
-- `updated_at` was a `now()` frozen at insert would be lying to whichever of them looked.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019, 0023, 0026, 0043, 0045 and 0047: a sweep
-- would silently adopt whatever else happened to be in the schema, which is a larger claim than
-- the one being made.
CREATE TRIGGER core_collection_set_updated_at
  BEFORE UPDATE ON core_collection
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_product_collection_set_updated_at
  BEFORE UPDATE ON core_product_collection
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
