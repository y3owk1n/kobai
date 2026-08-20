import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";

/**
 * A `devbox.json`, parsed. HuJSON, so comments and trailing commas are both allowed.
 *
 * What is left of `tests/support/init-hook.ts` after ADR-0084 took the derivation out of the
 * `init_hook` and put it in `scripts/ports.ts`. Two files still read the script list out of
 * this config; under ADR-0083 that list moves to `package.json` and this goes with it.
 *
 * The path is an argument because this repository holds three of these files — the
 * workspace's, the reference Project's, and the copy of the Project's that every Developer
 * receives. It defaults to the workspace's.
 */

const repoRoot = new URL("../../", import.meta.url);

export type DevboxConfig = {
  shell?: {
    init_hook?: string[] | null;
    scripts?: Record<string, string> | null;
  } | null;
};

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
