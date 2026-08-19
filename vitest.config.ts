import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ParseError, parse, printParseErrorCode } from "jsonc-parser";
import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * One entry of Vite's `resolve.alias` array.
 *
 * Reached through the config type rather than imported by name: `vitest/config` re-exports
 * Vite's `UserConfig` as `ViteUserConfig` but not its `Alias`, and `vite` itself is a
 * transitive dependency this package does not declare. `Extract` picks the array form of
 * `resolve.alias` out of its union with the `{ find: replacement }` object form.
 */
type Alias = Extract<
  NonNullable<NonNullable<ViteUserConfig["resolve"]>["alias"]>,
  readonly unknown[]
>[number];

const from = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * One config for the whole repository.
 *
 * Workspace packages resolve to source here, not to `dist`. Their own `exports` point at
 * `dist` so a Project gets built JavaScript, but a test run should not need a build step
 * first. The Dockerfile and the reference Project's own tests exercise the `dist` path.
 */
export default defineConfig({
  resolve: {
    alias: workspaceAliases(),
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "reference/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    /**
     * **The gate never calls Stripe** (ADR-0070), and this is what makes that true of a
     * Developer's machine as well as of CI.
     *
     * The reference Project reads these at import and takes payments at a bank when it has all
     * three (`reference/src/payments/stripe.ts`), so a maintainer with a real key exported in
     * their shell would otherwise have the suite — and every Project it spawns, which inherits
     * this environment — reach the network with a live secret and charge somebody. Blanked
     * rather than deleted, because blank is what an unset variable is here: the Project reads
     * an empty one as one that was not set, so the suite is the ordinary deployment that
     * settles out of band, which is what every assertion in it about `manual` expects.
     *
     * A test whose subject *is* Stripe passes its own configuration in — see
     * `reference/src/payments/stripe.test.ts` — and stubs the `fetch` the Plugin's whole
     * contact with the network goes through.
     */
    env: {
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PAYMENT_PAGE_URL: "",
    },
    // Every test creates a database of its own and runs migrations into it. That is slower
    // than a fake and worth it — see `createTestKobai`.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

/**
 * The package mappings, read out of `tsconfig.base.json` rather than repeated here.
 *
 * They were once written twice — once as `paths` for the compiler and the editor, once as
 * aliases for the test runner — and two hand-kept copies of the same list is one copy too
 * many. Adding a package is now a single edit to `tsconfig.base.json`.
 *
 * Read through a JSONC parser because a `tsconfig` is JSON *with comments*, which
 * `JSON.parse` refuses. This was once TypeScript's own `ts.readConfigFile`; TypeScript 7
 * ships no compiler API at all — its only root export is `version` — and 7.1 is expected to
 * bring back a *different* one. Stripping comments by hand is not the alternative it looks
 * like: `"$schema": "https://json.schemastore.org/tsconfig"` contains a `//` that any naive
 * stripper eats. `jsonc-parser` is what TypeScript's own tooling reaches for, and unlike a
 * compiler it is the whole of what this needs.
 */
function workspaceAliases(): Alias[] {
  const path = from("./tsconfig.base.json");
  // Written once, because every failure below is the same failure: this file is the only
  // source of the aliases, so anything that stops it being read stops the run.
  const because = "which is where the test runner's package aliases come from";

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`Could not read ${path}, ${because}.`, { cause });
  }

  const errors: ParseError[] = [];
  // `allowTrailingComma` because TypeScript accepts one and this is reading a `tsconfig`
  // the way TypeScript would. It is deliberately more permissive than `biome.json`'s
  // `json.parser`, which allows comments only — and still is for *this* file: ADR-0039
  // relaxed trailing commas for `devbox.json` alone, because `devbox add` writes them, and
  // left every other JSON file strict. Being laxer than the linter can never let this fail
  // *open*, and `biome ci` runs before the suite anyway.
  const config: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join(", ");
    throw new Error(`Could not parse ${path}, ${because}: ${detail}.`);
  }

  const paths = (config as TsconfigShape)?.compilerOptions?.paths ?? {};
  const entries = Object.entries(paths);
  if (entries.length === 0) {
    // Failing open here would be worse than failing: with no aliases every `@kobai/*`
    // import resolves through node_modules to `dist`, so the suite would quietly test the
    // last build instead of the working tree, and pass while doing it.
    throw new Error(
      "tsconfig.base.json declares no compilerOptions.paths, so the test run has no package aliases and would resolve @kobai/* to stale `dist` output.",
    );
  }

  return entries.map(([specifier, targets]) => {
    // `TsconfigShape` is an assertion about arbitrary JSON, not a guarantee about it, so
    // the target is checked rather than trusted. Without this a `paths` entry mapping to
    // `[42]` reaches `target.split` and dies with a bare `TypeError`, which names neither
    // the file nor the entry — and this is the one file whose job is to fail legibly.
    const target = Array.isArray(targets) ? targets[0] : undefined;
    if (typeof target !== "string") {
      throw new Error(
        `"${specifier}" in tsconfig.base.json maps to nothing usable. A path mapping must be an array whose first entry is a string, e.g. ["./packages/core/src/index.ts"].`,
      );
    }
    if (specifier.split("*").length > 2 || target.split("*").length > 2) {
      throw new Error(
        `"${specifier}" in tsconfig.base.json uses more than one "*". TypeScript allows at most one, and the alias below rewrites only the first.`,
      );
    }
    return {
      // `@kobai/core/*` → /^@kobai\/core\/(.*)$/, so a subpath export needs no edit.
      // Targets are relative to `tsconfig.base.json`, which sits beside this file, so
      // resolving them against `import.meta.url` needs no separate handling.
      find: new RegExp(`^${escapeRegExp(specifier).replace("\\*", "(.*)")}$`),
      replacement: from(target.replace("*", "$1")),
    };
  });
}

type TsconfigShape = { compilerOptions?: { paths?: Record<string, string[]> } };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
