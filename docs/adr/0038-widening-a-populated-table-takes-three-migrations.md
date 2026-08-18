# Widening a populated table takes three migrations, and the middle one is hand-written

Adding a required column to a table that already exists is **add it nullable, backfill it,
then constrain it** — three migrations, of which the first and third are generated from
`schema.ts` and the second is a `--custom` migration written by hand. `ALTER TABLE … ADD
COLUMN … NOT NULL` with no default is never shipped, whoever wrote it.

This is a decision rather than a lookup because the obvious alternative reads better and is
already what the tool produces, and because the safe form appears to break the rule that
migrations are generated and never hand-edited. It does not, and the reason it does not is
the useful half of this record.

## What the tool does, and why nobody notices

`drizzle-kit generate` turns a new `.notNull()` field on an existing table into exactly one
statement, `ALTER TABLE t ADD COLUMN c … NOT NULL`. Postgres refuses it against a table
holding a single row: the column must have a value for every row already there and the
statement offers none.

Nothing in this repository could see that. `createTestKobai` creates a database seconds
before it migrates it, so every table a migration meets in a test is empty, and the statement
is green here and red at the first Project with traffic. And it is red in the worst possible
place: under [ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md) the set
runs against a live database at boot, and a failed migration refuses to start the
application — so the Project does not get a bad column, it gets no service, from a Plugin
whose author's own tests all passed.

`packages/plugin-price-log/migrations` was where it landed (#58). That set is the
repository's worked example of a Plugin's schema evolving on its own timetable, so the fault
was not one broken deployment — there were none, the table could hold no rows — but the
pattern being taught to everyone who copies the example.

## Considered options

- **`ADD COLUMN … NOT NULL DEFAULT v`, one statement.** The strongest rival, and on Postgres
  11 and later it does not even rewrite the table — the default is recorded in the catalogue
  and read back for the rows that predate it, so the lock is brief and the cost is constant
  whatever the table's size. The three-migration shape is genuinely worse on those terms: its
  `UPDATE` rewrites every row it touches and its `SET NOT NULL` full-scans under an `ACCESS
  EXCLUSIVE` lock.

  **It was rejected for what the default does afterwards, not for what it costs.** A column
  default applies to every row written from then on, so it is not a statement about the rows
  that were already there — it is a permanent answer for anything whose writer forgets. In
  `price_log_entry` that would be a Step that omitted the amount silently logging `0 XXX`
  and looking like a free item, indistinguishable from a real one. **So: reach for
  `NOT NULL DEFAULT` when the value is correct for future rows as well as past ones, and it
  belongs in `schema.ts` as an ordinary `.default()` where it is visible.** A default that
  has to be dropped again the moment it has done its job was never a default; it was a
  backfill, and it should be written as one.
- **Leave the columns nullable.** Honest about the old rows and useless for the new ones:
  `null` would then mean either "written before the column existed" or "the writer forgot",
  and the column could never distinguish them. The constraint's value is entirely in the
  future — it is what turns a Step's bug into a refused write instead of a plausible row.
- **A corrective migration on top of the broken one.** Rejected *here*, and only here. The
  set had never been released and no deployment could hold a row — nothing wrote to
  `price_log_entry` until the Step existed — so nothing was preserved by keeping the file,
  and the one a Plugin author opens first would still have shown the pattern being warned
  about. It was regenerated from the migration before it instead, journal included.

  **That option closes the moment a set ships.** An applied migration is a fact about
  somebody's database: rewriting one leaves a tracking row naming SQL that no longer exists,
  and a set that has been released has to be corrected forwards, however much worse the
  history reads. Check which case you are in before reaching for either.

## What makes a backfill value defensible

The backfill has to say something about rows nobody recorded the answer for, and the failure
mode is stating a plausible falsehood — `updated_at` equalling `created_at` forever
([ADR-0037](./0037-updated-at-is-a-trigger-because-core-does-not-mediate-every-write.md)) is
the same mistake: wrong in the shape of a correct answer.

So the test is not "what was this row's value?" but **"is there a value that says the fact
was never recorded, and can a reader tell?"** For `price_log_entry` there is, and it comes
from outside kobai: ISO 4217 reserves `XXX` for transactions where no currency is involved,
and `0` minor units is the only amount consistent with it. A row carrying `XXX` cannot be
mistaken for a resolution that observed a price.

**Where no such value exists, that is a finding about the column, not a problem to solve in
SQL.** Either the fact can be derived from something the row already carries, or the column
should stay nullable, or the constraint should wait until the rows that cannot satisfy it
have aged out. Inventing a plausible one is the option that is always available and always
wrong. Note what was *not* used here: Core's `core_store.default_currency` sits in the same
database and would have looked authoritative, but a Plugin reading Core's schema in a
migration depends on a shape Core promises nothing about
([ADR-0003](./0003-the-extension-surface-and-what-we-promise.md),
[ADR-0004](./0004-plugins-own-their-tables-core-tables-are-closed.md)) — and it would have
recorded today's currency as though it were the one that applied then.

## The same three steps answer a constraint, and the guardrail reads three statements

A column is not the only thing an existing table can refuse. Postgres refuses `CREATE UNIQUE
INDEX` against a table already holding two rows that agree on the indexed columns (#119), and
refuses `ALTER TABLE … ADD CONSTRAINT … UNIQUE` — what a `.unique()` on a column generates, and
so the likelier of the two spellings — for the same reason (#153). Both arrive unprompted from
an ordinary declaration, and both take this record's shape one door along: **deduplicate in a
`--custom` migration, then let the generated migration add the index or the constraint.** The
middle step is hand-written for the reason a backfill is — an `UPDATE` or a `DELETE` is a data
change drizzle-kit will neither write nor notice is missing — and it has to be defensible in the
same way: keeping the newest of a set of duplicates is right only if the others are genuinely
the same fact, and where they are not, that is a finding about the constraint rather than
something to solve in SQL.

So `tests/migrations-are-safe-against-populated-tables.test.ts` reads **three** statements: a
required column with no default, and uniqueness arriving in either spelling at a table the same
migration did not create. Those last two have exactly one excuse, and it is the only one a
reading of a single file can make — the table was created here, so it can hold no row the
constraint has not seen, which is what Core's `ADD CONSTRAINT … FOREIGN KEY` statements already
rest on. Whether an earlier migration deduplicated an inherited table is not a property of this
text, so a constraint meeting one is named, and answered where a reason can be written down
beside it.

**What that reading deliberately leaves out is as much of the decision as what it covers.** A
plain `CREATE INDEX` is not a fault a row can commit: its cost against a populated table is a
lock rather than a refusal, and the remedy is `CONCURRENTLY`, which cannot run inside the
transaction the migrator wraps a set in — so naming it would name a fault with no shape
available to answer it. And `ALTER TABLE … ADD CONSTRAINT … CHECK` is left unread for the reason
`ALTER COLUMN … SET NOT NULL` is: the correct answer and the fault are the same text.
`packages/core/migrations/0027` adds one and is safe, and what makes it safe is the statement
immediately before it, which adds `tax` with `DEFAULT 0` and so answers the predicate for every
row already there — telling that from the same pair under a default the check would refuse means
*evaluating* the predicate, which is a SQL engine rather than a reading. Reading earlier
migrations rescues nothing either, because the shape this record prescribes puts the backfill in
a `--custom` migration of its own: the generated migration that adds a constraint holds the
constraint and nothing else, so a check that flagged it would be red for every correct answer as
well as every wrong one. **A `CHECK` arriving at a populated table is backed by a backfill on
purpose, then, and never because something noticed it was not.**

## This does not bend "generated, never hand-edited"

AGENTS.md § Layout says a migration set is generated and never hand-edited except for
`--custom` files. The safe shape needs a hand-written migration, which looks like the
exception swallowing the rule. It is not, and the reason is worth stating precisely:

**The two schema steps are generated, and the hand-written one contains no schema change at
all.** Nullable-columns-added and columns-constrained are both states `schema.ts` can express,
so `drizzle-kit generate` writes both, from the field declarations, with their snapshots and
journal entries — the sequence is produced by writing the fields without `.notNull()`,
generating, then putting it back and generating again. The backfill between them is an
`UPDATE`. drizzle-kit diffs schemas, so a data change is invisible to it in **both**
directions: `generate` will never write one and will never notice one is missing.

That is the same test `--custom` already passes everywhere else in this repository — Core's
seed migrations and `0009_updated_at_triggers.sql` are hand-written because a seed row and a
trigger are likewise things drizzle-kit's model cannot hold. The rule reads, in full: **the
schema is generated from `schema.ts`; what drizzle-kit's model has no room for is hand-written
in a `--custom` file; nothing generated is ever edited afterwards.** A backfill has always
been in the second category. What #58 changed is that it is now sometimes *required*, and
that is why it needed writing down.

`--custom` is also not a way to reach the *end state* by hand. Its snapshot is a copy of the
previous one, so a `--custom` migration that altered the schema would leave drizzle-kit
believing the change had not happened and generating it again on the next run. The nullable
step and the constraint step have to be generated for that reason too, not only for tidiness.

## Consequences

- **A Plugin or Project author adding a required column to a live table writes three
  migrations.** `packages/plugin-price-log` is the worked example, and its `schema.ts`
  carries the sequence in a comment where the fields are declared, because that is where
  someone about to type `.notNull()` is looking.
- **Two tests hold it, at different distances.**
  `packages/plugin-price-log/src/migrations.test.ts` seeds a row into `price_log_entry` under
  the old schema and then applies the rest of the set, which is the only test in this
  repository that meets a migration with data in front of it — it uses `migrationSetUpTo`
  from `@kobai/core/testing`, which truncates a set at a named migration so a test can stand
  where a real deployment stands. `tests/migrations-are-safe-against-populated-tables.test.ts`
  reads every migration in the repository for the three statements above, because the fault is
  a property of the text and seeding every table in the repository is a suite nobody would keep.
- **Core is clear and was checked.** Every `NOT NULL` in `packages/core/migrations` is inside
  a `CREATE TABLE`, where no existing row can be met; its only `ALTER TABLE` statements add
  foreign keys to tables created in the same migration. So is `reference/migrations`. The
  reading test is what keeps that true — and it names one statement Core ships anyway, `0016`'s
  unique index on `core_order.cart_id`, which is acknowledged in the test by file and by text
  with the argument that no deployment old enough to hold duplicates exists yet (#119). That
  acknowledgement is an equality rather than an ignore list, so it cannot outlive the statement
  it excuses.
- **The static check cannot see `ALTER COLUMN … SET NOT NULL`**, which fails on a populated
  table too — but only when the backfill before it was missing or wrong, and no reading of
  the text can tell. It is the third step of the correct shape, so flagging it would fail the
  fix along with the fault. The seeded test is what covers that one, and it covers it for one
  table.
- **Nor can it see `ALTER TABLE … ADD CONSTRAINT … CHECK`**, and that is the same trade taken
  again rather than an omission (#153): the backfill that makes one survivable is a statement in
  a different migration, so the safe shape and the broken one read alike. See the section above
  for the argument and `packages/core/migrations/0027` for the shape.
- **Three migrations is three round trips of locking**, which is the price of the option that
  keeps no default behind. On a large table the `UPDATE` should be batched and the steps
  spread across deployments; nothing here is large, and nothing here pretends to have solved
  that.
