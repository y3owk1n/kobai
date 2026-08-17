/**
 * A migration set is one package's claim on the database: its own migration files, tracked
 * in its own table, in an explicitly named schema.
 *
 * Core has one. Every Plugin has one. They are the same kind of thing on purpose — Core's
 * own migrations run through the machinery a Plugin uses, so the mechanism is exercised on
 * every commit rather than only by third parties (ADR-0004, ADR-0025).
 */

/**
 * The schema every kobai migration set tracks into.
 *
 * This is set explicitly wherever migrations are applied, and never defaulted. The
 * `drizzle-kit migrate` CLI reads `migrations.schema` from `drizzle.config.ts`; the
 * programmatic `migrate()` in `drizzle-orm` ignores that file entirely and falls back to
 * `drizzle`. Two code paths, two defaults, no warning — so if Core migrated programmatically
 * at boot while a Developer ran the CLI, each would track in a different schema and each
 * would happily re-apply what the other had already run. See ADR-0030.
 */
export const KOBAI_MIGRATIONS_SCHEMA = "drizzle";

export type MigrationSet = {
  /** The owning package, e.g. `core` or `plugin-reviews`. Identifies the set in health output. */
  readonly name: string;
  /** Absolute path to the directory `drizzle-kit generate` writes into. */
  readonly migrationsFolder: string;
  /** This set's own tracking table. Never shared with another set. */
  readonly migrationsTable: string;
  /** Always explicit. See {@link KOBAI_MIGRATIONS_SCHEMA}. */
  readonly migrationsSchema: string;
};

/**
 * What any Drizzle tracking table's name begins with — kobai's, and the bare
 * `__drizzle_migrations` the tooling falls back to when nobody names one.
 *
 * kobai always names one. The stem is worth knowing anyway, because a table sitting at it
 * is the signature of migrations having been applied through a path that did not set
 * `migrationsTable`, which is the drift ADR-0030 is about.
 */
export const MIGRATIONS_TABLE_STEM = "__drizzle_migrations";
/** What every *kobai* tracking table's name begins with, whoever owns it. */
export const MIGRATIONS_TABLE_PREFIX = `${MIGRATIONS_TABLE_STEM}_`;
/** Postgres truncates identifiers at 63 bytes, and a truncated table is a shared table. */
const MAX_IDENTIFIER_BYTES = 63;
/**
 * npm's own naming rules, minus the scope. Names map one-to-one onto tracking tables only
 * if `-` is the sole separator — otherwise `plugin-reviews` and `plugin_reviews` would both
 * slug to `plugin_reviews` and quietly share a table.
 */
const PACKAGE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The tracking table a package of this name owns.
 *
 * Derived rather than configured, and derived reversibly: distinct names always produce
 * distinct tables, so two packages cannot accidentally agree on one and race each other.
 * That is the whole reason the name is validated instead of merely sanitised.
 */
export function migrationsTableFor(packageName: string): string {
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(
      `Migration set name ${JSON.stringify(packageName)} is not usable. Use the unscoped npm package name — lowercase letters and digits separated by single hyphens, e.g. "core" or "plugin-reviews".`,
    );
  }

  const table = `${MIGRATIONS_TABLE_PREFIX}${packageName.replaceAll("-", "_")}`;
  if (table.length > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Migration set name ${JSON.stringify(packageName)} is too long: its tracking table "${table}" exceeds Postgres's ${MAX_IDENTIFIER_BYTES}-byte identifier limit and would be truncated into a collision.`,
    );
  }
  return table;
}

export function defineMigrationSet(options: {
  name: string;
  /** Absolute path — a package resolves its own, typically from `import.meta.url`. */
  migrationsFolder: string;
}): MigrationSet {
  return {
    name: options.name,
    migrationsFolder: options.migrationsFolder,
    migrationsTable: migrationsTableFor(options.name),
    migrationsSchema: KOBAI_MIGRATIONS_SCHEMA,
  };
}
