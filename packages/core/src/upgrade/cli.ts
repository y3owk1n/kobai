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
 * **One argument, deliberately**, for the reason `create-kobai` has almost none: every choice
 * this could offer is one kobai has already made. There is no `--dry-run` and no way to skip
 * the install, because no codemod can run until the version being moved to is on disk — both
 * would be upgrades that quietly ran none, which is the one outcome this command exists to
 * make impossible.
 */

const USAGE = `Usage: kobai-upgrade --to <version>

Moves this Project from the version of kobai it has installed to another one: rewrites
every @kobai/* range in every manifest the Project owns, installs, and then runs the
codemods the version you moved to ships.

The codemods come from the version you are moving *to*, read out of this Project's
node_modules after the install. So a release that ships one is found by this same
command, run exactly this way — there is nothing to upgrade first.

Run it from the Project's root.

Options:
  --to <version>    The version to move to, e.g. 1.0.0. Required.
  -h, --help        Show this.
`;

export type ParsedUpgradeArguments =
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "upgrade"; readonly to: string };

export function parseUpgradeArguments(argv: readonly string[]): ParsedUpgradeArguments {
  let to: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];

    if (argument === "-h" || argument === "--help") return { kind: "help" };
    if (argument === "--to") {
      const value = argv[++index];
      if (value === undefined) return { kind: "error", message: "--to needs a value." };
      to = value;
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

  return { kind: "upgrade", to };
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
    const report = await upgradeProject({ directory: process.cwd(), to: parsed.to });
    console.log(formatUpgradeReport(report));

    // The report is worth printing either way — the ranges moved and the install ran — but a
    // version that shipped no codemod set left this command unable to do what it was asked,
    // and an exit code of 0 would put that on the same footing as an empty set.
    return report.codemods.kind === "no-set-shipped" ? 1 : 0;
  } catch (cause) {
    // The whole message, because every failure here is one a Developer has to act on and the
    // actionable part is in the sentence rather than in the stack.
    console.error(`kobai upgrade failed.\n\n${(cause as Error).message}`);
    return 1;
  }
}
