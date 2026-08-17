import {
  type InitialMerchantCredentials,
  type InitialMerchantSeed,
  seedInitialMerchant,
} from "./auth/seed.ts";
import { resolveSessionPolicy } from "./auth/session.ts";
import { consoleLogger, type KobaiProjectConfig, type Logger } from "./config.ts";
import { createDatabaseHandle, type Database } from "./db/client.ts";
import {
  type DatabaseReadiness,
  type WaitForDatabaseOptions,
  waitForDatabase,
} from "./db/readiness.ts";
import { createHttpApp, describeHttpApp } from "./http/app.ts";
import type { OpenApiDocument } from "./http/openapi.ts";
import { coreMigrationSet } from "./migrations/core-set.ts";
import { type MigrationOutcome, runMigrations } from "./migrations/run.ts";
import type { MigrationSet } from "./migrations/set.ts";
import { createMigrationStateHolder, type MigrationState } from "./migrations/state.ts";
import { priceResolutionWorkflow } from "./pricing/resolve-price.ts";
import type { WorkflowRegistry } from "./workflow/context.ts";
import { rewireWorkflow } from "./workflow/workflow.ts";

export type KobaiOptions = KobaiProjectConfig & {
  /** Postgres connection string. */
  readonly databaseUrl: string;
  /**
   * Who this deployment's **first** Merchant is, for {@link Kobai.seedInitialMerchant}.
   *
   * A secret, so it belongs here beside `databaseUrl` rather than in the `kobai.config.ts`
   * a Project checks in. The reference Project reads it from its environment
   * (`KOBAI_INITIAL_MERCHANT_EMAIL` and `KOBAI_INITIAL_MERCHANT_PASSWORD`); a Project whose
   * secrets live somewhere else — a vault, a mounted file — builds the object itself, which
   * is the whole reason Core takes the credentials rather than reading the environment for
   * itself.
   */
  readonly initialMerchant?: InitialMerchantCredentials;
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
  /**
   * This instance's OpenAPI description, produced from the routes it serves.
   *
   * Not served over HTTP — `/store` refuses an unauthenticated request before saying
   * whether a path exists, and an endpoint handing out the whole surface anonymously would
   * undo that. It is generated at build time into `packages/core/openapi.json`, which is
   * what `@kobai/client` is generated from and what a Developer in another language reads.
   */
  openapi(): OpenApiDocument;
  readonly db: Database;
  /**
   * Every Workflow declaration this deployment runs, by name — Core's, rebuilt with whatever
   * this Project's config replaced or inserted (ADR-0054).
   *
   * Two audiences. A Developer reads it to see what their deployment actually runs, which is
   * the same question `describe()` answers for one Workflow. And whatever builds a
   * {@link WorkflowContext} puts it there, because that is how a Step invoking another
   * Workflow reaches *this* deployment's version of it rather than Core's default — an
   * override written once, applying wherever that Workflow is reached from.
   */
  readonly workflows: WorkflowRegistry;
  /** Core's set first, then each set the Project wired, in the order it wired them. */
  readonly migrationSets: readonly MigrationSet[];
  /**
   * Waits for the database to accept a connection, up to a deadline. Call it once per boot,
   * before {@link Kobai.migrate}.
   *
   * It exists so that *"the database is not up yet"* and *"a migration failed"* are two
   * answers rather than one (ADR-0048). `migrate()` reaches for the database on its first
   * statement, so without this a Postgres still starting comes back as Core's migration set
   * having failed — a true refusal with a false reason. Waiting is bounded and retried;
   * migrating is neither, and a migration that ran and failed is never retried here or
   * anywhere.
   *
   * Skipping it is not fatal, only less legible: a Project whose platform already orders its
   * containers may call `migrate()` straight away, and the generated Project's compose file
   * orders them too. This is what covers every deployment that offers no such ordering.
   */
  waitForDatabase(options?: WaitForDatabaseOptions): Promise<DatabaseReadiness>;
  /**
   * Applies every migration set. Returns failure rather than throwing: what a failed
   * migration means is the caller's decision, and the reference Project's answer — report
   * it on `/health`, then exit non-zero — is one of several defensible ones.
   */
  migrate(): Promise<MigrationOutcome>;
  /**
   * Creates the deployment's first Merchant from {@link KobaiOptions.initialMerchant}, if it
   * has none yet. Call it once per boot, after {@link Kobai.migrate}.
   *
   * Safe on every boot: a deployment that already holds a Merchant is left exactly as it was
   * found. It reports rather than throws, and does not stop a boot. An unconfigured Merchant
   * is not a broken deployment — it is a working one nobody can administer yet — and a
   * process that exited over it would be indistinguishable, to whatever supervises it, from
   * the failed migration that must exit, while taking `/health` down with it.
   */
  seedInitialMerchant(): Promise<InitialMerchantSeed>;
  migrationState(): MigrationState;
  close(): Promise<void>;
};

export function createKobai(options: KobaiOptions): Kobai {
  // First, and before anything is opened: a window this deployment cannot serve stops the
  // boot here rather than at the first Merchant who notices their sessions are the wrong
  // length. Nothing is clamped, and the message names the key and the bound it missed.
  const sessionPolicy = resolveSessionPolicy(options.session);
  const logger = options.logger ?? consoleLogger;
  const database = createDatabaseHandle(options.databaseUrl);
  const migrations = createMigrationStateHolder();

  // Core's own set is one entry in the same list, applied by the same runner as a Plugin's.
  // That is the point: the mechanism third parties depend on is exercised on every commit.
  const migrationSets: readonly MigrationSet[] = [
    coreMigrationSet,
    ...(options.migrationSets ?? []),
  ];

  // Where a Project's config becomes what actually runs. The declaration is rebuilt with the
  // Steps this Project supplied — replacements in the slots they name, insertions around them
  // — per instance, so a customisation belongs to the deployment that declared it and to no
  // other, and Core's own default is left as it was found.
  const priceWorkflow = rewireWorkflow(
    priceResolutionWorkflow,
    options.workflows?.["resolve-price"] ?? {},
  );

  // The declarations this deployment runs, gathered under the names they answer to. Built
  // here rather than assembled by each caller, because a second answer to "which
  // `resolve-price` is this deployment's" is how an override applies in one place and not in
  // another (ADR-0054).
  const workflows: WorkflowRegistry = { [priceWorkflow.name]: priceWorkflow };

  const app = createHttpApp({
    db: database.db,
    migrations,
    logger,
    priceWorkflow,
    sessionPolicy,
  });

  return {
    fetch: app.fetch,
    request: async (input, init) => app.request(input, init),
    openapi: () => describeHttpApp(app),
    db: database.db,
    workflows,
    migrationSets,
    migrationState: () => migrations.get(),

    async waitForDatabase(options) {
      return waitForDatabase(database.pool, {
        ...options,
        // Said once, and only when there is something to say. A boot against a database that
        // is already up prints nothing at all; a boot that is going to sit here for thirty
        // seconds says why on its first attempt rather than at the end of them.
        onWaiting: ({ message }) =>
          logger.info("waiting for the database", { reason: message }),
      });
    },

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

    async seedInitialMerchant() {
      const seed = await seedInitialMerchant(database.db, options.initialMerchant ?? {});

      // What the boot log says, and what it deliberately never says. **The password is
      // never printed, in any outcome** — it arrived through an environment, so it is
      // already in a compose file or a shell history, and a log is the one copy of it that
      // fans out to every aggregator a deployment ships to.
      //
      // Nor is the *configured* email printed when the configuration could not be used. An
      // operator who swapped the two variables would otherwise have their password written
      // to the log by the very line reporting the mistake. Once a Merchant exists the
      // address is theirs and printing it says which account was created, which is worth
      // knowing and is no longer a guess about what the variable held.
      switch (seed.status) {
        case "seeded":
          logger.info("initial merchant seeded", { email: seed.merchant.email });
          break;
        case "already-present":
          logger.info("initial merchant already present", { created: false });
          break;
        case "not-configured":
          logger.error("no initial merchant", {
            reason:
              "this deployment was given no first Merchant, so nobody can sign in to it",
          });
          break;
        default:
          logger.error("initial merchant not created", { reason: seed.detail });
      }

      return seed;
    },

    close: () => database.close(),
  };
}
