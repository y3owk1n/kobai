# PROTOTYPE — drizzle multi-migration

**Throwaway. Do not import from this. Do not merge to main.**

## The question

[ADR-0004](../../docs/adr/0004-plugins-own-their-tables-core-tables-are-closed.md) says a
Plugin owns its own tables and ships its own migrations, referencing Core rows by ID and
never by foreign key. [ADR-0011](../../docs/adr/0011-postgres-and-drizzle.md) chose Drizzle
*because of* that constraint, and recorded the assumption as **believed but not verified**:

> Whether `drizzle-kit` cleanly handles multiple independent migration sets against a single
> database — ordering, per-package invocation, a shared migrations table — is believed but
> not verified, and it is load-bearing for ADR-0004. If it does not hold, Kysely is the
> fallback and ADR-0011 should be superseded rather than patched.

This prototype answers exactly that, and nothing else.

## The five things it checks

| | Question | Why it matters |
|---|---|---|
| **A** | Does `drizzle-kit generate` for one package emit *only* that package's tables, without knowing about the others? | If generation needs global knowledge, plugins can't ship migrations independently. |
| **B** | Can each package track its own migrations in its own table? | One shared `__drizzle_migrations` table means Core and Plugins race, which is the exact failure ADR-0004 exists to prevent. |
| **C** | Can migration sets be applied in **any** order, including plugins before Core? | A Project installs plugins in whatever order it likes. |
| **D** | Does evolving one package leave the others' migration state untouched? | This is the upgrade story from ADR-0001. |
| **E** | Is `drizzle-kit push` safe here — or does it propose dropping tables it doesn't own? | If `push` is unsafe, that's a real constraint on Developer workflow that has to be documented, not discovered. |

## Model under test

Deliberately mirrors ADR-0004 — plugin tables reference `core_variant` **by ID with no FK
constraint**:

```
core            → core_product, core_variant
plugin-reviews  → reviews_review   (variant_id uuid, no FK)
plugin-wishlist → wishlist_entry   (variant_id uuid, no FK)
```

## Run it

```sh
devbox run prototype
```

That's the whole thing: it starts a disposable Postgres in Docker, runs all five checks,
prints a verdict, and tears the container down. Nothing persists — the database uses
`tmpfs`, and the container is named `kobai-prototype-wipe-me` so it's obvious what it is.

## Deliberate simplifications

- **Not a pnpm workspace.** Dependencies are installed once at the prototype root and the
  three "packages" are just directories with their own `drizzle.config.ts` and `migrations/`
  folder. Drizzle doesn't care about npm package boundaries; it cares about config and
  output folders, which is what's being tested. This does *not* test that a published plugin
  can ship a `migrations/` directory in its npm tarball — that's a packaging question, not a
  Drizzle one.
- **No error handling, no tests, no abstractions.** It's a prototype.

## Verdict

See [FINDINGS.md](./FINDINGS.md), written after the first run.
