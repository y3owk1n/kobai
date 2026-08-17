import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Codemod } from "./codemods.ts";
import { type RangeRewrite, rewriteKobaiRanges } from "./ranges.ts";
import { CodemodSetMissing, codemodsCrossing, readCodemodSet } from "./set.ts";
import { compareVersions, crossesMajor, parseVersion } from "./version.ts";

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
 * command started — the *old* one. The set it applies is found on disk **after** the
 * install, so it belongs to the new one. Three consequences worth knowing:
 *
 * - The lookup is deliberate rather than relative. An `import("./codemods.js")` from here
 *   would load the running Core's own set, and under pnpm that is a real path inside the
 *   *old* version's store directory, which still exists after the install.
 * - **Node's resolver cache is a trap here, and it was a real bug.** `require.resolve`
 *   caches by specifier and search path, so the same lookup before and after an install
 *   returns the answer from before it. The first version of this command reported the old
 *   version as the new one and would have run the old version's codemods — and at an empty
 *   boundary, where both sets are empty, nothing failed. See {@link installedCore}.
 * - An old runner can meet a set written to a contract it does not understand. It **fails**;
 *   it does not report an empty set. Only a version exporting no set at all is survivable,
 *   and even that exits non-zero — see {@link CodemodsReport}.
 *
 * There is deliberately no way to skip the install and no dry run. No codemod can run until
 * the version being moved to is on disk, so either would be an upgrade that quietly ran none
 * — and this command's whole job is that "no codemods ran" is never something a Developer
 * has to infer.
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
      /**
       * The version arrived at ships no set at all, which is not the same as an empty one.
       *
       * Survivable only in the sense that the report is worth printing: the ranges moved and
       * the install ran, and a Developer needs to see both. The command still exits non-zero,
       * because it could not do what it was asked to do — a version that intends to ship no
       * codemods exports an empty set and says so.
       */
      readonly kind: "no-set-shipped";
      readonly why: string;
    };

export type UpgradeReport = {
  readonly from: string;
  readonly to: string;
  /** Whether this is the kind of bump a codemod would ever be written for. */
  readonly crossesMajor: boolean;
  readonly ranges: RangeRewrite;
  readonly codemods: CodemodsReport;
};

export type UpgradeOptions = {
  /** The Project's root. */
  readonly directory: string;
  /** The version to move to. */
  readonly to: string;
  /**
   * Installs the Project's dependencies.
   *
   * Injectable because everything around it can then be tested in milliseconds against a
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

  const ranges = await rewriteKobaiRanges({ directory, to });
  await install(directory);

  return {
    from,
    to,
    crossesMajor: crossesMajor(current, target),
    ranges,
    codemods: await applyCodemods({ directory, from, to, loadCodemodSet }),
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
    // Only an *absent* set is survivable. A set that is present and wrong about itself — a
    // format this runner does not understand, a codemod whose version cannot be ordered —
    // propagates and fails the command, because reporting "no codemods" for it would be
    // indistinguishable from the empty set that is the ordinary answer. Keeping those two
    // apart is the whole point of ADR-0035.
    if (!(cause instanceof CodemodSetMissing)) throw cause;
    return {
      kind: "no-set-shipped",
      why: `@kobai/core ${to} exports no codemod set: ${cause.message}`,
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
  const source = `@kobai/core@${core.version}`;

  let resolved: string;
  try {
    resolved = createRequire(join(core.packageDirectory, "package.json")).resolve(
      "@kobai/core/codemods",
    );
  } catch (cause) {
    // The one survivable load failure, and the only one raised as this type: the export is
    // not there at all. Everything past this line is a set that exists and is wrong.
    throw new CodemodSetMissing(
      `${source} has no \`./codemods\` export (${(cause as Error).message})`,
    );
  }

  return {
    codemods: readCodemodSet(await import(pathToFileURL(resolved).href), source),
    source,
  };
}

/**
 * The install, and the one install in kobai that **must** be allowed to move the lockfile.
 *
 * `--no-frozen-lockfile` is not a convenience and not a workaround for a strict runner. The
 * line above this one has just rewritten every `@kobai/*` range on purpose, so by the time
 * the install runs `pnpm-lock.yaml` is out of date **by construction** — that is what an
 * upgrade *is*. A frozen install is therefore wrong here in every environment; it merely
 * happens to be quiet in the ones where pnpm does not freeze by default.
 *
 * **And pnpm freezes whenever `CI` is set.** So without this flag the command works on a
 * Developer's machine and fails in exactly the place an upgrade is most often run
 * unattended — with `ERR_PNPM_OUTDATED_LOCKFILE` naming a lockfile that is stale precisely
 * because this command did its job. kobai's own gate found it that way round: green
 * locally, red in GitHub Actions.
 *
 * The flag is scoped to this one call and to nothing else. A Project's own `pnpm install`,
 * its Dockerfile's production install and this repository's `devbox run ci` all still
 * resolve from the lockfile and still fail when it has drifted, which is what they are for:
 * a lockfile is stale there by accident, and here on purpose.
 */
async function pnpmInstall(directory: string): Promise<void> {
  try {
    await run("pnpm", ["install", "--no-frozen-lockfile"], {
      cwd: directory,
      timeout: INSTALL_TIMEOUT,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (cause) {
    const { stdout = "", stderr = "" } = cause as { stdout?: string; stderr?: string };
    throw new Error(
      `\`pnpm install --no-frozen-lockfile\` failed after the version bump, so this Project is on new ranges with old packages. Fix whatever the install complained about and run this command again.\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`,
      { cause },
    );
  }
}
