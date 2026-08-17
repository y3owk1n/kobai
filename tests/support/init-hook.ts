import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

/**
 * `devbox.json`'s `init_hook`, run rather than read.
 *
 * The hook is what every `devbox run …` is given before it starts: it hashes the checkout's
 * path into this checkout's ports and builds the two database addresses from them and from
 * `.env` (AGENTS.md § The ports belong to the checkout). The gate runs *with those variables
 * already exported*, so no ordinary test can see the rule that produced them — a hook that
 * had stopped deriving anything and left the fallbacks standing would be green everywhere.
 *
 * So the lines are read out of `devbox.json` and handed to `sh`, with the checkout and the
 * environment a caller chooses. Reading them rather than restating them is the whole
 * arrangement: a second copy of the derivation here would agree with itself forever.
 *
 * It lives beside the tests rather than inside one because two of them run the hook — the
 * ports it derives, and the credentials it carries through — and a second copy of this
 * would be the same duplication one level up.
 */

const run = promisify(execFile);
const repoRoot = new URL("../../", import.meta.url);

type DevboxConfig = {
  shell?: {
    init_hook?: string[] | null;
    scripts?: Record<string, string> | null;
  } | null;
};

/** `devbox.json`, parsed. HuJSON, so comments and trailing commas are both allowed. */
export async function readDevbox(): Promise<DevboxConfig> {
  const contents = await readFile(
    fileURLToPath(new URL("devbox.json", repoRoot)),
    "utf8",
  );
  const errors: ParseError[] = [];
  // `allowTrailingComma` because `devbox add` rewrites the file in that style, which
  // `tests/no-push-script.test.ts` has to allow for too.
  const config = parseJsonc(contents, errors, {
    allowTrailingComma: true,
  }) as DevboxConfig;

  const [failure] = errors;
  if (failure !== undefined) {
    throw new Error(
      `devbox.json did not parse: ${printParseErrorCode(failure.error)} at offset ${failure.offset}.`,
    );
  }
  return config;
}

/**
 * Runs the hook against a checkout and reports the variables asked for.
 *
 * The environment is built from `PATH` and what the caller passes, and nothing else. Under
 * the gate this process already carries a derived `PORT`, `POSTGRES_PORT` and both database
 * addresses — devbox exported them before vitest started — and inheriting those would pin
 * every case to whatever the checkout running the suite happens to have, which is the one
 * thing that must not decide the answer.
 *
 * `corepack` is stubbed rather than run: the hook's first line activates pnpm, has nothing to
 * do with an address, and would otherwise write into a directory a test only invented.
 */
export async function runInitHook<const Names extends readonly string[]>(options: {
  /** Stands in for `DEVBOX_PROJECT_ROOT` — hashed, and looked in for a `.env`. */
  readonly root: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The variables to read back, in the order they come out. */
  readonly report: Names;
}): Promise<Record<Names[number], string>> {
  const { shell } = await readDevbox();
  const lines = shell?.init_hook ?? [];
  if (lines.length === 0) {
    // Failing open would be worse than failing: with no lines to run, every assertion built
    // on this would be about an empty script rather than about the derivation.
    throw new Error(
      "devbox.json declares no `shell.init_hook`, so there is no derivation to run. That is where PORT, POSTGRES_PORT, COMPOSE_PROJECT_NAME and both database addresses are set.",
    );
  }

  const script = [
    // devbox sources the hook from a script that opens `set -e`, so a line of it that
    // returns non-zero takes the whole command down — `devbox run …` then exits with that
    // status and prints nothing but the number. Running the hook any other way here would
    // pass over the one failure mode that stops every command in the repository at once.
    "set -e",
    "corepack() { :; }",
    ...lines,
    // One line each, in order. A value may hold spaces, quotes and `#` — this is the file
    // that reads a password out of `.env` — so each is printed whole and split on newlines.
    ...options.report.map((name) => `printf '%s\\n' "$${name}"`),
  ].join("\n");

  const { stdout } = await run("sh", ["-c", script], {
    env: {
      PATH: process.env.PATH ?? "",
      DEVBOX_PROJECT_ROOT: options.root,
      ...options.env,
    },
  });

  const printed = stdout.split("\n");
  const reported = {} as Record<Names[number], string>;
  options.report.forEach((name, index) => {
    const value = printed[index];
    if (value === undefined) {
      throw new Error(
        `The hook reported fewer than the ${options.report.length} values asked of it:\n${stdout}`,
      );
    }
    reported[name as Names[number]] = value;
  });
  return reported;
}
