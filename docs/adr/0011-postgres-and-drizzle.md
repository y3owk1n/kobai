# Postgres, with Drizzle as the ORM

kobai persists to Postgres via Drizzle. The ORM choice follows from ADR-0004 rather than
from preference: because Plugins own their own tables and ship their own migrations, the
ORM must support several independent schema definitions and several independent migration
sets against one database.

## Considered options

- **Prisma** — the best known option, ruled out on the ADR-0004 constraint. Its single
  `schema.prisma` and single migrations directory are architecturally opposed to
  plugin-owned migrations, and reconciling them would mean abandoning either the ORM or the
  ADR.
- **TypeORM** — Vendure's choice, and its entity-per-class model handles distributed schema
  well, but the project is aging and its future is uncertain.
- **Kysely** — maximum control and no opinion to fight, at the cost of writing the
  migration and schema-composition machinery ourselves.
- **Drizzle** — schemas are plain TypeScript defined per package, migrations are per
  package, and its inferred types feed the generated typed client of ADR-0006 directly.

## The open risk, now closed

This ADR originally recorded that multi-set migration support was **believed but not
verified**, with Kysely as the fallback if it did not hold. **It holds.** A throwaway
prototype ran three packages — Core plus two Plugins referencing Core rows by ID with no
foreign key — generating, applying and evolving migrations independently against one
Postgres, including deliberately applying the Plugins *before* Core.

`drizzle-kit generate` diffs a package's schema against its own snapshot journal rather
than against the live database, which is exactly the property ADR-0004 needs: a Plugin
author generates migrations without a database, without Core, and without knowing what else
is installed.

Prototype and full evidence: branch **`prototype/drizzle-multi-migration`**, see its
`FINDINGS.md`. Kysely is not needed.

## What the prototype changed

It surfaced three operational constraints that were not obvious, one of them severe. They
are recorded separately in
[ADR-0030](./0030-generate-and-migrate-only-never-drizzle-kit-push.md), because they
constrain how kobai uses Drizzle rather than whether it does.
