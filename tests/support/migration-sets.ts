import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type WorkspacePackage, workspacePackages } from "./workspace.ts";

/**
 * Which migration sets this repository *ships*, asked of the disk.
 *
 * ADR-0049 banned writing down how many migrations a set has, because every ticket that
 * added one edited five assertions that said so. The same had become true one level up, for
 * which *sets* exist: adding `@kobai/plugin-made-to-order` edited roughly a dozen sites
 * across six files, each spelling the same list a different way — a package path, a set
 * name, a tracking-table name, a manifest key (#129).
 *
 * This module is deliberately the half that **knows nothing about `reference/kobai.config.ts`**.
 * The container and generated-Project tests assert against a booted image or a scaffolded
 * Project from outside, which is the point of those seams, so what they may compare against
 * is the workspace rather than this repository's own Project — and keeping the config out of
 * this module's import graph is what stops that from being only a comment. The other half,
 * which reads the config, is `./wired-migration-sets.ts`.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** What Drizzle reads first: no journal, no migration set, whatever else is on disk. */
const JOURNAL = "migrations/meta/_journal.json";

/**
 * Every workspace package that ships a migration set, discovered rather than listed.
 *
 * A Plugin that ships tables and is wired nowhere still appears here, because the question
 * is what exists on disk — and the journal is what the migration runner reads first, so a
 * package that has one owns a set and a package that has none owns nothing.
 *
 * Finding nothing throws. Failing open would make every caller pass by checking nothing,
 * which is indistinguishable from checking everything — and Core always ships one.
 */
export async function packagesShippingAMigrationSet(): Promise<WorkspacePackage[]> {
  const owners: WorkspacePackage[] = [];

  for (const pkg of await workspacePackages()) {
    const journal = await readFile(resolve(pkg.directory, JOURNAL), "utf8").catch(
      () => null,
    );
    if (journal !== null) owners.push(pkg);
  }

  if (owners.length === 0) {
    throw new Error(
      `No package in the workspace at ${repoRoot} was found to ship a migration set, so whatever asked was checked against nothing. Core always ships one.`,
    );
  }
  return owners;
}

/** One entry of what `/health` says about migrations — the part these findings read. */
export type ReportedMigrationSet = { readonly name: string; readonly applied: number };

/**
 * Every way a booted deployment's account of its migration sets disagrees with what this
 * workspace ships, said one finding at a time. Empty is agreement.
 *
 * **This is the structural form the container and generated-Project tests take**, and it
 * names no set on purpose (#129). Each of them used to recite a list typed into its own
 * file, so every new Plugin was an edit in three places. What they are held to instead is a
 * count from somewhere the container cannot reach: pnpm and the journals on disk. Neither
 * side could have produced the other, which is what makes the comparison a question rather
 * than a restatement.
 *
 * Two findings, because they are two diagnoses. A set that applied nothing is a
 * `migrations/` directory that did not survive being packed or pruned — reported by name,
 * with nothing behind it, which is the quietest way for a Plugin's tables to never exist. A
 * count that does not match is a set the deployment never wired, or one it wired twice, and
 * the finding names what the workspace ships so the reader is not left with two numbers.
 */
export function migrationReportFindings(
  reported: readonly ReportedMigrationSet[],
  shipped: readonly WorkspacePackage[],
): string[] {
  const findings: string[] = [];

  for (const set of reported) {
    if (set.applied === 0) {
      findings.push(
        `The migration set ${JSON.stringify(set.name)} applied nothing, so whatever it was asked to migrate never reached it.`,
      );
    }
  }

  if (reported.length !== shipped.length) {
    findings.push(
      `${reported.length} migration set(s) applied — ${reported.map((set) => set.name).join(", ") || "none"} — and this workspace ships ${shipped.length} package(s) that own one: ${shipped.map((pkg) => pkg.name).join(", ")}.`,
    );
  }

  return findings;
}
