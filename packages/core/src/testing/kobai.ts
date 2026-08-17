import type { KobaiProjectConfig, Logger } from "../config.ts";
import { createKobai, type Kobai } from "../kobai.ts";
import type { MigrationOutcome } from "../migrations/run.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";

export type TestKobai = Kobai & {
  /** The throwaway database this instance is bound to. */
  readonly database: TestDatabase;
  /** What `migrate()` returned during setup, or `undefined` when `migrate: false`. */
  readonly migration: MigrationOutcome | undefined;
  /** Closes connections and drops the database. */
  [Symbol.asyncDispose](): Promise<void>;
};

export type TestKobaiOptions = KobaiProjectConfig & {
  /**
   * Skip boot-time migration, to test what the application does before — or instead of —
   * a successful one.
   */
  readonly migrate?: boolean;
  readonly logger?: Logger;
};

/** Says nothing, so a test that expects a failure does not print a wall of noise. */
export const silentLogger: Logger = { info: () => {}, error: () => {} };

/**
 * A booted kobai on a database of its own — the seam every test in this repository should
 * reach for.
 *
 * Requests go in-process (`kobai.request("/admin/store")`), against a real Postgres. Real,
 * because under ADR-0004, ADR-0011 and ADR-0030 the schema and its migrations *are* part of
 * the product, and a fake would skip the thing most likely to break. In-process, because
 * that tests the same surface a Developer calls without allocating a port or supervising a
 * process.
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const merchant = await signInTestMerchant(kobai);
 * const response = await kobai.request("/admin/store", { headers: merchant.headers });
 * ```
 *
 * The admin surface is closed by default, so anything behind it needs a session — see
 * `signInTestMerchant`. `await using` drops the database on the way out; without it,
 * call `close()`.
 */
export async function createTestKobai(options?: TestKobaiOptions): Promise<TestKobai> {
  const database = await createTestDatabase();
  const kobai = createKobai({
    databaseUrl: database.url,
    migrationSets: options?.migrationSets,
    // A Project's Step overrides, so a test can boot with one swapped and ask the API what
    // changed — the seam ADR-0017's promise is actually experienced at.
    workflows: options?.workflows,
    logger: options?.logger ?? silentLogger,
  });

  let migration: MigrationOutcome | undefined;
  try {
    if (options?.migrate !== false) {
      migration = await kobai.migrate();
    }
  } catch (cause) {
    await kobai.close();
    await database.drop();
    throw cause;
  }

  const close = async () => {
    await kobai.close();
    await database.drop();
  };

  return {
    ...kobai,
    database,
    migration,
    close,
    [Symbol.asyncDispose]: close,
  };
}
