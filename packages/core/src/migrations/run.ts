import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { quoteIdentifier } from "../db/identifier.ts";
import type { MigrationSet } from "./set.ts";

/** What one set looks like once it has been applied. Reported by the health endpoint. */
export type AppliedMigrationSet = {
  readonly name: string;
  readonly migrationsTable: string;
  readonly migrationsSchema: string;
  /** Rows in this set's tracking table — how many of its migrations the database has seen. */
  readonly applied: number;
};

export type MigrationOutcome =
  | { readonly ok: true; readonly sets: readonly AppliedMigrationSet[] }
  | {
      readonly ok: false;
      /** The set that failed. `null` when the failure was not attributable to one. */
      readonly set: string | null;
      readonly message: string;
      readonly cause: unknown;
    };

/**
 * Applies each set in turn against one database.
 *
 * Order is the caller's, and deliberately does not matter: no foreign key points from a
 * Plugin table into a Core table, so Postgres imposes no cross-package ordering constraint
 * (ADR-0004). A Project installs Plugins in whatever order it likes, and a test may prove
 * it by handing the sets over backwards:
 *
 * ```ts
 * const kobai = await createTestKobai({ migrate: false });
 * await runMigrations(kobai.db, [pluginSet, coreMigrationSet]);
 * ```
 *
 * Failure is returned rather than thrown, because the caller — not this function — decides
 * what a half-migrated database means. The reference Project's answer is to report it on
 * the health endpoint and then exit non-zero.
 */
export async function runMigrations<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  sets: readonly MigrationSet[],
): Promise<MigrationOutcome> {
  const applied: AppliedMigrationSet[] = [];

  for (const set of sets) {
    try {
      await migrate(db, {
        migrationsFolder: set.migrationsFolder,
        migrationsTable: set.migrationsTable,
        migrationsSchema: set.migrationsSchema,
      });
      applied.push({
        name: set.name,
        migrationsTable: set.migrationsTable,
        migrationsSchema: set.migrationsSchema,
        applied: await countApplied(db, set),
      });
    } catch (cause) {
      return {
        ok: false,
        set: set.name,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
    }
  }

  return { ok: true, sets: applied };
}

async function countApplied<TSchema extends Record<string, unknown>>(
  db: NodePgDatabase<TSchema>,
  set: MigrationSet,
): Promise<number> {
  const table = sql.raw(
    `${quoteIdentifier(set.migrationsSchema)}.${quoteIdentifier(set.migrationsTable)}`,
  );
  const result = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from ${table}`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
