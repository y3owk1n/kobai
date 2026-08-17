# Findings

**Verdict: ADR-0011 holds. ADR-0004 is implementable on Drizzle. Kysely is not needed.**

Run against `postgres:17-alpine`, `drizzle-orm@0.44.6`, `drizzle-kit@0.31.5`, Node 22.23.2.
Everything below was observed in the output of `devbox run prototype`, not inferred.

## A — independent generation ✅

Each package ran `drizzle-kit generate` with only its own config and emitted **only its own
tables**:

```
core:            CREATE TABLE "core_product"   CREATE TABLE "core_variant"
plugin-reviews:  CREATE TABLE "reviews_review"
plugin-wishlist: CREATE TABLE "wishlist_entry"
```

`generate` diffs the schema against its own snapshot journal in `out/meta`, **not against
the live database**. That is the property ADR-0004 needs: a plugin author can generate
migrations without a database, without Core, and without knowing what else is installed.

## B — separate migration tracking ✅ (with a trap)

Three distinct tracking tables, no collision:

```
drizzle.__drizzle_migrations_core             1 migration(s) recorded
drizzle.__drizzle_migrations_plugin_reviews   2 migration(s) recorded
drizzle.__drizzle_migrations_plugin_wishlist  1 migration(s) recorded
```

**The trap:** they landed in the `drizzle` schema, not `public` — even though every
`drizzle.config.ts` in this prototype says `migrations: { schema: "public" }`. That config
key is read by the `drizzle-kit migrate` **CLI**; the programmatic `migrate()` from
`drizzle-orm/node-postgres/migrator` ignores it and defaults `migrationsSchema` to
`drizzle`. Two code paths, two defaults, no warning.

If Core applies migrations programmatically at boot while a Developer runs `drizzle-kit
migrate` from the CLI, they track in **different schemas** and each will happily re-apply
migrations the other has already run.

> The first run of this prototype reported "migration tracking tables: (none)" because
> `inspect.ts` only queried `public`. The tables were there the whole time. That mistake is
> the finding in miniature.

## C — arbitrary application order ✅

Applied deliberately backwards — `plugin-reviews`, `plugin-wishlist`, then `core` — with no
failures. This works *because* of ADR-0004's no-foreign-key rule: with no FK from a plugin
table into a Core table, there is no cross-package ordering constraint for Postgres to
enforce. The rule was written to protect Core's freedom to alter its own tables; it turns
out to buy order-independence too.

Verified by the inspector: the only FK in the database is `core_variant → core_product`,
which is internal to Core.

## D — independent evolution ✅

Adding one column to `reviews_review` produced `0001_*.sql` in the reviews package alone.
After applying it, reviews recorded 2 migrations while core and wishlist stayed at 1 each,
untouched and never regenerated.

## E — `drizzle-kit push` destroys plugin tables 🚨

This is the significant finding, and it is worse than "push is unsafe".

**Without `tablesFilter`**, pushing *Core's* schema against a database containing plugin
tables reported `[✓] Changes applied` and **silently dropped both plugin tables**:

```
before:  core_product  core_variant  reviews_review  wishlist_entry
after:   core_product  core_variant
```

**And the tracking tables still claim those migrations are applied:**

```
drizzle.__drizzle_migrations_plugin_reviews   2 migration(s) recorded   ← tables are gone
drizzle.__drizzle_migrations_plugin_wishlist  1 migration(s) recorded   ← tables are gone
```

So re-running `migrate` does **not** repair it — Drizzle believes the work is already done.
The damage is silent, total, and not recoverable by any normal recovery step. A clean
failure would have been far better.

**With `tablesFilter: ['core_*']`**, the same push reported `[i] No changes detected` and
left every plugin table intact. The filter is an effective mitigation.

## What this means for kobai

1. **`generate` + `migrate` only. Ship no `push` script, ever.** `push` is a
   single-schema convenience tool and kobai's model guarantees multiple schemas share a
   database. Even with `tablesFilter` it is one config edit away from silent data loss, and
   the upside — skipping a migration file in development — is not worth it.
2. **`tablesFilter` is mandatory** on every package's `drizzle.config.ts`, as defence in
   depth rather than as the primary control.
3. **Set `migrationsSchema` and `migrationsTable` explicitly and identically** in both the
   programmatic migrator and the CLI config. Do not rely on either default.
4. **ADR-0004's no-FK rule is load-bearing for more than it claimed** — it is also what
   makes plugin install order irrelevant.

## Not tested

- Whether a published npm package reliably ships its `migrations/` directory in the tarball
  (a packaging question, not a Drizzle one).
- Concurrent migration of two packages against one database.
- Rollback. Drizzle has no down-migrations; that is a separate decision kobai has not made.
