import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InitialMerchantCredentials } from "../auth/seed.ts";
import type { KobaiProjectConfig, Logger } from "../config.ts";
import { createKobai, type Kobai } from "../kobai.ts";
import { filesystemMediaStorage } from "../media/storage.ts";
import type { MigrationOutcome } from "../migrations/run.ts";
import { createTestDatabase, type TestDatabase } from "./database.ts";
import { testPaymentProvider } from "./payments.ts";

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
  /**
   * What this deployment was configured with, for a test whose subject is seeding.
   *
   * Nothing is seeded by creating the harness, deliberately: `seedInitialMerchant()` is a
   * separate call at boot, and a test about what it does has to be able to watch it happen.
   * A test that just needs somebody signed in reaches for `signInTestMerchant` instead.
   */
  readonly initialMerchant?: InitialMerchantCredentials;
  /**
   * Skip the default Region a boot seeds, for a test whose subject is that seeding (#292).
   *
   * **Seeded by default, where the first Merchant deliberately is not**, and the asymmetry is
   * the decision. A Merchant is a credential a deployment supplies, and a test about a Role
   * being too narrow has to control which one exists; a default Region is derived from the
   * Store's own currency, is what every route that prices something falls back to, and a
   * deployment that has booted has one — so a harness without it would put every test in this
   * repository in a state a real deployment leaves within a second of starting, and
   * `GET /store/variants/{id}/price` would answer 400 to a request that names no Region.
   *
   * `false` is that pre-boot state, and there is no other way back to it: nothing on the
   * promised surface unsets `core_store.default_region_id`, because leaving a Store without one
   * is not a state a Merchant should be able to reach (ADR-0059).
   */
  readonly defaultRegion?: boolean;
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

  // Media goes in a directory of this instance's own, and it is dropped with the database.
  //
  // Core's default writes under the **process's** working directory, which for a test run is
  // the repository — so a suite on the stock configuration would leave a Merchant's uploads in
  // the checkout, and every test in it would be sharing one. This is the same courtesy
  // `testPaymentProvider` and `silentLogger` are, and it is the rule the ticket that built this
  // states: nothing in the gate reaches a network or a real object store, so every test either
  // substitutes a `MediaStorage` or points the shipped one somewhere throwaway. A test whose
  // subject *is* a storage passes its own, exactly as one about payment passes its own
  // provider.
  const mediaDirectory = await mkdtemp(join(tmpdir(), "kobai-media-"));

  // `createKobai` refuses a configuration it cannot serve, so a test whose subject is one has
  // a database already standing behind it. Dropped here rather than left for whatever runs
  // next, exactly as the migration failure below does it — a suite that leaks a database per
  // rejected config is a suite that gets slower the more of them it asserts.
  let kobai: Kobai;
  try {
    kobai = createKobai({
      databaseUrl: database.url,
      initialMerchant: options?.initialMerchant,
      migrationSets: options?.migrationSets,
      // A Project's Step overrides, so a test can boot with one swapped and ask the API what
      // changed — the seam ADR-0017's promise is actually experienced at.
      workflows: options?.workflows,
      // Likewise for a deployment that sets its own session idle window (ADR-0050): a test
      // boots with the same key a `kobai.config.ts` carries, and an unusable one is refused
      // here exactly as it would be at a Project's boot.
      session: options?.session,
      // And for a deployment that sets its own hold window (ADR-0075), which is the same
      // story one key along: the number a test boots with is the number a placement writes
      // onto the row, and one Core will not enforce is refused here rather than served.
      reservations: options?.reservations,
      // A provider that pays, unless the test said otherwise — the same courtesy as
      // `silentLogger`, and for the same reason: Core ships none (ADR-0053), so without one
      // every test that places an Order would be a test about not having a Payment Provider.
      // Saying `payments: {}` is how a test asks for the deployment that has none.
      payments: options?.payments ?? { provider: testPaymentProvider },
      // The Fulfilment Strategies this deployment wired, so a test can boot with a Plugin's
      // and boot without it — which is the whole of what ADR-0017 promises. Nothing is
      // defaulted: a deployment that says nothing has Core's `physical` and `digital`, and
      // that is what almost every test in this repository should be.
      fulfilment: options?.fulfilment,
      // The storage this instance's uploads land in, unless the test named one — which is what
      // a test whose subject is substitution does, and what one about the shipped storage does
      // to point it at a directory it can then look inside.
      //
      // **The subject is merged and never replaced**, which stopped being a nicety the day it
      // grew a second key (#278): a test that says `media: { maxBytes: 4096 }` is saying
      // nothing whatever about where bytes go, and replacing the whole subject handed it
      // `filesystemMediaStorage()`'s default — `kobai-media/` under the *process's* working
      // directory, which for a test run is this repository. That is #254's finding arriving
      // through a new door, and `.gitignore` is why `git status` would never have shown it.
      media: {
        ...options?.media,
        storage:
          options?.media?.storage ??
          filesystemMediaStorage({ directory: mediaDirectory }),
      },
      logger: options?.logger ?? silentLogger,
    });
  } catch (cause) {
    await database.drop();
    await rm(mediaDirectory, { recursive: true, force: true });
    throw cause;
  }

  let migration: MigrationOutcome | undefined;
  try {
    if (options?.migrate !== false) {
      migration = await kobai.migrate();
      // Exactly what a boot does next, and for the reason a boot does it: every route that
      // prices something falls back to this Region when a request names none, so a harness
      // that skipped it would leave every test in a state no running deployment is in
      // (#292, ADR-0074). A test whose subject *is* the seeding says `defaultRegion: false`
      // and calls `kobai.seedDefaultRegion()` itself, which is what `store/seed.test.ts` does.
      //
      // Never without the migration ahead of it: there is no `core_store` to derive one from,
      // and the seed reports `not-usable` rather than raising — so this would silently do
      // nothing and the harness would look as though it had.
      if (options?.defaultRegion !== false) await kobai.seedDefaultRegion();
    }
  } catch (cause) {
    await kobai.close();
    await database.drop();
    await rm(mediaDirectory, { recursive: true, force: true });
    throw cause;
  }

  const close = async () => {
    await kobai.close();
    await database.drop();
    await rm(mediaDirectory, { recursive: true, force: true });
  };

  return {
    ...kobai,
    database,
    migration,
    close,
    [Symbol.asyncDispose]: close,
  };
}
