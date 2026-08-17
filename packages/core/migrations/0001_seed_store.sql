-- A fresh database becomes a working Store without a separate step: the Store is a
-- singleton, so there is nothing for a Merchant to create and nothing for a Developer to
-- run. It is seeded here rather than at boot because it is a fact about the schema — the
-- table is meaningless empty — and because boot-time seeding would have to guess whether an
-- empty table meant "new" or "a Merchant deleted it".
--
-- The name and currency are placeholders. A Merchant renames the Store from the Admin; the
-- row itself is never created again.
INSERT INTO "core_store" ("singleton", "name", "default_currency")
VALUES (true, 'kobai', 'USD')
ON CONFLICT ("singleton") DO NOTHING;
