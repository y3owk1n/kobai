# `updated_at` advances by trigger, because Core does not mediate every write

Every Core table carrying `updated_at` has a `before update` row trigger calling one shared
plpgsql function, `core_set_updated_at()`, attached by sweeping the schema in a single
`--custom` migration. kobai does **not** use Drizzle's `$onUpdate`, and does not use both.

The column had defaulted to `now()` since the first table and nothing had ever advanced it,
so on any row written twice it was not stale but wrong — wrong in the shape of a correct
answer, which is the expensive kind. This ADR exists because the fix had two credible forms
and the difference between them is [ADR-0004](./0004-plugins-own-their-tables-core-tables-are-closed.md)'s
ownership question rather than a matter of style.

## Why not `$onUpdate`

`$onUpdate` is simpler, lives in `schema.ts` where a reader already is, and needs no
hand-written SQL. It fires when a write goes through Drizzle's query builder **in Core's
process**, and at no other time.

Under ADR-0004 that is not the common case, it is the rare one. A Project owns its
repository, its migrations and its database, and may write Core's tables however it likes. A
Plugin holds a connection to the same Postgres. A Developer diagnosing an incident runs an
`UPDATE` in `psql`. Core itself is not fully covered either: a raw `db.execute` inside Core
bypasses the hook exactly as a stranger's statement does.

The scale of it is visible in Core today. **Core's entire HTTP surface performs one
`UPDATE`** — revoking an API key. Every other write it makes is an insert or a delete. So
almost every update a Core row will ever see in a real deployment comes from a writer Core
never sees, and a mechanism that covers only Core's own writes covers close to none of them.

What that costs is precise: under `$onUpdate`, a Project or Plugin writing directly leaves
`updated_at` holding the row's *creation* time, indefinitely, with nothing anywhere
reporting a problem. That is this bug again, reintroduced at the boundary nobody inspects.
The trigger runs inside Postgres, so the writer's identity stops mattering — which is the
whole property being bought.

## Considered options

- **Drizzle's `$onUpdate`** — rejected above.
- **Both, for belt and braces** — rejected. Two mechanisms that can disagree is worse than
  either alone, and the one that would win is the one being argued against.
- **A Postgres event trigger on `ddl_command_end`**, attaching the row trigger to every new
  table automatically. Rejected on two counts. It needs superuser, which the role a Project's
  application connects as should not hold; and an event trigger is **database-wide**, so
  Core would be attaching triggers to Plugin and Project tables — ADR-0004's line, crossed
  from the side that is meant to respect it.

## The trigger fires unconditionally

`NEW.updated_at := now()` on every `UPDATE`, including one that writes a row's existing
values back and one that sets `updated_at` itself. The common `WHEN (OLD.* IS DISTINCT FROM
NEW.*)` guard would narrow the meaning to "and something changed", which is arguably more
useful and is certainly harder to hold in your head. "The row was written" is a promise a
reader can trust without qualification, and a column whose advance carries a condition is how
this went wrong the first time. The database also has the last word, so no writer can hand
the column a value of its own by mistake, by copying a row, or by restoring one.

## Plugin tables: their business, and Core's function is not theirs to call

**A Plugin decides for itself.** Core does not attach triggers to a Plugin's tables and will
not — a Plugin owns its tables and its migration set (ADR-0004), and Core reaching in to
adjust them is the same violation as a Plugin adding a column to `core_store`, taken from the
side that is supposed to know better. A Plugin that wants the guarantee writes its own
function and its own trigger in its own migration set, which is four lines.

Deliberately **not** by calling `core_set_updated_at()`. It exists in the same database and a
Plugin could reach it, but it is an implementation detail of Core's schema and Core's schema
is not part of the stability promise ([ADR-0003](./0003-the-extension-surface-and-what-we-promise.md),
[ADR-0019](./0019-plugins-are-npm-packages-and-semver-covers-only-the-promised-surface.md)).
Core may rename or drop it in a patch release, and a Plugin depending on it would break with
no version bump to blame.

`@kobai/plugin-price-log` is the worked answer: it carries `resolved_at` and no `updated_at`
at all, because its rows record that something happened and are never updated. A column that
would never move is worse than no column.

## Consequences

- **A new Core table carrying `updated_at` needs a `--custom` migration to attach the
  trigger.** Nothing makes that automatic and the rejected event trigger is what automatic
  would have cost. `packages/core/src/db/updated-at.test.ts` is the guardrail: it asks
  Postgres for every `core_` table carrying the column and fails naming any whose trigger is
  absent **or wearing the name only** — `pg_get_triggerdef` is read, so one firing after the
  write or calling something else is caught too. It proves it is not vacuous by creating both
  of those tables itself.
- **`drizzle-kit` cannot see any of this.** Triggers are not in its schema model, so
  `generate` will neither emit nor drop them — but a future migration that drops and
  recreates a table takes its trigger with it, silently. The guardrail is what notices.
- **The rows already written are not repaired and cannot be.** Their `updated_at` equals
  their `created_at` and no migration can recover when they actually changed.
- **This is hand-written migration SQL**, which #58 is deciding the practice for. It is a
  `--custom` migration generated by `drizzle-kit generate --custom`; only the body is
  written by hand, and `meta/_journal.json` was generated like every other entry.
