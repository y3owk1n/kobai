import { consoleLogger, type KobaiProjectConfig, type Logger } from "./config.ts";
import { createDatabaseHandle, type Database } from "./db/client.ts";
import { createHttpApp } from "./http/app.ts";
import { coreMigrationSet } from "./migrations/core-set.ts";
import { type MigrationOutcome, runMigrations } from "./migrations/run.ts";
import type { MigrationSet } from "./migrations/set.ts";
import { createMigrationStateHolder, type MigrationState } from "./migrations/state.ts";

export type KobaiOptions = KobaiProjectConfig & {
  /** Postgres connection string. */
  readonly databaseUrl: string;
  readonly logger?: Logger;
};

/**
 * A running kobai: an HTTP surface, a database, and a migration lifecycle.
 *
 * It is deliberately *not* a server. Binding a port is the Project's job — which is also
 * what makes the whole surface testable by dispatching a `Request` straight at `fetch`,
 * with no port to allocate and no process to supervise.
 */
export type Kobai = {
  /** Web-standard handler. A Node server adapts this; a test calls it directly. */
  readonly fetch: (request: Request) => Response | Promise<Response>;
  /** In-process dispatch, for tests and for anything else that already holds the object. */
  request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  readonly db: Database;
  /** Core's set first, then each set the Project wired, in the order it wired them. */
  readonly migrationSets: readonly MigrationSet[];
  /**
   * Applies every migration set. Returns failure rather than throwing: what a failed
   * migration means is the caller's decision, and the reference Project's answer — report
   * it on `/health`, then exit non-zero — is one of several defensible ones.
   */
  migrate(): Promise<MigrationOutcome>;
  migrationState(): MigrationState;
  close(): Promise<void>;
};

export function createKobai(options: KobaiOptions): Kobai {
  const logger = options.logger ?? consoleLogger;
  const database = createDatabaseHandle(options.databaseUrl);
  const migrations = createMigrationStateHolder();

  // Core's own set is one entry in the same list, applied by the same runner as a Plugin's.
  // That is the point: the mechanism third parties depend on is exercised on every commit.
  const migrationSets: readonly MigrationSet[] = [
    coreMigrationSet,
    ...(options.migrationSets ?? []),
  ];

  const app = createHttpApp({ db: database.db, migrations, logger });

  return {
    fetch: app.fetch,
    request: async (input, init) => app.request(input, init),
    db: database.db,
    migrationSets,
    migrationState: () => migrations.get(),

    async migrate() {
      migrations.set({ status: "running" });
      const outcome = await runMigrations(database.db, migrationSets);

      if (outcome.ok) {
        migrations.set({ status: "applied", sets: outcome.sets });
        for (const set of outcome.sets) {
          logger.info("migrations applied", {
            set: set.name,
            table: `${set.migrationsSchema}.${set.migrationsTable}`,
            applied: set.applied,
          });
        }
        return outcome;
      }

      migrations.set({ status: "failed", set: outcome.set, message: outcome.message });
      logger.error("migrations failed", { set: outcome.set, reason: outcome.message });
      return outcome;
    },

    close: () => database.close(),
  };
}
