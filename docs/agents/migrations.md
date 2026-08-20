# Migrations

Everything a migration has to survive: the trigger a new Core table needs, and the shape that gets a required column or a unique constraint onto a table that already holds rows. **Read this before running `pnpm run db:generate`, and before editing any `schema.ts`.**

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

## A Project's set may write Core's tables, and so applies after Core's

**A Plugin's migration set applies in any order; a Project's does not have to.** That asymmetry is
already the rule `reference/src/db/schema.ts` states from the other side — Core's tables are closed
to a Plugin (ADR-0004) because a Plugin ships to Projects it has never seen, and a Project is under
no such rule because it owns its repository, its database and its own set. The reference Project
exercises it: `reference/migrations/0001_the_store_prices_in_myr.sql` **updates `core_store`**,
because a Store's default currency is fixed once set and no route will ever move it (ADR-0065), so
a deployment that prices in something other than Core's seeded placeholder says so in a migration
of its own.

Two consequences, and the second is the one that bites:

- **It is a `--custom` migration**, like every other data change: drizzle-kit diffs schemas, so it
  will neither write this nor notice it is missing. Guard it on the value Core seeded, so it can
  only ever move a Store nobody has priced yet.
- **That set now depends on Core's having run**, and applying it first fails loudly — which is
  right, and is why the update is not wrapped in a "if the table exists" guard that would leave the
  Store on the placeholder without saying so. `createKobai` composes Core's set in front of
  everything `kobai.config.ts` wires, so that is the only order any deployment applies, and
  `tests/the-cli-and-the-migrator-agree.test.ts` reverses **the Plugins** rather than the whole
  list for exactly this reason. Do not write a Core-table dependency into a **Plugin's** set: there
  the any-order property is the promise, and that test is where it is held.

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

1. **Generated** — write the field *without* `.notNull()` and `pnpm run db:generate`. A
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

**`core_product.handle` is the worked example, and it deduplicates by *never producing* a
duplicate** (#251). `0036`–`0038` is the three-step shape with the uniqueness hazard on top of
it: nullable column, a `--custom` backfill, then `SET NOT NULL` and the constraint. Three things
about the middle one carry to the next uniqueness requirement. It is a **loop rather than one
statement**, because what was wanted was a guarantee: each Product, oldest first by
`(created_at, id)`, takes the slug of its own title, and where that address is already taken it
takes the first free `-2`, `-3`, … after it — checked against **the handles actually written**,
never against a count of duplicate titles, since `Blue poster` twice and a third Product really
called `Blue poster 2` all want `blue-poster-2` and only the first spelling notices. Nothing is
deleted or merged, which is how it sidesteps the paragraph above: two Products are never the
same fact, so keeping the newest was never available. And it is **watched failing** —
`packages/core/src/catalog/two-products-one-handle.test.ts` seeds a catalog through the
pre-handle set and applies the rest onto it, and the run against a backfill with the
disambiguation taken out is what says the arrangement reaches the hazard at all.

**`core_product.status` is the second worked example, and what it shows is that the *value* is
the hazard rather than the statement** (#252). `0039`–`0041` is the same three-step shape with no
uniqueness on top of it: nullable column, a `--custom` `UPDATE`, then `SET NOT NULL` with `draft`
as the declared default and a `CHECK` over the three words. Every one of those statements would
have applied just as cleanly with a backfill writing `draft` — and that deploy would have taken a
Store's whole catalog off its storefront, silently, at the moment kobai was upgraded. So this is
the paragraph above arriving with teeth: the backfill writes `published` because until `0041`
there was nothing else a Product could be, which is the fact that was never recorded rather than a
guess at one. **The pair is what makes it a backfill rather than a default** — `published` for the
rows that were there, `draft` for every row after — and
`packages/core/src/catalog/a-catalog-that-was-already-on-sale.test.ts` asserts both, because
either alone is satisfied by a column that only does one of them. It was watched failing against a
`0040` writing `draft`, which is the only place in this repository that failure is visible.

**A `CHECK` over a closed set of Core's own is fine in the third step and needs no fourth
migration**, because the backfill has already made every row satisfy it — which is the shape the
section below says nothing will tell you that you forgot. Whether a column gets one at all is a
judgement about the set, not a convention: `core_product.status` and `core_api_key.kind` carry one
because nothing outside Core can invent a fourth value, while `core_product.handle` and
`core_variant.fulfilment_strategy` deliberately do not — a rule about a request may be relaxed,
and a constraint is the one place a relaxation cannot reach the rows already written.

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

