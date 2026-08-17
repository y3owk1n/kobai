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

## Open risk

Whether `drizzle-kit` cleanly handles multiple independent migration sets against a single
database — ordering, per-package invocation, a shared migrations table — is **believed but
not verified**, and it is load-bearing for ADR-0004. This should be settled with a
throwaway prototype before Core depends on it. If it does not hold, Kysely is the fallback
and this ADR should be superseded rather than patched.
