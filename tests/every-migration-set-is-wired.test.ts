import { describe, expect, it } from "vitest";
import {
  migrationReportFindings,
  packagesShippingAMigrationSet,
} from "./support/migration-sets.ts";
import {
  type WiredMigrationSet,
  wiredMigrationSets,
  wiringDisagreements,
} from "./support/wired-migration-sets.ts";
import type { WorkspacePackage } from "./support/workspace.ts";

/**
 * The question every other migration-set assertion in this repository now derives its way
 * out of answering.
 *
 * Since #129, `reference/src/server.test.ts` and `tests/the-cli-and-the-migrator-agree.test.ts`
 * take their expectation from what the reference Project wires, and the three container
 * tests take theirs from what this workspace ships. That removes the tax a new Plugin used
 * to pay and it costs one thing, which ADR-0049 names exactly: **a derivation compared
 * against its own source agrees with itself.** A set dropped from `reference/kobai.config.ts`
 * shrinks the config-derived expectations along with the thing they check.
 *
 * So this file compares that config against something it cannot produce: the packages on
 * disk. A Plugin that ships a `migrations/` directory and is wired nowhere has tables no
 * deployment in this repository ever creates — untested by construction, on a release gate
 * whose whole claim is that the reference Project exercises everything kobai ships
 * (ADR-0029). It is also the fastest thing in the suite that can say so: the container tests
 * reach the same conclusion by counting, but only after building an image or standing up a
 * registry, and only against a deployment rather than against the config that wired it.
 */
describe("the migration sets this workspace ships", () => {
  it("are all wired into the reference Project, and every wired one is shipped", async () => {
    const [shipped, wired] = await Promise.all([
      packagesShippingAMigrationSet(),
      wiredMigrationSets(),
    ]);

    // Two lists compared elsewhere would both be short and agree. Neither is derived from
    // the other here, so a floor on each is what keeps this from passing by finding
    // nothing: Core ships one, and the whole point of the reference Project is that at least
    // one Plugin's set is applied beside it (ADR-0017).
    expect(shipped.map((pkg) => pkg.name)).toContain("@kobai/core");
    expect(wired.length).toBeGreaterThan(1);

    expect(wiringDisagreements(shipped, wired)).toEqual([]);
  });
});

/**
 * Every assertion above is only worth having if it can fail, and a repository where
 * everything agrees cannot demonstrate that. So each reporting function #129 introduced is
 * driven below against a workspace, and a deployment, written to offend.
 *
 * This is the same demonstration `packages/core/src/testing/migrations.test.ts` holds for
 * ADR-0049's pairing, for the same reason: an emptiness assertion nobody has ever seen fail
 * is not yet known to be able to.
 */
const core: WorkspacePackage = {
  name: "@kobai/core",
  directory: "/w/packages/core",
  path: "packages/core",
};
const reviews: WorkspacePackage = {
  name: "@kobai/plugin-reviews",
  directory: "/w/packages/plugin-reviews",
  path: "packages/plugin-reviews",
};
const wire = (owner: WorkspacePackage): WiredMigrationSet => ({
  set: {
    name: owner.name.replace("@kobai/", ""),
    migrationsFolder: `${owner.directory}/migrations`,
    migrationsTable: "__drizzle_migrations_x",
    migrationsSchema: "drizzle",
  },
  owner,
});

describe("reporting a migration set that is wired or shipped and not both", () => {
  it("finds nothing when every shipped set is wired and every wired one shipped", () => {
    expect(wiringDisagreements([core, reviews], [wire(core), wire(reviews)])).toEqual([]);
  });

  it("names the package whose tables no deployment would create", () => {
    expect(wiringDisagreements([core, reviews], [wire(core)])).toEqual([
      "@kobai/plugin-reviews ships a migration set that reference/kobai.config.ts does not wire, so nothing in this repository ever creates its tables. Name its set in `migrationSets` there, or delete the migrations.",
    ]);
  });

  it("names the wired set whose package ships no journal", () => {
    expect(wiringDisagreements([core], [wire(core), wire(reviews)])).toEqual([
      'reference/kobai.config.ts wires the migration set "plugin-reviews" and @kobai/plugin-reviews ships no migration journal, so that set applies nothing at boot and says nothing about it.',
    ]);
  });
});

/**
 * The same demonstration for the structural half — the one the three container tests
 * assert through, each of which takes twenty minutes and needs an image or a registry
 * before it can say anything at all. This drives its reporting in milliseconds, against
 * reports written to offend.
 */
describe("reporting a booted deployment's migration sets", () => {
  it("finds nothing when every shipped set applied something", () => {
    expect(
      migrationReportFindings(
        [
          { name: "core", applied: 9 },
          { name: "plugin-reviews", applied: 1 },
        ],
        [core, reviews],
      ),
    ).toEqual([]);
  });

  it("names the set that applied nothing, which is a `migrations/` that did not ship", () => {
    expect(
      migrationReportFindings(
        [
          { name: "core", applied: 9 },
          { name: "plugin-reviews", applied: 0 },
        ],
        [core, reviews],
      ),
    ).toEqual([
      'The migration set "plugin-reviews" applied nothing, so whatever it was asked to migrate never reached it.',
    ]);
  });

  it("says what the workspace ships when a set the deployment never wired is missing", () => {
    expect(
      migrationReportFindings([{ name: "core", applied: 9 }], [core, reviews]),
    ).toEqual([
      "1 migration set(s) applied — core — and this workspace ships 2 package(s) that own one: @kobai/core, @kobai/plugin-reviews.",
    ]);
  });
});
