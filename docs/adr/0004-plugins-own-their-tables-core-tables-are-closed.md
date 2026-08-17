# Plugins own their tables; Core's tables are closed

A Plugin owns its own tables and ships its own migrations, referencing Core rows by ID and
never by foreign-key constraint into Core. Core additionally exposes a `metadata` JSON
column on its principal entities for the cheap case where someone just needs to stash a
field. **A Plugin may not add columns to a Core table.** A Project may, because it owns its
own repository and its own migrations and answers to nobody.

## Why not custom fields on Core tables

Vendure and Strapi both let extensions add columns to core tables, and it is the obvious
convenient thing to do. We refuse it because it is the mechanism by which extension systems
break their own stability promise: Core's migrations and a Plugin's migrations begin to
race, two Plugins can collide on a column name, and Core can no longer alter its own tables
without breaking strangers — so it stops altering them, and the schema calcifies. ADR-0003's
promise is only credible if this door stays shut.

## Consequences

- The asymmetry is the teachable rule: **Projects can, Plugins can't.**
- Plugin data that needs to be queried alongside Core data requires a join by ID rather
  than a single-table read. This is a real ergonomic cost and we are accepting it
  deliberately.
- `metadata` is unindexed and untyped by design. If a Plugin needs either, it needs its own
  table.
