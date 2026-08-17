import { formatUpgradeReport } from "./report.ts";
import { upgradeProject } from "./upgrade.ts";

/**
 * `kobai-upgrade` — the command ADR-0001 has always described and nothing shipped.
 *
 * It lives in `@kobai/core` rather than in `create-kobai` because the codemods that run have
 * to be the ones the version being upgraded *to* ships, and Core is the only package that is
 * at that version in the Project once the install has run. `create-kobai` is the *create*
 * command: a Developer never installs it, and its CLI path deliberately imports nothing but
 * Node builtins so that `npm create kobai@latest` cannot fail on a missing dependency.
 *
 * Deliberately almost no interface, for the reason `create-kobai` has almost none: every
 * choice this could offer is one kobai has already made.
 */

const USAGE = `Usage: kobai-upgrade --to <version> [options]

Moves this Project from the version of kobai it has installed to another one: rewrites
every @kobai/* range in every manifest the Project owns, installs, and then runs the
codemods the version you moved to ships.

The codemods come from the version you are moving *to*, read out of this Project's
node_modules after the install. So a release that ships one is found by this same
command, run exactly this way — there is nothing to upgrade first.

Options:
  --to <version>    The version to move to, e.g. 1.0.0. Required.
  --project <dir>   The Project's root. Defaults to the working directory.
  --no-install      Skip \`pnpm install\`. No codemod runs, because the set that runs is
                    the one the new version ships and it is not on disk until you install.
  --dry-run         Say what would happen. Writes nothing, installs nothing, runs nothing.
  -h, --help        Show this.
`;

export type ParsedUpgradeArguments =
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "upgrade";
      readonly to: string;
      /** Undefined means the working directory, which only the running command knows. */
      readonly directory?: string;
      readonly skipInstall: boolean;
      readonly dryRun: boolean;
    };

export function parseUpgradeArguments(argv: readonly string[]): ParsedUpgradeArguments {
  let to: string | undefined;
  let directory: string | undefined;
  let skipInstall = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "-h" || argument === "--help") return { kind: "help" };
    if (argument === "--no-install") {
      skipInstall = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--to" || argument === "--project") {
      const value = argv[++index];
      if (value === undefined) {
        return { kind: "error", message: `${argument} needs a value.` };
      }
      if (argument === "--to") to = value;
      else directory = value;
      continue;
    }

    return {
      kind: "error",
      message: `Unexpected argument ${JSON.stringify(argument)}. The version goes after --to.`,
    };
  }

  if (to === undefined) {
    return {
      kind: "error",
      message: "--to is required: this command will not guess which version you meant.",
    };
  }

  return { kind: "upgrade", to, directory, skipInstall, dryRun };
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseUpgradeArguments(argv);

  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`${parsed.message}\n\n${USAGE}`);
    return 1;
  }

  try {
    const report = await upgradeProject({
      directory: parsed.directory ?? process.cwd(),
      to: parsed.to,
      skipInstall: parsed.skipInstall,
      dryRun: parsed.dryRun,
    });
    console.log(formatUpgradeReport(report));
    return 0;
  } catch (cause) {
    // The whole message, because every failure here is one a Developer has to act on and the
    // actionable part is in the sentence rather than in the stack.
    console.error(`kobai upgrade failed.\n\n${(cause as Error).message}`);
    return 1;
  }
}
