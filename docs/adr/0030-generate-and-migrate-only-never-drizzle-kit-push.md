# `generate` and `migrate` only — never `drizzle-kit push`

kobai uses `drizzle-kit generate` plus a migration runner, and **ships no `push` script in
Core, in any Plugin, or in what `create-kobai` generates**. In addition, every package's
`drizzle.config.ts` must set `tablesFilter` scoped to its own table prefix, and both
`migrationsSchema` and `migrationsTable` must be set **explicitly** wherever migrations are
applied.

All three follow from the prototype on branch `prototype/drizzle-multi-migration`; its
`FINDINGS.md` has the observed output.

## Why `push` is banned rather than discouraged

`drizzle-kit push` diffs a schema against the **live database**, unlike `generate`. Pushing
Core's schema against a database containing Plugin tables reported `[✓] Changes applied` and
**silently dropped every Plugin table**.

Worse than the drop: the Plugins' migration tracking tables still recorded their migrations
as applied. Drizzle therefore believes the work is done, and re-running the migration runner
**does not repair it**. The damage is silent, total, and outside the reach of any normal
recovery step. A loud failure would have been enormously better.

`tablesFilter` does mitigate it — the same push, filtered to `core_*`, reported no changes
and left everything intact. But kobai's model guarantees that plugin tables share a
database, so `push` is permanently one config edit away from destroying a Project's data,
and the only thing it buys is skipping a migration file during development. That is not a
trade worth having available.

## Why the tracking location must be explicit

The `drizzle-kit migrate` CLI reads `migrations.schema` from `drizzle.config.ts`. The
programmatic `migrate()` in `drizzle-orm` ignores it and defaults to the `drizzle` schema.
Two code paths, two defaults, no warning. If Core migrates programmatically at boot while a
Developer runs the CLI, they track in different schemas and each re-applies what the other
already ran.

## Consequences

- `create-kobai` generates no `db:push` script, and the documentation should say why rather
  than leave its absence looking like an oversight.
- `tablesFilter` is defence in depth, not the primary control. The primary control is that
  the dangerous command is never available.
