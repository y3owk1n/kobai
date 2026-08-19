-- This Store prices in Malaysian ringgit.
--
-- Core seeds `core_store` with a placeholder name and USD (`core/migrations/0001_seed_store.sql`
-- says so in as many words), and a Store's default currency does not move afterwards:
-- `PATCH /admin/store` refuses any other code at 422 `default-currency-is-fixed`, because every
-- Price carries the default and no other, so moving the column would reinterpret each amount
-- already stored rather than convert it (ADR-0065, ADR-0008). There is therefore no route that
-- could do this and deliberately never will be. A deployment saying what it prices in says it
-- here, once, before it has a Price to reinterpret — which is a Project writing a row rather
-- than a schema, so it is a `--custom` migration like every other data change (ADR-0038).
--
-- **It is MYR because that is what makes FPX real** (ADR-0069, ADR-0070). Which methods a
-- redirect provider offers is decided by the currency — FPX settles only in ringgit — so a
-- reference Store priced in dollars would have the whole of spec 2 exercised by prose. It also
-- stops the currency being decorative: every amount in this repository was USD, and no Store
-- priced in anything else had ever been booted.
--
-- **Guarded on the placeholder, so it can only ever move a Store nobody has priced.** A
-- deployment whose Merchant has already been served, quoted and charged in dollars is one this
-- migration must not silently re-denominate — and a Store whose currency is anything but Core's
-- seeded `USD` has been decided by somebody. `WHERE` is the whole of that judgement: on a fresh
-- database this runs before the first Price exists, and on any other it does nothing.
UPDATE "core_store"
SET "default_currency" = 'MYR'
WHERE "singleton" = true AND "default_currency" = 'USD';
