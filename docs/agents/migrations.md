# Migrations

Everything a migration has to survive: the trigger a new Core table needs, and the shape that gets a required column or a unique constraint onto a table that already holds rows. **Read this before running `devbox run db:generate`, and before editing any `schema.ts`.**

Part of [`AGENTS.md`](../../AGENTS.md), which is the source of truth and says when to read this.
## `updated_at` is a trigger, and a new Core table needs one

**Every Core table carrying `updated_at` has a `before update` trigger calling
`core_set_updated_at()`, and none of that is in `schema.ts`** (ADR-0037). Drizzle's
`$onUpdate` was rejected: it fires only for writes going through Core's own query builder,
and under ADR-0004 the writers Core does not mediate — a Project, a Plugin, a hand-run
`UPDATE`, a raw `db.execute` inside Core — are the normal case rather than the
exception. Core's whole HTTP surface performs **two** `UPDATE`s today — one from a handler,
and one on the authentication path, where a request slides its session's deadline (ADR-0045)
— so a mechanism covering only Core's writes would cover almost nothing. The column had
defaulted to `now()` and never moved since the first table shipped, which is why the bar here
is a value that moves rather than a schema that looks right (#32).

So **adding a Core table with `updated_at` is two steps, not one**: the column in
`packages/core/src/db/schema.ts`, then a `--custom` migration attaching the trigger, the way
`packages/core/migrations/0009_updated_at_triggers.sql` does. `drizzle-kit` has no trigger in
its schema model, so `generate` will neither write that for you nor notice it is missing —
and a later migration that drops and recreates a table takes the trigger with it, silently.
`packages/core/src/db/updated-at.test.ts` is the guardrail: it asks Postgres for every
`core_` table carrying the column and fails naming any without a trigger.

**A Plugin's tables are the Plugin's business.** Core attaches nothing to them and a Plugin
that wants the same guarantee writes its own function and trigger in its own migration set —
never by calling `core_set_updated_at()`, which is a detail of a schema Core promises nothing
about. `@kobai/plugin-price-log` carries `resolved_at` and no `updated_at` at all, because
its rows are never updated.

## Adding a required column to a table that already exists

**Never ship `ALTER TABLE … ADD COLUMN … NOT NULL` with no default.** Postgres refuses it
against a table holding one row, and that is the *one* statement `drizzle-kit generate`
writes from a new `.notNull()` field on an existing table — so the hazard arrives by itself,
from an ordinary declaration, and nothing here notices. Every test database is created
seconds before it is migrated, so the statement is green in this repository and red at the
first Project with traffic; under ADR-0030 the set runs against a live database at boot, so
that Project gets no service rather than a bad column.

The shape is **three migrations, and only the middle one is written by hand** (ADR-0038).
`packages/plugin-price-log/migrations/0001`–`0003` is the worked example:

1. **Generated** — write the field *without* `.notNull()` and `devbox run db:generate`. A
   nullable column is safe to add at any size.
2. **Hand-written**, via `drizzle-kit generate --custom`: the backfill, an `UPDATE` giving
   every existing row a value.
3. **Generated** — put `.notNull()` back and generate again, which emits `ALTER COLUMN …
   SET NOT NULL`.

**This does not bend "generated, never hand-edited".** Both schema steps *are* generated,
from `schema.ts`, with their snapshots and journal entries; the hand-written one carries no
schema change at all. drizzle-kit diffs schemas, so a data change is invisible to it in both
directions — it will neither write a backfill nor notice one is missing — which is the same
reason Core's seed migrations and `0009_updated_at_triggers.sql` are hand-written. Do not
reach for `--custom` to make a *schema* change by hand: its snapshot is a copy of the
previous one, so drizzle-kit would believe the change never happened and generate it again.

**`ADD COLUMN … NOT NULL DEFAULT v` is the right answer when the value is right for future
rows too** — it is one statement and, on Postgres 11 and later, needs no table rewrite. Then
the default belongs in `schema.ts` as an ordinary `.default()`, where it is visible. A
default that has to be dropped once it has done its job was never a default; it was a
backfill. And **a backfill value has to say the fact was never recorded, not guess at it** —
`price_log_entry` uses ISO 4217's `XXX`, the code for "no currency involved", precisely
because no real currency code could be told apart from one the Plugin had actually observed.
If no such value exists, that is a finding about the column, not something to solve in SQL.

**A unique index is the same hazard through a different statement, and the same shape answers
it** (#119). Postgres refuses `CREATE UNIQUE INDEX` against a table already holding two rows
that agree on the indexed columns, and `drizzle-kit generate` writes exactly that from a
`uniqueIndex()` added to a table that already exists — unprompted, from an ordinary
declaration, like the column. So: **deduplicate in a `--custom` migration first, then generate
the index**, so the constraint arrives onto data that can satisfy it. The middle step is
hand-written for the same reason a backfill is — an `UPDATE` or a `DELETE` is a data change
drizzle-kit will neither write nor notice is missing — and it has to be defensible in the same
way: keeping the newest of a set of duplicates is right only if the others are genuinely the
same fact, and where they are not, that is a finding about the constraint rather than
something to solve in SQL. A **plain** `CREATE INDEX` is not this: no row can refuse one, its
cost on a populated table is a lock, and the remedy for that is `CONCURRENTLY`, which cannot
run inside the transaction a migration is applied in.

**Uniqueness arrives in two spellings and the check reads both** (#153). `ALTER TABLE … ADD
CONSTRAINT … UNIQUE` is what a `.unique()` on a column generates — eight of those in
`packages/core/src/db/schema.ts` against three `uniqueIndex()`, so it is the *likelier* way a
future uniqueness requirement arrives — and it rests on the same one excuse: the table was
created in this migration, or it was not.

**`ALTER TABLE … ADD CONSTRAINT … CHECK` is deliberately not read, and the shape above is
still what answers it.** Postgres refuses one against a row that does not satisfy it, so the
hazard is as real as the others; what is missing is any way to tell from the text whether the
rows do. `packages/core/migrations/0027` adds one and is safe, and what makes it safe is the
statement immediately before it, which adds `tax` with `DEFAULT 0` and so answers the
predicate for every row already there — telling that from the same pair with a default the
check would refuse means *evaluating* the predicate, which is a SQL engine rather than a
reading. Reading earlier migrations would not rescue it either: the backfill belongs in a
`--custom` migration of its own, so the generated migration that adds a constraint holds the
constraint and nothing else, and a check that flagged it would be red for the correct shape as
well as for the broken one — the same reason `ALTER COLUMN … SET NOT NULL` is left unread. So
**a `CHECK` arriving at a table with rows in it is yours to put a backfill in front of**;
nothing here will tell you that you forgot.

Two tests hold this. `packages/plugin-price-log/src/migrations.test.ts` seeds a row and then
applies the rest of the set — the only place in this repository a migration meets data —
using `migrationSetUpTo` from `@kobai/core/testing`.
`tests/migrations-are-safe-against-populated-tables.test.ts` reads every migration in the
repository for the statements themselves: a required column with no default, and uniqueness —
as an index or as a constraint — arriving at a table the same migration did not create. Those
last two have only the one excuse a reading of a single file can make — **the table was
created here, so no row it has not seen can refuse anything** — which is the same excuse
Core's foreign keys already rest on.
Core's own set is otherwise clear and stays clear that way: every `NOT NULL` in it is inside a
`CREATE TABLE`. Its `ALTER TABLE`s add foreign keys, and all but one of them do it to a table
created in the same migration; the exception is `0031`, which puts a **nullable** `cart_id` on
`core_reservation` and a foreign key on it (ADR-0070). A nullable column is safe to add at any
size and a foreign key on one can refuse no row that is already there, since every one of them
holds `null` — which is the shape at the head of this section, arriving without needing its
second and third steps because `null` is the honest value for a hold taken before anything
recorded a Cart.

**`0016`'s unique index on `core_order.cart_id` is named by that check and shipped anyway**: a
deployment left anywhere between `0012` — where `core_order` is created — and `0015` could meet
it with the very duplicates `0016` exists to prevent, since until then a Cart could become two
Orders. **That one is a release decision and it lives in
[ADR-0061](../adr/0061-what-the-first-publish-owes.md)**, the one list of what the first
publish owes, under the heading naming `0016` — with why the deduplication was not written, the
one question to ask before the first publish, and both answers to it. Do not re-take it here or
in the test; the test's entry points at it. What belongs in this file is the mechanism: the
acknowledgement is an equality rather than an ignore list, so a statement it names that changes fails it and one it does not
name that appears fails it too, and answering a finding there is a decision written down, never a
line added to a list.

**An acknowledgement says which of two judgements it is, because the correct shape produces the
identical finding** (#161). The reading is per-file and has to be — ADR-0038 puts the
deduplication in a `--custom` migration of its own — so "safe, because the migration before it
deduplicated" and "unsafe, but unreachable while nothing is published" arrive as the same text,
and a list that told them apart in prose alone would be one list of two meanings. So each entry
carries a **kind**, and each kind carries the one thing that would show it false: a
`deduplicated-ahead-of-it` entry names the migration that removed the duplicates, which has to
run ahead of it in the same set; an `unreachable-until-release` entry names the record arguing it
**and the section of that record which lists what falls due**, which has to name the migration
back — so ADR-0061's entry for `0016` cannot be shorter than the constant, and emptying or
renaming it fails rather than quietly emptying the list. **Both checks are
assertions, not conventions**, and a kind added without a warrant does not compile. What neither
check reads is the argument itself — that the migration named really did remove the right
duplicates, that the record's prose is still true — because reading it would be checking wording.
That stays the author's to argue in prose beside the entry, which is where the reasoning still
lives.

