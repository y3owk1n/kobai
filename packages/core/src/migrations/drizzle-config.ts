import type { Config } from "drizzle-kit";
import { KOBAI_MIGRATIONS_SCHEMA, migrationsTableFor } from "./set.ts";

/**
 * The `drizzle.config.ts` shape every package that owns tables must use — Core and every
 * Plugin alike.
 *
 * It exists as a function rather than as a documented object so the two things that are
 * easy to get wrong cannot be got wrong: the tracking location is explicit (ADR-0030), and
 * `tablesFilter` is scoped to the package's own prefix.
 */
export type KobaiDrizzleConfigOptions = {
  /** The owning package, e.g. `core` or `plugin-reviews`. Decides the tracking table. */
  package: string;
  /** This package's table prefix, without the underscore — e.g. `core`, `reviews`. */
  tablePrefix: string;
  /** Path to the schema module, relative to the config file. */
  schema: string;
  /** Path to this package's migrations directory, relative to the config file. */
  out: string;
};

export function defineKobaiDrizzleConfig(options: KobaiDrizzleConfigOptions): Config {
  return {
    dialect: "postgresql",
    schema: options.schema,
    out: options.out,
    // `generate` never opens a connection — it diffs the schema against this package's own
    // snapshot journal, which is what lets a Plugin author generate migrations without a
    // database, without Core, and without knowing what else is installed. Only `migrate`
    // needs this, and it fails loudly when it is missing.
    dbCredentials: { url: process.env.DATABASE_URL ?? "" },
    // Set explicitly and identically to what the programmatic migrator uses, so the CLI
    // and boot-time migration agree on where they are tracking. See ADR-0030.
    migrations: {
      table: migrationsTableFor(options.package),
      schema: KOBAI_MIGRATIONS_SCHEMA,
    },
    // Defence in depth, not the primary control. The primary control is that no `push`
    // script exists anywhere. See the `// db:push` note in this package's package.json.
    tablesFilter: [`${options.tablePrefix}_*`],
  };
}
