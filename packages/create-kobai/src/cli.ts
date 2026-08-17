import { scaffold } from "./scaffold.ts";

/**
 * `npm create kobai@latest my-store` — the one command in ADR-0001's first sentence.
 *
 * Deliberately almost no interface: a directory, and optionally a name. Every choice a
 * scaffolder usually asks about — which database, which framework, how to deploy — kobai has
 * already made and recorded, and asking would imply the answers were still open.
 */
const USAGE = `Usage: create-kobai <directory> [--name <name>] [--no-git]

Generates a kobai Project you own outright: a git repository with kobai as an
ordinary versioned dependency, so upgrading is a version bump rather than a merge.

Arguments:
  <directory>      Where to put the Project. Created if missing; must be empty.

Options:
  --name <name>    The npm package name. Defaults to the directory's own name.
  --no-git         Skip \`git init\` and the first commit.
  -h, --help       Show this.
`;

type ParsedArguments =
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "scaffold";
      readonly directory: string;
      readonly name?: string;
      readonly git: boolean;
    };

export function parseArguments(argv: readonly string[]): ParsedArguments {
  let directory: string | undefined;
  let name: string | undefined;
  let git = true;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "-h" || argument === "--help") return { kind: "help" };
    if (argument === "--no-git") {
      git = false;
      continue;
    }
    if (argument === "--name") {
      const value = argv[++index];
      if (value === undefined) return { kind: "error", message: "--name needs a value." };
      name = value;
      continue;
    }
    if (argument === undefined) continue;
    if (argument.startsWith("-")) {
      return { kind: "error", message: `Unknown option ${JSON.stringify(argument)}.` };
    }
    if (directory !== undefined) {
      return {
        kind: "error",
        message: `Only one directory can be scaffolded at a time, but two were given: ${JSON.stringify(directory)} and ${JSON.stringify(argument)}.`,
      };
    }
    directory = argument;
  }

  if (directory === undefined) {
    return { kind: "error", message: "A target directory is required." };
  }

  return name === undefined
    ? { kind: "scaffold", directory, git }
    : { kind: "scaffold", directory, name, git };
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);

  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (parsed.kind === "error") {
    process.stderr.write(`${parsed.message}\n\n${USAGE}`);
    return 1;
  }

  try {
    const result = await scaffold({
      directory: parsed.directory,
      ...(parsed.name === undefined ? {} : { name: parsed.name }),
      git: parsed.git,
    });

    process.stdout.write(
      [
        `Generated ${result.name} in ${result.directory} — ${result.files.length} files.`,
        result.committed
          ? "Initialised a git repository and made the first commit."
          : "No git repository was initialised (git is unavailable, or --no-git was passed).",
        "",
        "Next:",
        `  cd ${parsed.directory}`,
        "  devbox run install",
        "  devbox run up",
        "",
        "That brings up Postgres and the app, applies every migration, and serves the API",
        "on http://localhost:3000 with the Admin at /admin-ui.",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}
