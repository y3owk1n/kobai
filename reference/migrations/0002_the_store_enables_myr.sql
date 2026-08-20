-- …and so the currency it may price in is ringgit, and not also dollars.
--
-- This is `0001`'s second half, and it exists because of an ordering that is easy to miss.
-- `core_store_currency` holds the vocabulary a Price may be denominated in (ADR-0074), and Core
-- seeds it from `core_store.default_currency` in the migration that creates it — but **Core's
-- whole set applies in front of this one** (`docs/agents/migrations.md`), so on a fresh database
-- Core enables its own placeholder `USD` and only then does `0001` say this Store prices in MYR.
-- Left alone, this Store would enable a currency nobody sells in and not the one it does.
--
-- A Project may write Core's tables and this Project already does — that is `0001`, and the same
-- paragraph of the same file argues it. What a **Plugin** may not do here is the contrast worth
-- keeping in view: a Plugin ships to Projects it has never seen, so ADR-0004 closes Core's
-- tables to it in both directions.
--
-- **Core repairs this at boot as well, and the pair is deliberate** (`src/store/seed.ts`): a
-- Project that never writes this migration still ends up pricing in the currency it chose,
-- because the Region seed takes back a set no request could have produced. What that cannot do
-- is make the Store honest *before* the first boot — every read between the migration and the
-- boot would report a currency this Store does not sell in — and a Project that owns its
-- database says what it prices in in its own set rather than relying on somebody else's repair.
--
-- **Guarded on both halves, so it can only ever move a Store nobody has priced.** It fires when
-- this Store really does price in ringgit and the enabled set is still exactly Core's untouched
-- placeholder; anything else — a deployment that has enabled a second currency on purpose, one
-- upgrading from a version that seeded MYR because `0001` had already run — is left as it was
-- found. `UPDATE` rather than an insert and a delete, because a Region selects a currency by
-- code and no Region exists yet: Regions are seeded at boot, after every migration set.
--
-- Hand-written because drizzle-kit diffs schemas and this changes a row (ADR-0038).
UPDATE "core_store_currency"
SET "code" = 'MYR'
WHERE "code" = 'USD'
  AND EXISTS (
    SELECT 1 FROM "core_store"
    WHERE "singleton" = true AND "default_currency" = 'MYR'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "core_store_currency" WHERE "code" = 'MYR'
  )
  AND (SELECT count(*) FROM "core_store_currency") = 1;
