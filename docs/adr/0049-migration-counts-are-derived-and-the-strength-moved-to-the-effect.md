# ADR-0049: Migration counts are derived, and the strength moved to the effect

**Status:** Accepted

**Date:** 2026-08-18

**Issue:** [#34](https://github.com/y3owk1n/kobai/issues/34)

## Context

Five assertions across three packages wrote down how many migrations kobai has.
`health.test.ts` pinned what `/health` reports, `migrations.test.ts` pinned it twice — once
against the tracking table's row count and once against what `runMigrations` returns — and
`plugin-price-log/src/plugin.test.ts` pinned the Plugin's own count and, separately,
enumerated Core's eight tables.

Every ticket that added a migration edited them. #5 took the number from four to six; #25,
#26 and #32 each added at least one more; #58 moved the Plugin's. None of those tickets was
about counting, and the diff of each carried an edit to a Plugin's test explaining that Core
now has one more table.

The obvious fix — read the count off `migrations/meta/_journal.json`, which is the file the
migrator itself reads first — removes the chore and **weakens what the tests assert.** A
hardcoded `10` says "exactly ten migrations applied". Derived from the journal it says "as
many applied as the journal claims", and both sides of that comparison come from the same
file: a migration dropped from the journal satisfies it, because the migrator never applied
what the journal never named. That is why #5's author bumped the numbers instead of
refactoring. It is a decision about what those tests are for, not a cleanup.

## Decision

**Derive the count from the journal, and add a separate assertion that every migration the
journal declares has actually left a mark in the database.** The strength moves off the
number and onto the effect.

`@kobai/core/testing` gains two functions, and they are promised surface under ADR-0047 and
therefore ADR-0019:

- `declaredMigrations(set)` — the migrations a set declares, by tag, in journal order. Every
  count that used to be written down is now `(await declaredMigrations(set)).length`.
- `appliedMigrations(database, set)` — the migrations of that set **this database holds**, by
  tag, in journal order. A set never applied here is `[]` rather than an error, because "this
  Plugin is installed and unwired" is a state worth asserting about.

The pairing every site now makes is:

```ts
await expect(appliedMigrations(kobai.database, coreMigrationSet)).resolves.toEqual(
  await declaredMigrations(coreMigrationSet),
);
```

A row is matched to a migration by **the sha256 Drizzle stores of the `.sql` file** — the
same digest the migrator itself compares to decide whether a migration has already run. So
this asks the migrator's own question, and the answer is identity rather than coincidence: a
`.sql` edited after it shipped no longer matches the row that applied it. The journal's
`when`, which Drizzle copies into `created_at` verbatim, was the looser alternative and was
not taken — two migrations generated inside one millisecond would be indistinguishable under
it, and an edited file would pass. If a Drizzle upgrade ever changed the digest, everything
here reports unapplied; that is the right alarm and not a false one, because the same change
would make every deployed database re-apply every migration it has already run.

Three things did **not** change, deliberately:

- **The row count is still asserted**, now derived. It buys the direction the tag comparison
  does not: a row no migration in the set accounts for, which is Drizzle having applied
  something twice — the drift ADR-0030 is about.
- **`plugin-price-log`'s Core-table rule is untouched.** "A Plugin has added no column to a
  Core table" is asserted by taking `columnsOwnedBy("core")` with the Plugin installed and
  without and comparing the two. It never held a number and it holds none now. What was
  removed from that file is the *list of Core's eight tables*, which existed only to say "the
  backwards database is not empty" before the two databases were compared — and every
  migration of both sets being named as applied says that better, because a missing table now
  arrives with the migration that should have created it.
- **`tests/the-cli-and-the-migrator-agree.test.ts` keeps its shape** (#46, ADR-0044). It read
  each set's journal itself, precisely so #34 would not grow; it now asks
  `declaredMigrations` the same question, so there is one reader.

## What protection was traded away

One thing, and it is real: **a migration deleted from the journal along with its `.sql` no
longer disagrees with anything here.** The count shrinks on both sides. Under the old scheme
`10` would have disagreed with `9`.

That was checked rather than reasoned about, in both directions, before this was written.

**A migration that does not apply is still caught.** `runMigrations` was temporarily made to
apply Core's set one migration short *and* to insert a junk tracking row, so the row count
still read exactly what the journal declares. The derived count noticed nothing — as
designed, it cannot. Every new pairing failed, in `migrations.test.ts`, in `health.test.ts`
and in the Plugin's install-order test, each naming `0009_updated_at_triggers` as the tag
present in the journal and absent from the database. `packages/core/src/testing/migrations.test.ts`
holds that demonstration permanently, so the assertion is known to be able to fail. It also
asserts the other half of what the digest buys — a `.sql` edited after it shipped stops
matching the row that applied it, and drops out — rather than leaving that to a docblock.

**A migration deleted from the journal is caught by its effect, not by a number.** Dropping
`0009_updated_at_triggers` from Core's journal leaves every assertion in this ADR green and
turns `updated-at.test.ts` red with *"nothing advances updated_at on: core_api_key,
core_merchant, core_price, …"*. Dropping the weakest case — `0008_seed_api_key_read_permission`,
a seed with no schema change at all — leaves this ADR's assertions green and turns six tests
in `auth.test.ts` and `api-key.test.ts` red, including *"gives the seeded owner Role exactly
the permissions Core defines"*.

So the protection did not leave the repository; it was never in the count. Every migration
kobai has exists to make something true, and the test that owns that something is the one
that notices when it stops being true — and says which thing it was. What the count could say
was `expected 9 to be 10`, which names no migration, no effect and no file. The trade is a
diagnosis for a tally, and the one case where the tally spoke first is a case where something
else speaks better a moment later.

The residual risk is a migration whose effect **nothing else asserts**. Such a migration is
untested whether or not anybody counts it, and the count would only ever have reported that
its absence changed a number.

## Consequences

- Adding a migration edits no test. It has to edit `schema.ts`, a migration file, and
  whatever asserts the thing the migration does — which is the work, and is the point.
- A migration that does not apply fails by name. `expected [ '0000_right_expediter', …(8) ]
  to deeply equal [ '0000_right_expediter', …(9) ]` names the tag; `expected 9 to be 10` did
  not.
- `@kobai/core/testing` is two functions wider, and that widening is deliberate (ADR-0047). A
  Plugin author asserting their own set applied needs the same seam.
- The digest is a coupling to Drizzle, and a loud one. It is the coupling the migrator
  already has with itself.
