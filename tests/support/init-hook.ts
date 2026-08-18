import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/**
 * A `devbox.json`, parsed. HuJSON, so comments and trailing commas are both allowed.
 *
 * The path is an argument because this repository holds three of these files — the
 * workspace's, the reference Project's, and the copy of the Project's that every Developer
 * receives — and the guard in front of every command that needs an install is swept across
 * all of them. It defaults to the workspace's, which is the one the hook belongs to.
 */
export async function readDevbox(path = "devbox.json"): Promise<DevboxConfig> {
  const contents = await readFile(fileURLToPath(new URL(path, repoRoot)), "utf8");
  const errors: ParseError[] = [];
  // `allowTrailingComma` because `devbox add` rewrites the file in that style, which
  // `tests/no-push-script.test.ts` has to allow for too.
  const config = parseJsonc(contents, errors, {
    allowTrailingComma: true,
  }) as DevboxConfig;

  const [failure] = errors;
  if (failure !== undefined) {
    throw new Error(
      `${path} did not parse: ${printParseErrorCode(failure.error)} at offset ${failure.offset}.`,
    );
  }
  return config;
}

/**
 * A checkout that exists, holding the `.env` given — which a pin needs a file to be read out
 * of, and a path to be hashed from.
 *
 * Both files that run the hook need one, so it lives here rather than twice over. Everything
 * it makes goes under one directory `discardCheckouts` removes.
 */
export async function checkoutPinning(dotenv: string): Promise<string> {
  const root = await mkdtemp(join(await checkoutWorkspace(), "checkout-"));
  await writeFile(join(root, ".env"), dotenv);
  return root;
}

/**
 * A path inside that same workspace where nothing has been written — a checkout with no
 * `.env`, which is what most of them are.
 */
export async function checkoutWithNoDotenv(): Promise<string> {
  return join(await checkoutWorkspace(), "no-such-checkout");
}

/** Drops every checkout made above. For an `afterAll`. */
export async function discardCheckouts(): Promise<void> {
  if (workspace === undefined) return;
  await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
}

let workspace: string | undefined;

async function checkoutWorkspace(): Promise<string> {
  workspace ??= await mkdtemp(join(tmpdir(), "kobai-init-hook-"));
  return workspace;
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
    // NUL-delimited, in order. A newline is a character `.env` can put in a value — the
    // reader interprets `\n` inside a double-quoted one, because compose does — and a
    // line-delimited report would let a value holding one shift every value after it
    // silently, in the file whose whole subject is awkward characters. NUL is the one byte
    // that cannot appear.
    ...options.report.map((name) => `printf '%s\\0' "$${name}"`),
  ].join("\n");

  const { stdout } = await run("sh", ["-c", script], {
    env: {
      PATH: process.env.PATH ?? "",
      DEVBOX_PROJECT_ROOT: options.root,
      ...options.env,
    },
  });

  // A trailing delimiter leaves one empty field behind it, and nothing else may.
  const printed = stdout.split("\0");
  if (printed.length !== options.report.length + 1) {
    throw new Error(
      `The hook reported ${printed.length - 1} values, not the ${options.report.length} asked of it (${options.report.join(", ")}). It printed:\n${stdout}`,
    );
  }

  const reported = {} as Record<Names[number], string>;
  options.report.forEach((name, index) => {
    reported[name as Names[number]] = printed[index] ?? "";
  });
  return reported;
}
