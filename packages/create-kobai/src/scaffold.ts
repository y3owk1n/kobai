import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TEMPLATE_PROJECT_NAME, toProjectName } from "./naming.ts";
import { isBinary, projectFiles, toPlatformPath } from "./tree.ts";

const run = promisify(execFile);

/**
 * Generating a Project a Developer owns outright.
 *
 * The output is a **git repository with a first commit**, not a directory of files, and that
 * is the whole of ADR-0001 delivered as an experience: from the first second there is a
 * history to diff against, so every later customisation is visibly the Developer's rather
 * than something that arrived with the scaffold. Core is in its `package.json` as an
 * ordinary versioned dependency, so upgrading it is `pnpm update` rather than a merge.
 */

export type ScaffoldOptions = {
  /** Where the Project goes. Created if missing; must be empty if it exists. */
  readonly directory: string;
  /**
   * The Project's npm name. Defaults to the target directory's own name, which is what a
   * Developer means by `create-kobai my-store` and saves them naming the same thing twice.
   */
  readonly name?: string;
  /** The template directory. Defaults to the one shipped in this package. */
  readonly templateRoot?: string;
  /**
   * Whether to `git init` and commit. On by default — the repository *is* the deliverable.
   * Off is for tests that have no interest in git and for a Developer scaffolding into a
   * repository they already have.
   */
  readonly git?: boolean;
};

export type ScaffoldResult = {
  readonly directory: string;
  readonly name: string;
  /** Every file written, POSIX-relative, sorted. */
  readonly files: readonly string[];
  /** Whether a git repository was initialised and a first commit made. */
  readonly committed: boolean;
};

/**
 * Where this package's own template lives.
 *
 * Found through the module resolver rather than by counting `..` segments, because this
 * module runs from `src/` in this repository and from `dist/src/` once installed — different
 * depths, and a relative path right at one is silently wrong at the other. It is the same
 * lookup an `import` would do, and it works because the manifest names itself in `exports`.
 */
function bundledTemplate(): string {
  return fileURLToPath(
    new URL("template/", import.meta.resolve("create-kobai/package.json")),
  );
}

/**
 * npm's rules for an unscoped package name, which is what a directory name has to satisfy
 * before it can become one.
 *
 * Checked rather than sanitised: silently turning `My Store` into `my-store` would leave a
 * Developer with a Project named something they did not choose and did not see chosen.
 */
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const directory = resolve(options.directory);
  const name = options.name ?? directory.split(/[/\\]/).filter(Boolean).at(-1) ?? "";

  if (!PROJECT_NAME.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a usable npm package name, so it cannot name a Project. Use lowercase letters, digits, and \`-\`, \`_\` or \`.\` — or pass a name explicitly.`,
    );
  }

  await mkdir(directory, { recursive: true });

  const existing = await readdir(directory);
  if (existing.length > 0) {
    // Refusing beats merging. A half-scaffolded Project on top of someone's work is a mess
    // no error message afterwards can undo.
    throw new Error(
      `${directory} is not empty — it holds ${existing.length} entr${existing.length === 1 ? "y" : "ies"}. Generating into it would mix a new Project into whatever is already there, so nothing was written.`,
    );
  }

  const templateRoot = options.templateRoot ?? bundledTemplate();
  const files = await projectFiles(templateRoot);
  if (files.length === 0) {
    throw new Error(
      `No template files were found at ${templateRoot}, so nothing would have been generated.`,
    );
  }

  const written: string[] = [];

  for (const relative of files) {
    const contents = await readFile(join(templateRoot, toPlatformPath(relative)));
    // The leading dot goes back on here, at the last possible moment: a `.gitignore` inside
    // the published tarball would not have survived being published at all.
    const inProject = toProjectName(relative);
    const destination = join(directory, toPlatformPath(inProject));
    written.push(inProject);

    await mkdir(dirname(destination), { recursive: true });
    // One token, every text file — see TEMPLATE_PROJECT_NAME for why one replacement is
    // enough to rename the Project, its Admin package and everything that resolves them.
    await writeFile(
      destination,
      isBinary(contents)
        ? contents
        : contents.toString("utf8").replaceAll(TEMPLATE_PROJECT_NAME, name),
    );
  }

  const committed = options.git === false ? false : await initialCommit(directory, name);

  // The paths as the Project holds them, not as the template stored them — a caller asking
  // what was written means the files that now exist.
  return { directory, name, files: written.sort(), committed };
}

/**
 * `git init` and one commit, so the Developer owns a history from the start.
 *
 * Failing to commit is not failing to scaffold: git may be absent, or unconfigured, or the
 * target may already sit inside somebody else's repository. The files are the deliverable
 * and they are already written, so this reports what happened and leaves them alone.
 */
async function initialCommit(directory: string, name: string): Promise<boolean> {
  try {
    await run("git", ["init", "--quiet"], { cwd: directory });
    await run("git", ["add", "--all"], { cwd: directory });
    await run(
      "git",
      [
        // `-c` rather than `config`, so a Developer with no global identity gets a commit
        // instead of an error, and nothing is written to their git config either way.
        "-c",
        "user.name=create-kobai",
        "-c",
        "user.email=create-kobai@localhost",
        "commit",
        "--quiet",
        "--message",
        `Scaffold ${name} with create-kobai`,
      ],
      { cwd: directory },
    );
    return true;
  } catch {
    return false;
  }
}
