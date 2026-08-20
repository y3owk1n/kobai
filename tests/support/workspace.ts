import { execFile } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PUBLISHED_KOBAI_PACKAGES } from "create-kobai/authoring";

/**
 * What packages this repository has, asked of pnpm rather than of a list in a test.
 *
 * `pnpm-workspace.yaml` stays the single place packages are declared, so anything that has
 * to enumerate them — which packages ship migrations, which ones a generated Project
 * installs from a registry — asks here and stops being an edit the next Plugin has to
 * remember (#129).
 */

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export type WorkspacePackage = {
  /** Its npm name — what a failure says, and what `pnpm --filter` takes. */
  readonly name: string;
  /** Absolute path to the package directory. */
  readonly directory: string;
  /** Relative to the repository root, which is how `publishPackages` and Docker name it. */
  readonly path: string;
};

/**
 * The workspace as pnpm sees it, root package included.
 *
 * Asked once per test file rather than once per caller: three of them want it, `pnpm list`
 * is a subprocess, and a workspace does not change under a running suite. Spawned from
 * `PATH`, which is where pnpm already is: the suite is running under `pnpm run test`, so the
 * child inherits the same corepack-activated pnpm. Somewhere it is not, the failure would be
 * a bare `spawn pnpm ENOENT`, which says nothing.
 */
export function workspacePackages(): Promise<WorkspacePackage[]> {
  listed ??= listPackages();
  return listed;
}

let listed: Promise<WorkspacePackage[]> | undefined;

async function listPackages(): Promise<WorkspacePackage[]> {
  let stdout: string;
  try {
    ({ stdout } = await run("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "`pnpm list` could not run because pnpm is not on PATH. Run the suite through devbox — see AGENTS.md § Development.",
        { cause },
      );
    }
    throw cause;
  }

  return (JSON.parse(stdout) as { name: string; path: string }[]).map(
    ({ name, path }) => ({
      name,
      directory: resolve(path),
      path: relative(repoRoot, resolve(path)),
    }),
  );
}

/**
 * Where each package a generated Project resolves from a registry lives in this workspace,
 * as the repository-relative paths `publishPackages` takes.
 *
 * **This is a list of packages, not a list of migration sets, and the overlap between them
 * is a coincidence worth naming rather than exploiting.** `@kobai/client` ships no
 * migrations and belongs here; a future Plugin that shipped none would too. Anything asking
 * which *sets* exist wants `./migration-sets.ts` instead — merging the two would make a
 * package publishable by virtue of owning tables, which is not why any of them is published.
 *
 * The names are `create-kobai`'s own `PUBLISHED_KOBAI_PACKAGES`, which is the list the
 * scaffolder uses to rewrite a `workspace:*` into a version range. So the packages a
 * generated Project asks a registry for and the packages a test puts into that registry are
 * one list rather than four copies of it, and can no longer drift into what #129 found: a
 * 404 deep inside an install, naming the registry rather than the list it was missing from.
 *
 * Only the mapping from name to directory is derived, and a name pnpm cannot place throws
 * rather than dropping out — a short list here leaves the registry short and the install
 * failing later, which is the failure this is replacing.
 */
export async function publishedKobaiPackageDirectories(): Promise<string[]> {
  const workspace = await workspacePackages();

  return PUBLISHED_KOBAI_PACKAGES.map((name) => {
    const pkg = workspace.find((candidate) => candidate.name === name);
    if (pkg === undefined) {
      throw new Error(
        `create-kobai says a generated Project resolves ${name} from a registry, and pnpm reports no such package in the workspace at ${repoRoot}, so nothing could publish it.`,
      );
    }
    return pkg.path;
  });
}
