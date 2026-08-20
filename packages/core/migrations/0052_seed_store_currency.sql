-- The Store's default currency is enabled by the migration that created the table it is
-- enabled in, so a deployment is never in the state its own rules forbid: `core_store_currency`
-- is the vocabulary a Price may be denominated in (ADR-0074), and a Price carrying no Region
-- and no Channel is denominated in `core_store.default_currency` — so a Store whose default was
-- not in that set would be quoting rows in a currency it does not price in. `PATCH /admin/store`
-- refuses a `currencies` that leaves it out for exactly that reason, and this is the same
-- invariant established at the moment the table appears rather than at the first request.
--
-- It reads the value out of `core_store` rather than writing `USD`, because by the time a
-- deployment upgrades to this version its Store may have been priced years ago — Core seeds a
-- placeholder (`0001_seed_store.sql`) and a Project's own migration set moves it, which is
-- exactly what the reference Project does. `SELECT` is what makes this the deployment's own
-- currency rather than Core's guess at one.
--
-- **What it cannot cover is a Project that moves the default in the same boot**, and that is not
-- a hole in this file: Core's set applies in front of every Project's (see
-- `docs/agents/migrations.md`), so on a *fresh* database this runs before
-- `reference/migrations/0001_the_store_prices_in_myr.sql` has said what this Store prices in.
-- The Region seed at boot is where that is repaired, after every set has applied — see
-- `src/store/seed.ts`, which enables the Store's default there for this reason.
--
-- Hand-written because drizzle-kit diffs schemas and a seed row is a data change: it will
-- neither write this nor notice it is missing (ADR-0038). `ON CONFLICT DO NOTHING` so that a
-- deployment whose row somehow exists already is left as it was found.
INSERT INTO "core_store_currency" ("code")
SELECT "default_currency" FROM "core_store" WHERE "singleton" = true
ON CONFLICT ("code") DO NOTHING;
