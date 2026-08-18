import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Every package this workspace needs only in order to build, and never in order to run.
 *
 * Derived rather than listed, because a list is a sample and the claim is total: #12 names
 * four offenders it measured, and the four are what a hand-written list would hold — while
 * `verdaccio`, `openapi-typescript` and every future tool would go on shipping unnoticed.
 *
 * The derivation is a subtraction: every `devDependencies` entry anywhere in the workspace,
 * minus everything in the **production** dependency closure. The second half is what makes
 * it correct rather than merely strict, and it is not a formality — four names are on both
 * sides for four different reasons. `jsonc-parser` is a devDependency of the root and a real
 * dependency of `create-kobai`. `yaml` is a devDependency of the root and arrives in
 * production anyway under `openapi3-ts`. `@types/pg` is a devDependency of Core and an
 * auto-installed peer of `drizzle-orm`. `@types/node` comes in under `@types/pg`. Every one
 * of them is legitimately in a production image, and a check that flagged them would be
 * turned off within a week.
 */
export async function devOnlyDependencies(): Promise<string[]> {
  const [devDependencies, production] = await Promise.all([
    declaredDevDependencies(),
    productionClosure(),
  ]);

  return [...devDependencies].filter((name) => !production.has(name)).sort();
}

/** The workspace as pnpm sees it, so `pnpm-workspace.yaml` stays the one place it is declared. */
async function pnpmList(args: string[]): Promise<unknown> {
  const { stdout } = await run(
    "pnpm",
    ["list", "--recursive", "--json", ...args],
    // The production closure of a workspace this size is well over 100 KB of JSON.
    { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function declaredDevDependencies(): Promise<Set<string>> {
  const projects = (await pnpmList(["--depth", "-1"])) as { path: string }[];

  const names = new Set<string>();
  for (const { path } of projects) {
    const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    for (const name of Object.keys(manifest.devDependencies ?? {})) names.add(name);
  }

  if (names.size === 0) {
    // Failing open would make every assertion built on this pass over an empty list.
    throw new Error(
      "No workspace package declares a devDependency, so an image was checked for nothing. The repository root always declares several.",
    );
  }
  return names;
}

type DependencyTree = Record<string, { dependencies?: DependencyTree }>;

async function productionClosure(): Promise<Set<string>> {
  const projects = (await pnpmList(["--prod", "--depth", "Infinity"])) as {
    dependencies?: DependencyTree;
    optionalDependencies?: DependencyTree;
  }[];

  const names = new Set<string>();
  const walk = (tree: DependencyTree | undefined) => {
    for (const [name, node] of Object.entries(tree ?? {})) {
      names.add(name);
      walk(node.dependencies);
    }
  };
  for (const project of projects) {
    walk(project.dependencies);
    walk(project.optionalDependencies);
  }
  return names;
}

/**
 * Everything the Admin declares as a devDependency, which is everything that builds it.
 *
 * Read out of the manifest rather than copied into a test, because ADR-0033 declares that
 * package's entire toolchain a devDependency for exactly this reason — `vite build` inlines
 * React, Base UI, Tailwind's output and the fonts into `dist`, and nothing in that list is
 * required by the Node process at runtime. So a component added with `shadcn add`, which
 * writes its own dependencies into that file, is covered without an edit anywhere.
 *
 * `@kobai/*` are dropped. Inside this repository they are workspace links rather than
 * installed packages, so asking whether the image installed one answers nothing either way;
 * in a generated Project `@kobai/client` is a legitimate build input of the Admin and its
 * presence would not be evidence of a failed prune.
 *
 * **The production closure is subtracted too**, for the same reason {@link devOnlyDependencies}
 * subtracts it and with the same consequence if it did not: a package can be the Admin's build
 * input *and* something the Node process needs, and then its presence in the image is correct.
 * `zod` is the one that showed this — #174 gave the Admin's forms zod schemas mirroring
 * `contract.ts`'s structure, and `zod` is already a production dependency of `@kobai/core`, so
 * an image that had genuinely pruned every build tool would still carry it. A check that
 * flagged it would be answered by deleting the check.
 */
export async function adminBuildTooling(manifestPath: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    devDependencies?: Record<string, string>;
  };

  const declared = Object.keys(manifest.devDependencies ?? {});
  if (declared.length === 0) {
    // Failing open would let an assertion built on this pass over an empty list forever.
    throw new Error(
      `${manifestPath} declares no devDependencies, so an image was checked for almost nothing. ADR-0033 says the Admin's whole toolchain belongs there.`,
    );
  }

  const production = await productionClosure();
  return declared.filter((name) => !name.startsWith("@kobai/") && !production.has(name));
}
