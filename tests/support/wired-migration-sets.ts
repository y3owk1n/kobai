import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { coreMigrationSet, type MigrationSet } from "@kobai/core/migrations";
import referenceConfig from "../../reference/kobai.config.ts";
import { type WorkspacePackage, workspacePackages } from "./workspace.ts";

/**
 * Which migration sets this repository's own Project *applies*, asked of the one file that
 * decides it.
 *
 * The other half of #129, and the one that reads `reference/kobai.config.ts`. Deriving from
 * it is what makes wiring a Plugin a line in that config and nothing anywhere else — and it
 * is exactly the move ADR-0049 warns about, because **a derivation compared against its own
 * source agrees with itself**. A set dropped from that file shrinks every expectation built
 * on it.
 *
 * So {@link wiringDisagreements} compares this against `./migration-sets.ts`, which reads
 * the disk and has never heard of the config. Neither can produce the other, and
 * `tests/every-migration-set-is-wired.test.ts` is where that comparison is made — and where
 * it has been watched failing.
 */

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** One migration set this deployment applies, beside the workspace package that ships it. */
export type WiredMigrationSet = {
  readonly set: MigrationSet;
  readonly owner: WorkspacePackage;
};

/**
 * Every migration set the reference Project applies, in the order the runner receives them.
 *
 * Core's first and then each one `reference/kobai.config.ts` names — which is what
 * `createKobai` composes, so this is the same list `/health` reports and the same list
 * `runMigrations` walks.
 *
 * Each set is paired with the workspace package that ships it by **walking up from its
 * `migrationsFolder` to the nearest package pnpm reports**, rather than by assuming
 * `@kobai/${set.name}`. A set's name is the *unscoped* package name, so that guess is right
 * for every package in this repository today and quietly wrong for the first Plugin
 * published under another scope. Walking rather than taking the parent directory because a
 * package resolves its own folder however it likes: a Plugin's is `<root>/migrations`, this
 * Project's is asked of the module resolver, and a set resolved through `dist` would sit a
 * level deeper again.
 *
 * A set whose folder sits under no workspace package throws rather than dropping out: a
 * short list here would make every comparison built on it pass by checking less.
 */
export async function wiredMigrationSets(): Promise<WiredMigrationSet[]> {
  const sets = [coreMigrationSet, ...(referenceConfig.migrationSets ?? [])];
  const workspace = await workspacePackages();

  return sets.map((set) => {
    const owner = packageContaining(resolve(set.migrationsFolder), workspace);
    if (owner === undefined) {
      throw new Error(
        `Migration set ${JSON.stringify(set.name)} resolves its migrations to ${set.migrationsFolder}, which is under no package pnpm reports for the workspace at ${repoRoot}. Nothing can say which package ships it.`,
      );
    }
    return { set, owner };
  });
}

/**
 * The innermost workspace package a path sits under, or `undefined` for none.
 *
 * Innermost, so `packages/core/migrations` is Core's rather than the repository root's —
 * pnpm reports the root package too, and it contains everything.
 */
function packageContaining(
  path: string,
  workspace: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  let at = path;
  while (true) {
    const owner = workspace.find((pkg) => pkg.directory === at);
    if (owner !== undefined) return owner;

    const above = dirname(at);
    if (above === at) return undefined;
    at = above;
  }
}

/**
 * Every way the reference Project's wiring disagrees with the packages on disk, one finding
 * at a time. Empty is agreement.
 *
 * **This is the question the derivations cannot ask about themselves.** Both directions are
 * here because they are two different failures:
 *
 * - A package ships a migration set nobody wires. Its tables are created by no deployment in
 *   this repository, so nothing it does is exercised — on a release gate whose whole claim is
 *   that the reference Project runs everything kobai ships (ADR-0029).
 * - A wired set's package ships no journal. That set applies nothing at boot and says nothing
 *   about it, which is what a `migrations/` directory deleted from a package looks like from
 *   the config's side.
 */
export function wiringDisagreements(
  shipped: readonly WorkspacePackage[],
  wired: readonly WiredMigrationSet[],
): string[] {
  const wiredDirectories = new Set(wired.map(({ owner }) => owner.directory));
  const shippedDirectories = new Set(shipped.map((pkg) => pkg.directory));

  return [
    ...shipped
      .filter((pkg) => !wiredDirectories.has(pkg.directory))
      .map(
        (pkg) =>
          `${pkg.name} ships a migration set that reference/kobai.config.ts does not wire, so nothing in this repository ever creates its tables. Name its set in \`migrationSets\` there, or delete the migrations.`,
      ),
    ...wired
      .filter(({ owner }) => !shippedDirectories.has(owner.directory))
      .map(
        ({ set, owner }) =>
          `reference/kobai.config.ts wires the migration set ${JSON.stringify(set.name)} and ${owner.name} ships no migration journal, so that set applies nothing at boot and says nothing about it.`,
      ),
  ];
}
