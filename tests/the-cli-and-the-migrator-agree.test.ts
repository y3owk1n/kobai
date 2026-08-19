import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MIGRATIONS_TABLE_STEM, runMigrations } from "@kobai/core/migrations";
import {
  createTestKobai,
  declaredMigrations,
  inspectSchema,
  type MigrationTrackingFact,
} from "@kobai/core/testing";
import { priceLogMigrationSet } from "@kobai/plugin-price-log";
import { beforeAll, describe, expect, it } from "vitest";
import { packagesShippingAMigrationSet } from "./support/migration-sets.ts";
import {
  type WiredMigrationSet,
  wiredMigrationSets,
  wiringDisagreements,
} from "./support/wired-migration-sets.ts";

/**
 * ADR-0030 rests on one property, and this is where it is asserted rather than remembered.
 *
 * The `drizzle-kit migrate` CLI reads `migrations.schema` and `migrations.table` from a
 * package's `drizzle.config.ts`. The programmatic `migrate()` in `drizzle-orm` ignores that
 * file entirely and falls back to its own defaults. Two code paths, two defaults, no
 * warning — so if Core migrates at boot while a Developer runs the CLI, each tracks
 * somewhere the other does not look and each re-applies what the other already ran. That is
 * why both the table *and* the schema are set explicitly in `defineKobaiDrizzleConfig` and
 * in `defineMigrationSet`, and it is the whole reason those two functions exist.
 *
 * The property held under drizzle-orm 0.45.2 and drizzle-kit 0.31.5, checked **by hand**
 * (#28) — CLI first then programmatic, then the other way round — and the evidence lived in
 * a pull request description. Dependabot now raises drizzle bumps automatically, so the next
 * one depended on somebody remembering this check existed. It no longer does.
 *
 * This is a real subprocess against a real database, because nothing smaller can see the
 * thing: the two migrators are two *implementations*, and only running both proves they read
 * each other's rows. Both orders, because "the CLI recognises what the migrator wrote" and
 * "the migrator recognises what the CLI wrote" are separate claims about separate code.
 * Every set this repository's own Project wires — Core's, each Plugin's and the Project's
 * own — because the drift the prototype found was specifically about a database holding
 * several at once, and one tracking table per package is the arrangement at risk.
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * The migration sets in this database, each beside the workspace package whose
 * `drizzle.config.ts` the CLI reads for it.
 *
 * **Every set the reference Project wires, derived rather than listed** (#129). It was two
 * pairs typed out here, which meant a new Plugin's set was covered only if whoever added it
 * remembered this file — and #128 did not, so `@kobai/plugin-made-to-order` shipped without
 * the two migrators ever having been asked to agree about it. The drift ADR-0030 is about is
 * specifically a database holding *several* sets, so the list that matters is all of them.
 *
 * The pairing is still not `@kobai/${set.name}`. A set's name is the *unscoped* package
 * name, so that guess is right for every package in this repository and quietly wrong for
 * the first Plugin published under another scope; `wiredMigrationSets` matches each set's
 * `migrationsFolder` against pnpm's own view of the workspace instead, and throws rather
 * than dropping a set it cannot attribute.
 *
 * What it cannot see is a set dropped from `reference/kobai.config.ts`, which shrinks this
 * list along with the expectations built from it — the tautology ADR-0049 warns about. That
 * is `tests/every-migration-set-is-wired.test.ts`, which compares that config against the
 * packages on disk.
 */
let SETS: readonly WiredMigrationSet[];

beforeAll(async () => {
  const [shipped, wired] = await Promise.all([
    packagesShippingAMigrationSet(),
    wiredMigrationSets(),
  ]);
  SETS = wired;

  // **A short list would leave both migrators agreeing about less and saying so nowhere**,
  // and every expectation below is derived from this one — so the precondition is asked of
  // the disk rather than of a floor typed here. `tests/every-migration-set-is-wired.test.ts`
  // asserts the same agreement as its subject; this is the guard that keeps *this* file from
  // quietly checking a subset of what it claims to.
  const findings = wiringDisagreements(shipped, wired);
  if (findings.length > 0) {
    throw new Error(
      `This file runs both migrators over every migration set this repository ships, and the reference Project's wiring does not cover them:\n- ${findings.join("\n- ")}`,
    );
  }
});

/**
 * What drizzle-kit prints once it has finished, whether or not it had anything to apply.
 *
 * A string match on another tool's output, which is a real cost: drizzle rewording this
 * turns the file red for no reason, and does it on the bump this test exists to scrutinise.
 * It is kept because the alternative is worse — without it, a run in which the CLI never
 * executed at all is indistinguishable from one in which it ran and correctly did nothing,
 * and the reverse-order test below would pass on the migrator's work alone. That is not
 * hypothetical: `pnpm --filter` matching **no** package prints "No projects matched the
 * filters" and exits **zero**, so a mistyped name in the list above would otherwise take
 * both tests green while running no CLI at all. The failure quotes what was actually
 * printed, so a reworded line upstream is a one-line fix rather than an investigation.
 */
const CLI_SUCCEEDED = "migrations applied successfully";

/**
 * Both halves of this suite need a build first, and the failure without one is unhelpful:
 * `@kobai/plugin-price-log`'s `drizzle.config.ts` imports `@kobai/core/migrations`, which
 * resolves through that package's `exports` to `dist` — the same path a Plugin author
 * outside this repository takes, and deliberately not the source alias `vitest.config.ts`
 * sets up. `devbox run ci` and `devbox run test` both build before the suite; a bare
 * `vitest` does not.
 */
const BUILD_FIRST =
  "It reads a package's drizzle.config.ts, and a Plugin's resolves @kobai/core/migrations through `exports` to dist — so the workspace must be built. Run `devbox run build`, or the whole gate with `devbox run ci`.";

/**
 * Every way this database's migration tracking disagrees with what the sets declare, said
 * one finding at a time. Empty is agreement.
 *
 * Findings rather than a bare assertion because the three failures ADR-0030 names are
 * different diagnoses and `exit 1` is none of them: a table in the wrong schema, a table
 * under a name nothing derives, and the bare `__drizzle_migrations` Drizzle falls back to.
 * The last is the signature of the drift, which is why {@link MIGRATIONS_TABLE_STEM} exists
 * and why `inspectSchema` matches tracking tables on the stem rather than on kobai's prefix.
 */
function disagreements(
  tracking: readonly MigrationTrackingFact[],
  sets: readonly WiredMigrationSet[],
): string[] {
  const findings: string[] = [];
  const declared = new Map(sets.map(({ set }) => [set.migrationsTable, set]));

  for (const fact of tracking) {
    const set = declared.get(fact.table);
    if (fact.table === MIGRATIONS_TABLE_STEM) {
      findings.push(
        `${fact.schema}.${fact.table} is the table Drizzle falls back to when nobody names one, so something applied migrations without setting migrationsTable — the drift ADR-0030 is about.`,
      );
    } else if (set === undefined) {
      findings.push(
        `${fact.schema}.${fact.table} tracks migrations under a name no kobai migration set derives.`,
      );
    } else if (fact.schema !== set.migrationsSchema) {
      findings.push(
        `${fact.schema}.${fact.table} tracks ${set.name}'s migrations outside ${JSON.stringify(set.migrationsSchema)}, the schema its set names.`,
      );
    }
  }

  return findings;
}

/**
 * Runs the real `drizzle-kit migrate` against one database, the way a Developer would.
 *
 * Through `pnpm --filter` rather than `devbox run --`, which runs from the project root and
 * would read the root's `drizzle.config.ts` — there isn't one, and if there were it would be
 * the wrong package's (AGENTS.md § Development). `DATABASE_URL` is the one thing overridden:
 * the config reads it, and devbox exports one pointing at the shared container that this
 * must not touch.
 *
 * It checks that the CLI said it finished, not merely that it exited zero. Without that a
 * test in which the CLI never ran at all would still pass — the programmatic migrator would
 * have done the work and left the database looking exactly right.
 */
async function drizzleKitMigrate(
  { set, owner }: WiredMigrationSet,
  databaseUrl: string,
): Promise<void> {
  const packageName = owner.name;
  let stdout: string;
  try {
    ({ stdout } = await run(
      "pnpm",
      ["--filter", packageName, "exec", "drizzle-kit", "migrate"],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: databaseUrl } },
    ));
  } catch (cause) {
    throw new Error(
      `\`drizzle-kit migrate\` failed for ${packageName} (migration set ${JSON.stringify(set.name)}). If it re-applied a migration that was already applied, that is the disagreement this file is about. ${BUILD_FIRST}`,
      { cause },
    );
  }

  if (!stdout.includes(CLI_SUCCEEDED)) {
    throw new Error(
      `\`drizzle-kit migrate\` exited zero for ${packageName} without saying ${JSON.stringify(CLI_SUCCEEDED)}, so there is no evidence it migrated anything. It printed: ${JSON.stringify(stdout)}`,
    );
  }
}

/**
 * One ordering, applied to both sides of every comparison below.
 *
 * `inspectSchema` sorts in SQL, under Postgres's collation; sorting the expectation in
 * TypeScript would be a second rule that happens to agree on today's rows. Neither side
 * is trusted to be sorted, so no comparison here depends on which rule that was.
 */
function byLocation(facts: readonly MigrationTrackingFact[]): MigrationTrackingFact[] {
  return [...facts].sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table),
  );
}

/**
 * What tracking must look like once every set has been applied **exactly once**.
 *
 * The counts come from each set's own journal rather than from a number written here, so a
 * new migration does not turn this file red — it is about the two migrators agreeing, not
 * about how many migrations kobai has. This file read the journal itself until #34 gave
 * `@kobai/core/testing` the same question to answer for every test that had a count
 * written into it (ADR-0049), so there is now one reader of it.
 */
async function appliedExactlyOnce(
  sets: readonly WiredMigrationSet[],
): Promise<MigrationTrackingFact[]> {
  return byLocation(
    await Promise.all(
      sets.map(async ({ set }) => ({
        schema: set.migrationsSchema,
        table: set.migrationsTable,
        applied: (await declaredMigrations(set)).length,
      })),
    ),
  );
}

/**
 * The whole agreement, asserted about one database: every set tracked where — and only
 * where — its own definition says, with a row for each of its migrations and no others.
 */
async function expectAgreement(
  tracking: readonly MigrationTrackingFact[],
): Promise<void> {
  expect(disagreements(tracking, SETS)).toEqual([]);
  expect(byLocation(tracking)).toEqual(await appliedExactlyOnce(SETS));
}

describe("the drizzle-kit CLI and the programmatic migrator", () => {
  it("leaves the CLI's work alone when the migrator follows it", async () => {
    await using kobai = await createTestKobai({ migrate: false });
    const schema = inspectSchema(kobai.database);

    for (const tracked of SETS) await drizzleKitMigrate(tracked, kobai.database.url);
    const afterTheCli = await schema.migrationTracking();
    await expectAgreement(afterTheCli);

    const outcome = await runMigrations(
      kobai.db,
      SETS.map(({ set }) => set),
    );

    // A migrator that disagreed would find its own tracking table empty and re-run
    // `create table "core_store"`, which Postgres refuses — so `ok` is load-bearing here.
    // What it *reports* is load-bearing too, and is the direct statement of agreement: each
    // count is read back from the schema and table that set's own definition names, so
    // seeing the CLI's rows there is the migrator having looked exactly where the CLI wrote.
    // Without this the test would pass over a migrator that did nothing whatsoever.
    expect(outcome).toEqual({
      ok: true,
      sets: await Promise.all(
        SETS.map(async ({ set }) => ({
          name: set.name,
          migrationsTable: set.migrationsTable,
          migrationsSchema: set.migrationsSchema,
          applied: (await declaredMigrations(set)).length,
        })),
      ),
    });
    // The same rows as before it ran: it recognised the CLI's work and applied nothing.
    expect(await schema.migrationTracking()).toEqual(afterTheCli);
  });

  it("leaves the migrator's work alone when the CLI follows it", async () => {
    await using kobai = await createTestKobai({ migrate: false });
    const schema = inspectSchema(kobai.database);

    // Backwards, because no foreign key crosses from a Plugin table into a Core table and
    // the order among *those* is therefore the caller's (ADR-0004). If it mattered, it would
    // matter here.
    //
    // **Core's stays in front, and that asymmetry is a decision rather than a convenience.** A
    // Plugin ships to Projects it has never seen and may not touch Core's tables at all; a
    // Project owns its whole database and may, which is the rule
    // `reference/src/db/schema.ts` already states from the other side. The reference Project
    // exercises it — `migrations/0001_the_store_prices_in_myr.sql` writes `core_store`, because
    // a Store's default currency is fixed once it is set and no route will ever move it
    // (ADR-0065) — so that set depends on Core's having run, and applying it first fails
    // loudly rather than quietly leaving the Store on Core's placeholder. That is the order
    // `createKobai` composes, Core's set in front of everything `kobai.config.ts` wires, and
    // the only order any deployment applies.
    const [core, ...plugins] = SETS;
    expect(core?.set.name, "Core's set is no longer first in `wiredMigrationSets`").toBe(
      "core",
    );
    const outcome = await runMigrations(kobai.db, [
      ...(core ? [core.set] : []),
      ...plugins.reverse().map(({ set }) => set),
    ]);
    expect(outcome).toMatchObject({ ok: true });
    const afterTheMigrator = await schema.migrationTracking();
    await expectAgreement(afterTheMigrator);

    for (const tracked of SETS) await drizzleKitMigrate(tracked, kobai.database.url);

    // The CLI recognising the migrator's rows is visible only as its *not* having re-run
    // anything: it would have failed on `create table "core_store"` otherwise, and
    // `drizzleKitMigrate` accepts neither a non-zero exit nor a silent one.
    expect(await schema.migrationTracking()).toEqual(afterTheMigrator);
  });
});

/**
 * The assertion above is only worth having if it can fail, so each of the three tables
 * ADR-0030 forbids is forced into a real database here and the finding it produces is named.
 * Injected directly rather than provoked out of drizzle, because there is no supported way
 * to make either migrator track in the wrong place — which is the point of the ADR.
 */
describe("a tracking table where ADR-0030 forbids one", () => {
  it("is a finding when it is in the wrong schema", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });

    await kobai.database.query(
      "create table public.__drizzle_migrations_core (id serial primary key)",
    );

    const tracking = await inspectSchema(kobai.database).migrationTracking();

    expect(disagreements(tracking, SETS)).toEqual([
      'public.__drizzle_migrations_core tracks core\'s migrations outside "drizzle", the schema its set names.',
    ]);
  });

  it("is a finding when it is under a name no set derives", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });

    await kobai.database.query(
      "create table drizzle.__drizzle_migrations_kore (id serial primary key)",
    );

    const tracking = await inspectSchema(kobai.database).migrationTracking();

    expect(disagreements(tracking, SETS)).toEqual([
      "drizzle.__drizzle_migrations_kore tracks migrations under a name no kobai migration set derives.",
    ]);
  });

  it("is a finding when it is the bare __drizzle_migrations", async () => {
    await using kobai = await createTestKobai({ migrationSets: [priceLogMigrationSet] });

    await kobai.database.query(
      "create table drizzle.__drizzle_migrations (id serial primary key)",
    );

    const tracking = await inspectSchema(kobai.database).migrationTracking();

    expect(disagreements(tracking, SETS)).toEqual([
      "drizzle.__drizzle_migrations is the table Drizzle falls back to when nobody names one, so something applied migrations without setting migrationsTable — the drift ADR-0030 is about.",
    ]);
  });
});
