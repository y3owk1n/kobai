import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

/**
 * ADR-0030, kept true by the build rather than by memory.
 *
 * `drizzle-kit push` diffs a schema against the LIVE database. Pushing Core's schema at a
 * database holding Plugin tables reports success and silently drops them, leaving their
 * migration tracking rows intact so the runner believes the work is done and cannot repair
 * it. Observed on branch `prototype/drizzle-multi-migration`, FINDINGS.md section E.
 *
 * The primary control is that the command is never available. A reviewer will not catch a
 * one-line `"db:push"` added in a hurry; this will.
 */
const repoRoot = new URL("../", import.meta.url);

/**
 * Every file that can define a runnable command. Under ADR-0083 that is every
 * `package.json` — the workspace root's most of all, because that is where kobai's commands
 * live and so where someone would reach for the convenient one. A CI workflow is on the list
 * because a `run:` step is a command too: nothing stops one running the thing no script is
 * allowed to name.
 *
 * `devbox.json` used to be on it, and is not because it declares no scripts at all —
 * `tests/devbox-declares-no-commands.test.ts` holds that, which forbids the whole class
 * rather than this one command. #30's hazard, where devbox generated a `"//db:push"` key
 * into a runnable `pnpm run db:push`, cannot arise in a file with no keys.
 */
type CommandFile = {
  path: string;
  /** Command name → what it runs. A CI file keys by location; see `namesCommands`. */
  commands: Record<string, string>;
  /**
   * Whether those keys are names a Developer chose. A script called `db:push` offends by
   * its name alone, whatever it runs. A CI step's key is a location this file made up, so
   * only what the step runs can offend — CI is allowed to push tags and images.
   */
  namesCommands: boolean;
};

/**
 * Directories that hold installed or generated code rather than this repository's own.
 *
 * `dist` is excluded because a built copy of a manifest is not a place anyone adds a script;
 * `node_modules` because a dependency's push script is not kobai's to forbid.
 */
const NOT_OURS = new Set(["node_modules", "dist", ".devbox", ".git"]);

/**
 * Every `package.json` in the repository, discovered rather than listed.
 *
 * It was a list, and the list went stale exactly the way a list does: `reference/admin` had
 * a manifest with its own `// db:push` note that nothing scanned, and then `reference/` grew
 * `packages/create-kobai/` grew a whole generated Project underneath it.
 * Discovery covers the next one without an edit, which is the same reason
 * `tests/packaged-migrations.test.ts` discovers its packages.
 *
 * The generated Project under `packages/create-kobai/template/` matters most of all: it is
 * the one whose scripts every Developer receives, so a push script reaching it would be the
 * furthest-travelling version of this mistake.
 */
async function commandFilePaths(): Promise<{ manifests: string[] }> {
  const manifests: string[] = [];

  const walk = async (directory: URL, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (NOT_OURS.has(entry.name)) continue;
        await walk(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`);
        continue;
      }
      if (entry.name === "package.json") manifests.push(`${prefix}package.json`);
    }
  };

  await walk(repoRoot, "");

  if (manifests.length === 0) {
    // Failing open would be worse than failing: an empty list makes this whole file pass by
    // scanning nothing, which is indistinguishable from scanning everything.
    throw new Error(
      `Discovery found ${manifests.length} manifest(s), so nothing was scanned for a push script.`,
    );
  }

  return { manifests };
}

async function commandFiles(): Promise<CommandFile[]> {
  const { manifests } = await commandFilePaths();

  const files: CommandFile[] = await Promise.all(
    manifests.map(async (path) => {
      const scripts = await read<{ scripts?: Record<string, string> }>(path).then(
        (json) => json.scripts ?? {},
      );
      return { path, commands: scripts, namesCommands: true };
    }),
  );

  for (const path of await ciPaths()) {
    files.push(ciFile(path, await readText(path)));
  }

  return files;
}

/** One CI file, read the way the scan reads it. The fixtures below use this too. */
function ciFile(path: string, contents: string): CommandFile {
  return { path, commands: ciRunSteps(contents), namesCommands: false };
}

/** Every CI file. GitHub reads both extensions, so both are scanned. */
async function ciPaths(): Promise<string[]> {
  const directory = ".github/workflows/";
  const paths = (await readdir(new URL(directory, repoRoot)))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => `${directory}${name}`);

  if (paths.length === 0) {
    // Failing open would be worse than failing: an empty list makes this half of the
    // guardrail pass by scanning nothing at all.
    throw new Error(`Nothing to scan in ${directory}, so no CI file was checked.`);
  }

  return paths;
}

async function read<T>(path: string): Promise<T> {
  return JSON.parse(await readText(path)) as T;
}

async function readText(path: string): Promise<string> {
  return readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");
}

/**
 * A GitHub Actions file — not kobai's Workflow, which `CONTEXT.md` reserves for a declared
 * commerce process. Nothing below is a domain concept; it is the shape of a YAML file.
 */
type CiFile = {
  jobs?: Record<string, { steps?: ({ run?: unknown } | null)[] | null } | null> | null;
};

/**
 * Every `run:` script in a CI file, keyed by where it sits.
 *
 * Parsed rather than grepped: a `run:` is often a multi-line block, a CI file has many
 * jobs, and the word `push` appears in `on: push:` — a trigger, not a command — in every
 * CI file this repository has.
 *
 * It reads what a job runs directly. A `run:` reached indirectly — inside a composite
 * action under `.github/actions/`, or assembled from `${{ matrix.… }}` or an `env:` value
 * — is out of its reach, and out of ADR-0030's cheap defences.
 */
function ciRunSteps(contents: string): Record<string, string> {
  const { jobs } = (parseYaml(contents) ?? {}) as CiFile;
  const steps: Record<string, string> = {};

  for (const [job, definition] of Object.entries(jobs ?? {})) {
    (definition?.steps ?? []).forEach((step, index) => {
      if (typeof step?.run === "string") {
        steps[`job "${job}", step ${index + 1}`] = step.run;
      }
    });
  }

  return steps;
}

/**
 * `drizzle-kit … push`, however the binary is reached and whatever flags sit in between —
 * `npx drizzle-kit@latest push`, `drizzle-kit --config=drizzle.config.ts push`. Bounded to
 * one command: a `;`, `&&`, `|` or newline ends it, so a `git push` further down a script
 * is not this. A trailing `\` is a wrapped line, not the end of one.
 */
const runsPush = (command: string) =>
  /\bdrizzle-kit\b[^\n;&|]*?\bpush\b/.test(command.replace(/\\\r?\n\s*/g, " "));

/** Each offence as its file, which command, and what that command runs. */
function offenders(files: CommandFile[]): string[] {
  const found: string[] = [];

  for (const { path, commands, namesCommands } of files) {
    for (const [name, command] of Object.entries(commands)) {
      if ((namesCommands && /push/i.test(name)) || runsPush(command)) {
        found.push(`${path} → ${name}: ${command}`);
      }
    }
  }

  return found;
}

describe("no push command exists anywhere", () => {
  it("finds none in any package manifest or in a CI workflow", async () => {
    expect(offenders(await commandFiles())).toEqual([]);
  });

  it("scans the Project every Developer receives, and both places a command can live", async () => {
    // Discovery is what makes this guardrail cover the next package without an edit, and
    // the way discovery fails is by quietly reaching less than it did. These four are the
    // ones whose absence would matter most: the two inside the generated Project, because
    // its scripts are the ones that travel to every Developer, and the two in the reference
    // Project, because that is the Project the generated one is made from.
    const scanned = (await commandFiles()).map((file) => file.path);

    expect(scanned).toContain("package.json");
    expect(scanned).toContain("reference/package.json");
    expect(scanned).toContain("reference/admin/package.json");
    expect(scanned).toContain("packages/create-kobai/template/package.json");
  });
});

describe("reading a CI file", () => {
  // Indented from column zero because YAML counts the indentation.
  const offending = `
name: release
on:
  push:
    branches: [main]
jobs:
  gate:
    steps:
      - uses: actions/checkout@v4
      - run: pnpm run ci
  release:
    steps:
      - name: Ship the schema
        run: |
          pnpm install --frozen-lockfile
          pnpm --filter @kobai/core exec drizzle-kit push
`;

  const scan = (contents: string) =>
    offenders([ciFile(".github/workflows/release.yml", contents)]);

  it("fails on a push run by any step of any job", () => {
    expect(scan(offending)).toHaveLength(1);
  });

  it("names the file and the command that offends", () => {
    expect(scan(offending)[0]).toContain(".github/workflows/release.yml");
    expect(scan(offending)[0]).toContain("drizzle-kit push");
  });

  it("fails whatever sits between the binary and the subcommand", () => {
    // Both of these run the same command. Neither is exotic: a config path is how a
    // Project points drizzle-kit at its own schema, and CI scripts wrap long lines.
    expect(
      scan(`
jobs:
  gate:
    steps:
      - run: pnpm exec drizzle-kit --config=drizzle.config.ts push
`),
    ).toHaveLength(1);
    expect(
      scan(`
jobs:
  gate:
    steps:
      - run: |
          pnpm exec drizzle-kit \\
            push
`),
    ).toHaveLength(1);
  });

  it("passes a step named for pushing something that is not a schema", () => {
    // CI is allowed to push tags and images. The key is a location this file made up,
    // not a name a Developer chose for a command, so only what the step runs can offend.
    expect(
      scan(`
jobs:
  release:
    steps:
      - name: Push the image
        run: docker push ghcr.io/y3owk1n/kobai:latest
`),
    ).toEqual([]);
  });

  it("passes a workflow whose only push is the trigger it runs on", () => {
    expect(
      scan(`
on:
  push:
    branches: [main]
jobs:
  gate:
    steps:
      - run: pnpm run ci
`),
    ).toEqual([]);
  });
});
