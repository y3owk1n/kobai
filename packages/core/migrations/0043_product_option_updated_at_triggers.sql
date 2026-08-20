-- `updated_at` on the two tables 0042 created — the second half of adding a Core table, twice.
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column. See ADR-0037.
--
-- Both of these are rows a Merchant edits in place rather than supersedes: renaming an option or
-- reordering it is an `UPDATE` on `core_product_option`, and a Variant's answer for one option is
-- rewritten every time its values are corrected. So the column moves in the ordinary course of
-- using the catalog, which is exactly the case a default of `now()` and no trigger gets wrong on
-- every row that has ever been written twice — and under ADR-0004 the writer that moves one may
-- perfectly well be a Project's own migration rather than Core.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019, 0023 and 0026: a sweep would silently
-- adopt whatever else happened to be in the schema, which is a larger claim than the one being
-- made.
CREATE TRIGGER core_product_option_set_updated_at
  BEFORE UPDATE ON core_product_option
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER core_variant_option_value_set_updated_at
  BEFORE UPDATE ON core_variant_option_value
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
