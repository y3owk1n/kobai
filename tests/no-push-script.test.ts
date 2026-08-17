import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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
 * Every file that can define a runnable command. `devbox.json` is on this list because
 * ADR-0031 makes it where kobai's commands live — which makes it the file where someone
 * would reach for the convenient one. A CI workflow is on it because a `run:` step is a
 * command too: nothing stops one running the thing no script is allowed to name.
 */
type CommandFile = {
  path: string;
  /** Command name → what it runs. A CI file keys by location; see `namesCommands`. */
  commands: Record<string, string>;
  /** Whether this file is expected to explain the absence, or merely to not offend. */
  explains: boolean;
  /**
   * Whether those keys are names a Developer chose. A script called `db:push` offends by
   * its name alone, whatever it runs. A CI step's key is a location this file made up, so
   * only what the step runs can offend — CI is allowed to push tags and images.
   */
  namesCommands: boolean;
};

async function commandFiles(): Promise<CommandFile[]> {
  const manifests = ["reference/package.json"];
  for (const entry of await readdir(new URL("packages/", repoRoot), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) manifests.push(`packages/${entry.name}/package.json`);
  }

  const files: CommandFile[] = await Promise.all(
    manifests.map(async (path) => ({
      path,
      commands: await read<{ scripts?: Record<string, string> }>(path).then(
        (json) => json.scripts ?? {},
      ),
      explains: true,
      namesCommands: true,
    })),
  );

  const devbox = await read<{ shell?: { scripts?: Record<string, string> } }>(
    "devbox.json",
  );
  files.push({
    path: "devbox.json",
    commands: devbox.shell?.scripts ?? {},
    explains: true,
    namesCommands: true,
  });

  // The workspace root owns no tables and runs no commands, but it must still not sprout
  // one.
  const root = await read<{ scripts?: Record<string, string> }>("package.json");
  files.push({
    path: "package.json",
    commands: root.scripts ?? {},
    explains: false,
    namesCommands: true,
  });

  for (const path of await ciPaths()) {
    files.push(ciFile(path, await readText(path)));
  }

  return files;
}

/** One CI file, read the way the scan reads it. The fixtures below use this too. */
function ciFile(path: string, contents: string): CommandFile {
  return {
    path,
    commands: ciRunSteps(contents),
    // A CI file has nowhere natural to put the comment, and it is not where a Developer
    // looks for the commands. The manifests carry the explanation.
    explains: false,
    namesCommands: false,
  };
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

/** A `// …` key is the comment explaining the absence, not a command. */
const isComment = (name: string) => name.startsWith("//");

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
  const { jobs } = (parse(contents) ?? {}) as CiFile;
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
      if (isComment(name)) continue;
      if ((namesCommands && /push/i.test(name)) || runsPush(command)) {
        found.push(`${path} → ${name}: ${command}`);
      }
    }
  }

  return found;
}

describe("no push command exists anywhere", () => {
  it("finds none in any package manifest, in devbox.json, or in a CI workflow", async () => {
    expect(offenders(await commandFiles())).toEqual([]);
  });

  it("explains the absence where the command would have gone", async () => {
    // An empty space reads as an oversight. A comment reads as a decision.
    for (const { path, commands, explains } of await commandFiles()) {
      if (!explains) continue;
      const comments = Object.entries(commands)
        .filter(([name]) => isComment(name))
        .map(([, text]) => text)
        .join(" ");

      expect(comments, `${path} does not say why it has no push script`).toMatch(/push/i);
      expect(comments, `${path} does not point at the evidence`).toMatch(/0030/);
    }
  });
});

/**
 * The scan above is only as good as what it reads. A CI file is not a manifest — its
 * commands are `run:` blocks spread over many jobs, any of which can be a multi-line
 * script — so these cover the reading of one, against CI written to offend. They go
 * through `ciFile`, the same reader the scan itself uses.
 */
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
      - run: devbox run ci
  release:
    steps:
      - name: Ship the schema
        run: |
          devbox run install
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
      - run: devbox run ci
`),
    ).toEqual([]);
  });
});
