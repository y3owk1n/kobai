import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * The half of an upgrade that is real work at every boundary, including an empty one.
 *
 * ADR-0001's promise is that upgrading is "a version bump plus shipped codemods". Until #12
 * nothing shipped did the version bump either, so a gate that claimed to run the shipped
 * upgrade path would have had to hand-edit a manifest to get started — an equivalent written
 * for CI, standing in for the first step of the thing under test.
 *
 * So this is what the command does when it has no codemods to run, and it is why "no
 * codemods for this boundary" is a report rather than a shrug.
 */

/** Every kobai package a Project depends on by version. Its own Admin is not one. */
const KOBAI_SCOPE = "@kobai/";

/** Where a manifest declares dependencies. All four, because a Project may use any. */
const DEPENDENCY_BLOCKS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Directories a Project's own manifests are never inside. */
const NOT_THE_PROJECT = new Set(["node_modules", ".git", "dist", ".devbox"]);

/**
 * A range this command understands: an optional `^` or `~`, then a plain version.
 *
 * Anything else is left alone and reported. A Developer who wrote `>=0.1.0 <0.3.0` or
 * pointed a dependency at a tarball meant it, and an upgrade command that flattened it into
 * `^1.0.0` would be making a decision that is not its to make.
 */
const SIMPLE_RANGE = /^(\^|~)?(\d+\.\d+\.\d+)$/;

export type RangeChange = {
  /** Relative to the Project, POSIX-separated, so a report reads the same everywhere. */
  readonly file: string;
  readonly dependency: string;
  readonly from: string;
  readonly to: string;
};

export type RangeLeftAlone = {
  readonly file: string;
  readonly dependency: string;
  readonly range: string;
  readonly why: string;
};

export type RangeRewrite = {
  readonly changed: readonly RangeChange[];
  readonly leftAlone: readonly RangeLeftAlone[];
};

export async function rewriteKobaiRanges(options: {
  /** The Project's root. */
  readonly directory: string;
  /** The version every kobai dependency should now point at. */
  readonly to: string;
  /** Work out what would change and write nothing. */
  readonly dryRun?: boolean;
}): Promise<RangeRewrite> {
  const { directory, to, dryRun = false } = options;

  const changed: RangeChange[] = [];
  const leftAlone: RangeLeftAlone[] = [];

  for (const manifestPath of await projectManifests(directory)) {
    const file = relative(directory, manifestPath).split(sep).join("/");
    const original = await readFile(manifestPath, "utf8");
    const json = JSON.parse(original) as Record<string, unknown>;

    let touched = false;
    for (const block of DEPENDENCY_BLOCKS) {
      const dependencies = json[block];
      if (dependencies === null || typeof dependencies !== "object") continue;

      for (const [dependency, range] of Object.entries(
        dependencies as Record<string, string>,
      )) {
        if (!dependency.startsWith(KOBAI_SCOPE)) continue;

        const matched = SIMPLE_RANGE.exec(range);
        if (matched === null) {
          leftAlone.push({
            file,
            dependency,
            range,
            why: "it is not a plain version range, so what the Developer meant by it is theirs to say",
          });
          continue;
        }

        const rewritten = `${matched[1] ?? ""}${to}`;
        if (rewritten === range) continue;

        (dependencies as Record<string, string>)[dependency] = rewritten;
        changed.push({ file, dependency, from: range, to: rewritten });
        touched = true;
      }
    }

    // Written back with the formatting npm and Biome both produce, and with key order
    // untouched — including the `"// dependencies"` keys a kobai Project explains itself
    // with, which `JSON.parse` keeps and `JSON.stringify` writes back in place.
    if (touched && !dryRun) {
      await writeFile(manifestPath, `${JSON.stringify(json, null, 2)}\n`);
    }
  }

  return { changed, leftAlone };
}

/**
 * Every `package.json` the Project owns — its own, its Admin's, and any package it adds.
 *
 * Walked rather than read out of `pnpm-workspace.yaml`, because parsing YAML would be a
 * dependency of a published package for one file, and because a Project's manifests are
 * exactly the ones not inside `node_modules`. A Project that grows a third package is
 * covered without an edit.
 */
async function projectManifests(directory: string): Promise<string[]> {
  const found: string[] = [];

  // The Project's own manifest first, then each package below it in name order. A report
  // that listed the Admin's changes above the Project's would read as though the Admin were
  // the Project, and `readdir` gives no order worth relying on anyway.
  const walk = async (at: string): Promise<void> => {
    const entries = (await readdir(at, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );

    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      found.push(join(at, "package.json"));
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (NOT_THE_PROJECT.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(join(at, entry.name));
    }
  };

  await walk(directory);

  if (found.length === 0) {
    throw new Error(
      `${directory} holds no package.json, so it is not a kobai Project. Run this from the Project's root, or pass --project.`,
    );
  }
  return found;
}
