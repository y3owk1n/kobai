/**
 * `@kobai/core/migrations` — the machinery every package that owns tables uses.
 *
 * Core imports exactly this, and so does a Plugin. If it works for Core it works for a
 * Plugin, because there is only one implementation.
 */
export { coreMigrationSet } from "./core-set.ts";
export {
  defineKobaiDrizzleConfig,
  type KobaiDrizzleConfigOptions,
} from "./drizzle-config.ts";
export {
  type AppliedMigrationSet,
  type MigrationOutcome,
  runMigrations,
} from "./run.ts";
export {
  defineMigrationSet,
  KOBAI_MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE_STEM,
  type MigrationSet,
  migrationsTableFor,
} from "./set.ts";
export type { MigrationState } from "./state.ts";
