import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  type ParseError,
  parse as parseJsonc,
  printParseErrorCode,
  visit,
} from "jsonc-parser";
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
 * Every file that can define a runnable command. `devbox.json` is on this list because
 * ADR-0031 makes it where kobai's commands live — which makes it the file where someone
 * would reach for the convenient one. A CI workflow is on it because a `run:` step is a
 * command too: nothing stops one running the thing no script is allowed to name.
 */
type CommandFile = {
  path: string;
  /** Command name → what it runs. A CI file keys by location; see `namesCommands`. */
  commands: Record<string, string>;
  /**
   * Every comment in this file, or `null` where it is merely expected not to offend. One
   * of them has to explain the absence. Where they come from differs by file, because
   * where a comment can safely live differs by file — see `commentsIn` and
   * `jsoncComments`.
   */
  comments: string[] | null;
  /**
   * Whether those keys are names a Developer chose. A script called `db:push` offends by
   * its name alone, whatever it runs. A CI step's key is a location this file made up, so
   * only what the step runs can offend — CI is allowed to push tags and images.
   */
  namesCommands: boolean;
  /**
   * Whether a `"// …"` key here is inert prose the scan may skip. True of a manifest: npm
   * attaches no meaning to such a key, so only a human ever reads it. False of
   * `devbox.json`, where the key *is* a command — so the scan has to judge it as one.
   * See `devboxFile`.
   */
  commentKeysAreInert: boolean;
};

async function commandFiles(): Promise<CommandFile[]> {
  const manifests = ["reference/package.json"];
  for (const entry of await readdir(new URL("packages/", repoRoot), {
    withFileTypes: true,
  })) {
    if (entry.isDirectory()) manifests.push(`packages/${entry.name}/package.json`);
  }

  const files: CommandFile[] = await Promise.all(
    manifests.map(async (path) => {
      const scripts = await read<{ scripts?: Record<string, string> }>(path).then(
        (json) => json.scripts ?? {},
      );
      return {
        path,
        commands: scripts,
        comments: commentsIn(scripts),
        namesCommands: true,
        commentKeysAreInert: true,
      };
    }),
  );

  files.push(devboxFile(await readText("devbox.json")));

  // The workspace root owns no tables and runs no commands, but it must still not sprout
  // one.
  const root = await read<{ scripts?: Record<string, string> }>("package.json");
  files.push({
    path: "package.json",
    commands: root.scripts ?? {},
    comments: null,
    namesCommands: true,
    commentKeysAreInert: true,
  });

  for (const path of await ciPaths()) {
    files.push(ciFile(path, await readText(path)));
  }

  return files;
}

/**
 * `devbox.json`, read the way the scan reads it. The fixtures below use this too.
 *
 * Its explanation comes from its **comments**, not from a `"// …"` key like a manifest's.
 * devbox generates one shell script per key at `.devbox/gen/scripts/<key>.sh` through a
 * path join, and a join collapses the leading `//` — so a `"//db:push"` key writes to
 * `db:push.sh` and creates the very `devbox run db:push` that ADR-0030 says must never
 * exist, while `"//db:generate"` lands on the real script's file and races it. Observed on
 * devbox 0.17.5; see #30. `devbox.json` is HuJSON, so a real comment says the same thing
 * and can never be generated into a command.
 */
function devboxFile(contents: string): CommandFile {
  const errors: ParseError[] = [];
  // `allowTrailingComma` because HuJSON permits one and `devbox add` writes them: it
  // reformats this file when it rewrites it, and a comment in it makes it choose the
  // trailing-comma style. Reading it less permissively than devbox writes it would make
  // this guardrail fall over on a file devbox itself produced.
  const config = parseJsonc(contents, errors, { allowTrailingComma: true }) as {
    shell?: { scripts?: Record<string, string> };
  };
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ");
    throw new Error(
      `devbox.json could not be read, so no script in it was checked: ${detail}.`,
    );
  }

  const scripts = config?.shell?.scripts;
  if (scripts === undefined || Object.keys(scripts).length === 0) {
    // Failing open would be worse than failing, and this is the likelier way it would
    // happen than a parse error: devbox moves `shell.scripts`, this reads nothing, and
    // the file where kobai's commands live goes unscanned while both tests still pass.
    throw new Error(
      "devbox.json declares no shell.scripts, so the file kobai's commands live in was not scanned for a push script.",
    );
  }

  return {
    path: "devbox.json",
    commands: scripts,
    comments: jsoncComments(contents),
    namesCommands: true,
    // Not inert: a `"//db:push"` key here is a `devbox run db:push` that exists.
    commentKeysAreInert: false,
  };
}

/** One CI file, read the way the scan reads it. The fixtures below use this too. */
function ciFile(path: string, contents: string): CommandFile {
  return {
    path,
    commands: ciRunSteps(contents),
    // A CI file has nowhere natural to put the comment, and it is not where a Developer
    // looks for the commands. The manifests and devbox.json carry the explanation.
    comments: null,
    namesCommands: false,
    // A CI key is a location, never a `"// …"` comment, so this changes nothing here.
    commentKeysAreInert: true,
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

/**
 * A `// …` key is the comment explaining the absence, not a command.
 *
 * This is a **manifest** convention only. `package.json` is strict JSON — npm rejects a
 * real comment — and npm attaches no meaning to the key, so it stays inert. `devbox.json`
 * is the opposite on both counts: it takes real comments and it turns every key into a
 * script. See `devboxFile`.
 */
const isComment = (name: string) => name.startsWith("//");

/** What each of a manifest's `// …` keys says. One key, one comment. */
const commentsIn = (scripts: Record<string, string>) =>
  Object.entries(scripts)
    .filter(([name]) => isComment(name))
    .map(([, text]) => text);

/**
 * The comments in a JSONC file — `devbox.json` explains itself in these.
 *
 * Consecutive `//` lines are joined into one comment, because that is what they are: a
 * paragraph wrapped to the line width, not one remark per line. Read line by line instead,
 * no single comment would carry both halves of the assertion below, and a file could
 * satisfy it by mentioning `push` in one place and ADR-0030 in an unrelated other.
 */
function jsoncComments(contents: string): string[] {
  const blocks: { lastLine: number; text: string }[] = [];

  visit(contents, {
    onComment: (offset, length, startLine) => {
      const text = contents.slice(offset, offset + length);
      // A `/* … */` comment can span lines of its own, so the next one is adjacent to
      // where this one ended rather than to where it started.
      const lastLine = startLine + (text.match(/\n/g)?.length ?? 0);
      const previous = blocks.at(-1);
      if (previous && previous.lastLine === startLine - 1) {
        previous.lastLine = lastLine;
        previous.text += ` ${text}`;
      } else {
        blocks.push({ lastLine, text });
      }
    },
  });

  return blocks.map(({ text }) => text);
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

/**
 * A comment that says why there is no push command *and* points at the evidence for it.
 * ADR-0030 is cited by number because the number is what survives the file being renamed.
 */
const explainsTheAbsence = (comment: string) =>
  /push/i.test(comment) && /0030/.test(comment);

/**
 * The file devbox generates a `devbox.json` key into: `<scripts dir>/<key>.sh`, reached
 * through a path join. A join cleans the path it builds, so leading slashes disappear on
 * the way — which is how `"//db:push"` and `"db:push"` end up as one script.
 */
const generatedScript = (key: string) => `${key.replace(/^\/+/, "")}.sh`;

/**
 * Each pair of keys devbox would generate into one file. Both are named, because either
 * one of them could be the mistake and the reader is the one who knows which.
 */
function collidingKeys(commands: Record<string, string>): string[] {
  const claimedBy = new Map<string, string>();
  const collisions: string[] = [];

  for (const key of Object.keys(commands)) {
    const script = generatedScript(key);
    const first = claimedBy.get(script);
    if (first === undefined) claimedBy.set(script, key);
    else collisions.push(`"${first}" and "${key}" both generate ${script}`);
  }

  return collisions;
}

/** Each offence as its file, which command, and what that command runs. */
function offenders(files: CommandFile[]): string[] {
  const found: string[] = [];

  for (const { path, commands, namesCommands, commentKeysAreInert } of files) {
    for (const [name, command] of Object.entries(commands)) {
      if (commentKeysAreInert && isComment(name)) continue;
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
    for (const { path, comments } of await commandFiles()) {
      if (comments === null) continue;

      // One comment has to do both. Asking the file as a whole to mention `push`
      // somewhere and ADR-0030 somewhere else would be satisfied by two remarks that
      // have nothing to do with each other.
      expect(
        comments.filter(explainsTheAbsence),
        `${path} has no one comment saying both why it has no push script and where the evidence is`,
      ).not.toHaveLength(0);
    }
  });

  it("has no devbox.json key that generates over another one", async () => {
    // The other half of #30, and the reason `"//db:push"` was ever dangerous: two keys
    // that generate into one file are one command, and which of them it runs depends on
    // the order devbox happened to write them in.
    expect(collidingKeys(devboxFile(await readText("devbox.json")).commands)).toEqual([]);
  });
});

/**
 * `devbox.json` is the file where someone reaches for the convenient command, so these
 * cover its reading against the two ways it can go wrong: an explanation that has
 * evaporated, and the `"// …"` key that #30 showed is a command wearing a comment's
 * clothes. They go through `devboxFile`, the same reader the scan itself uses.
 */
describe("reading devbox.json", () => {
  const explained = `{
  "shell": {
    "scripts": {
      // There is deliberately no db:push script. \`drizzle-kit push\` diffs against the
      // LIVE database; see docs/adr/0030-generate-and-migrate-only-never-drizzle-kit-push.md.
      "db:generate": "pnpm -r build && pnpm -r db:generate"
    }
  }
}`;

  it("reads the commands out of a file that has comments in it", () => {
    expect(devboxFile(explained).commands).toEqual({
      "db:generate": "pnpm -r build && pnpm -r db:generate",
    });
  });

  it("reads a wrapped explanation as one comment rather than as its lines", () => {
    // The two halves of the explanation sit on different lines. Read separately, neither
    // line explains anything.
    expect(devboxFile(explained).comments?.filter(explainsTheAbsence)).toHaveLength(1);
  });

  it("finds no explanation once the comments are deleted", () => {
    // The red case for the assertion above, so that it is known to be able to fail rather
    // than assumed to be.
    const stripped = explained
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(devboxFile(stripped).comments?.filter(explainsTheAbsence)).toHaveLength(0);
  });

  it("is not satisfied by two unrelated remarks", () => {
    // One comment saying `push` and a different one citing the ADR is not an explanation,
    // and this is the shape the file takes today: it carries a note about its own comment
    // convention as well as the explanation.
    const scattered = `{
  "shell": {
    "scripts": {
      // Explanations here are real comments: a "//db:push" key would become a command.
      "db:generate": "pnpm -r build && pnpm -r db:generate",

      // ADR-0030 is why db:generate builds first.
      "build": "pnpm -r build"
    }
  }
}`;

    expect(devboxFile(scattered).comments?.filter(explainsTheAbsence)).toHaveLength(0);
  });

  it("judges a `// …` key as the command devbox generates from it", () => {
    // devbox writes `.devbox/gen/scripts/<key>.sh` through a path join, and a join eats
    // the leading `//`. The key below is not a comment: it is `devbox run db:push`.
    const offending = `{
  "shell": {
    "scripts": {
      "//db:push": "There is deliberately no db:push script. See ADR-0030.",
      "db:generate": "pnpm -r build && pnpm -r db:generate"
    }
  }
}`;

    expect(offenders([devboxFile(offending)])).toHaveLength(1);
    expect(offenders([devboxFile(offending)])[0]).toContain("db:push");
  });

  it("catches a `// …` key that generates over the script it meant to document", () => {
    // The original sighting: `devbox run db:generate` echoed the prose and exited 127,
    // then ran the real command again once something else regenerated the file.
    const colliding = `{
  "shell": {
    "scripts": {
      "//db:generate": "It builds first because a Plugin's drizzle.config.ts …",
      "db:generate": "pnpm -r build && pnpm -r db:generate"
    }
  }
}`;

    expect(collidingKeys(devboxFile(colliding).commands)).toEqual([
      '"//db:generate" and "db:generate" both generate db:generate.sh',
    ]);
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
