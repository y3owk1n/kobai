-- `updated_at` on the table 0044 created — the second half of adding a Core table (ADR-0037).
--
-- `core_set_updated_at()` already exists (0009). What does not carry across is the *attachment*:
-- 0009 swept the schema as it stood when it ran, so a table created afterwards gets nothing, and
-- drizzle-kit has no trigger in its schema model — it neither wrote this nor noticed it was
-- missing. `packages/core/src/db/updated-at.test.ts` is what notices, by asking Postgres for
-- every `core_` table carrying the column.
--
-- A Media row is edited in place rather than superseded: the bytes never move, and the alt text
-- is the thing a Merchant comes back to write once somebody points out the image says nothing to
-- a screen reader. So the column moves in the ordinary course of running a Store, which is
-- exactly the case a default of `now()` and no trigger gets wrong on every row written twice —
-- and under ADR-0004 the writer that moves one may be a Project's own migration rather than
-- Core.
--
-- Named rather than swept, like 0011, 0013, 0015, 0019, 0023, 0026 and 0043: a sweep would
-- silently adopt whatever else happened to be in the schema, which is a larger claim than the
-- one being made.
CREATE TRIGGER core_media_set_updated_at
  BEFORE UPDATE ON core_media
  FOR EACH ROW EXECUTE FUNCTION core_set_updated_at();
