import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { type Codemod, codemodsCrossing, readCodemodSet } from "./codemods.ts";
import { type RangeRewrite, rewriteKobaiRanges } from "./ranges.ts";
import { compareVersions, crossesMajor, formatVersion, parseVersion } from "./version.ts";

/**
 * `kobai-upgrade` — moving a Project from one version of kobai to the next.
 *
 * ADR-0001 promises that upgrading is "a version bump plus shipped codemods rather than a
 * merge", and this is the command that makes both halves a thing that exists rather than a
 * thing described. It is a bin of `@kobai/core` for one reason: **the codemods that run must
 * be the ones the version being upgraded *to* shipped**, and `@kobai/core` is the only
 * package that is, by construction, at that version in the Project once the install has run.
 *
 * ## The bootstrap, which is the interesting part
 *
 * The runner executing these lines is whichever Core the Project had installed when the
 * command started — the *old* one. The set it applies is resolved out of the Project's
 * `node_modules` **after** the install, so it belongs to the new one. Two consequences worth
 * knowing:
 *
 * - The resolution is deliberate rather than relative. An `import("./codemods.js")` from here
 *   would load the running Core's own set, and under pnpm that is a real path inside the
 *   *old* version's store directory, which still exists after the install. So the installed
 *   package is found on disk instead, through the symlink the install rewrote.
 * - **Node's resolver cache is a trap here, and it was a real bug.** `require.resolve` caches
 *   by specifier and search path, so the same lookup before and after an install returns the
 *   answer from before it. The first version of this command reported the old version as the
 *   new one and would have run the old version's codemods — and at an empty boundary, where
 *   both sets are empty, nothing failed. See {@link installedCore}.
 * - An old runner can meet a set written to a contract it does not understand, which is what
 *   `CODEMOD_SET_FORMAT` is for. It refuses; it does not report an empty set.
 */

const run = promisify(execFile);

/** A cold install of a Project's whole dependency tree, on a slow machine. */
const INSTALL_TIMEOUT = 900_000;

export type CodemodsReport =
  | {
      /** The version arrived at ships a set, and nothing in it applies to this boundary. */
      readonly kind: "none-for-this-boundary";
      /** How many it ships in total, so "empty set" and "none matched" are distinguishable. */
      readonly shipped: number;
      readonly source: string;
    }
  | {
      readonly kind: "applied";
      readonly applied: readonly {
        readonly id: string;
        readonly title: string;
        readonly changed: readonly string[];
      }[];
      readonly source: string;
    }
  | {
      /** The version arrived at ships no set at all, which is not the same as an empty one. */
      readonly kind: "no-set-shipped";
      readonly why: string;
    };

export type UpgradeReport = {
  readonly from: string;
  readonly to: string;
  /** Whether this is the kind of bump a codemod would ever be written for. */
  readonly crossesMajor: boolean;
  readonly ranges: RangeRewrite;
  readonly installed: boolean;
  readonly codemods: CodemodsReport;
  readonly dryRun: boolean;
};

export type UpgradeOptions = {
  /** The Project's root. */
  readonly directory: string;
  /** The version to move to. */
  readonly to: string;
  /** Report what would happen, write nothing, install nothing, run nothing. */
  readonly dryRun?: boolean;
  /** Skip the install, for a Developer whose package manager is not pnpm. */
  readonly skipInstall?: boolean;
  /**
   * Installs the Project's dependencies.
   *
   * Injectable because everything above it can then be tested in milliseconds against a
   * Project made of two manifests, rather than only through a gate that installs for real.
   */
  readonly install?: (directory: string) => Promise<void>;
  /** Loads the codemod set the Project now has installed. Injectable for the same reason. */
  readonly loadCodemodSet?: (directory: string) => Promise<LoadedCodemodSet>;
};

export type LoadedCodemodSet = {
  readonly codemods: readonly Codemod[];
  /** Where it came from, quoted in the report so a Developer can go and look. */
  readonly source: string;
};

export async function upgradeProject(options: UpgradeOptions): Promise<UpgradeReport> {
  const {
    directory,
    to,
    dryRun = false,
    skipInstall = false,
    install = pnpmInstall,
    loadCodemodSet = codemodSetInstalledIn,
  } = options;

  const from = (await installedCore(directory)).version;
  const target = parseVersion(to, "The version this Project is upgrading to");
  const current = parseVersion(
    from,
    "The version of @kobai/core this Project has installed",
  );

  if (compareVersions(target, current) < 0) {
    throw new Error(
      `This Project has @kobai/core ${from} installed and was asked to upgrade to ${to}, which is older. Downgrading is not an upgrade path kobai has: a codemod moves a Project forwards and nothing undoes one.`,
    );
  }

  const ranges = await rewriteKobaiRanges({ directory, to, dryRun });

  const installed = !dryRun && !skipInstall;
  if (installed) await install(directory);

  return {
    from,
    to,
    crossesMajor: crossesMajor(current, target),
    ranges,
    installed,
    // Nothing is loaded on a dry run and nothing is loaded when the install was skipped:
    // in both cases the set on disk is still the old version's, and reporting *that* one's
    // codemods would be a confident answer to a question nobody asked.
    codemods:
      installed === false
        ? {
            kind: "none-for-this-boundary",
            shipped: 0,
            source: dryRun
              ? "not read: a dry run installs nothing, so the version arrived at is not on disk yet"
              : "not read: the install was skipped, so the version arrived at is not on disk yet",
          }
        : await applyCodemods({ directory, from, to, loadCodemodSet }),
    dryRun,
  };
}

async function applyCodemods(options: {
  readonly directory: string;
  readonly from: string;
  readonly to: string;
  readonly loadCodemodSet: (directory: string) => Promise<LoadedCodemodSet>;
}): Promise<CodemodsReport> {
  const { directory, from, to, loadCodemodSet } = options;

  let set: LoadedCodemodSet;
  try {
    set = await loadCodemodSet(directory);
  } catch (cause) {
    return {
      kind: "no-set-shipped",
      why: `@kobai/core ${to} exports no codemod set: ${(cause as Error).message}`,
    };
  }

  const crossing = codemodsCrossing(set.codemods, from, to);
  if (crossing.length === 0) {
    return {
      kind: "none-for-this-boundary",
      shipped: set.codemods.length,
      source: set.source,
    };
  }

  const applied: { id: string; title: string; changed: readonly string[] }[] = [];
  for (const codemod of crossing) {
    try {
      applied.push({
        id: codemod.id,
        title: codemod.title,
        changed: await codemod.apply({ directory }),
      });
    } catch (cause) {
      // Named, and carrying what ran before it: a codemod that fails half way leaves a
      // Project part-migrated, and the only useful thing to say is which one and after what.
      throw new Error(
        `Codemod ${codemod.id} (${codemod.title}) failed. ${applied.length} codemod(s) ran before it and their changes are on disk: ${applied.map((entry) => entry.id).join(", ") || "none"}.`,
        { cause },
      );
    }
  }

  return { kind: "applied", applied, source: set.source };
}

type InstalledCore = {
  /** Where the package really is — under pnpm, a path carrying its version. */
  readonly packageDirectory: string;
  readonly version: string;
};

/**
 * The Core the Project has on disk right now, read rather than resolved.
 *
 * **A plain filesystem read, and that is the whole point.** This is asked twice — once
 * before the install, for the version being upgraded from, and once after it — and Node's
 * module resolver caches by request and search path, so a second `require.resolve` of the
 * same specifier in the same process hands back the answer from *before* the install. That
 * would report the old version as the new one, and the same cache would have loaded the old
 * version's codemod set: exactly the silent wrong answer this command exists to avoid, and
 * invisible at an empty boundary because both sets are empty.
 *
 * `node_modules/<name>` is where every package manager kobai supports puts a direct
 * dependency, and `realpath` follows pnpm's symlink to the version-specific directory
 * underneath.
 */
async function installedCore(directory: string): Promise<InstalledCore> {
  const link = join(directory, "node_modules", "@kobai", "core");

  let packageDirectory: string;
  try {
    packageDirectory = await realpath(link);
  } catch (cause) {
    throw new Error(
      `This Project has no @kobai/core installed at ${link}, so there is nothing to upgrade from. Run \`pnpm install\` first — the upgrade path starts from a Project that works.`,
      { cause },
    );
  }

  const manifestPath = join(packageDirectory, "package.json");
  const { version } = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version?: string;
  };
  if (version === undefined) {
    throw new Error(
      `${manifestPath} declares no version, so there is nothing to compare.`,
    );
  }
  return { packageDirectory, version };
}

/**
 * The set the Project now has installed — the one belonging to the version arrived at.
 *
 * Resolved from *inside* the installed package rather than from the Project, and the
 * difference is the resolver cache again: a specifier resolved from the Project's root has
 * the same cache key before and after the install, while this package directory is
 * version-specific under pnpm, so the key changes when the version does. Node lets a package
 * resolve its own name when its `exports` names the subpath, which `@kobai/core` does.
 */
async function codemodSetInstalledIn(directory: string): Promise<LoadedCodemodSet> {
  const core = await installedCore(directory);
  const resolved = createRequire(join(core.packageDirectory, "package.json")).resolve(
    "@kobai/core/codemods",
  );
  const source = `@kobai/core@${core.version}`;

  return {
    codemods: readCodemodSet(await import(pathToFileURL(resolved).href), source),
    source,
  };
}

async function pnpmInstall(directory: string): Promise<void> {
  try {
    await run("pnpm", ["install"], {
      cwd: directory,
      timeout: INSTALL_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (cause) {
    const { stdout = "", stderr = "" } = cause as { stdout?: string; stderr?: string };
    throw new Error(
      `\`pnpm install\` failed after the version bump, so this Project is on new ranges with old packages. Fix the install and run this again, or pass --no-install and install with your own package manager.\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
      { cause },
    );
  }
}

export { formatVersion };
