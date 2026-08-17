import { fileURLToPath } from "node:url";
import ts from "typescript";
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
 * Read through TypeScript's own parser because a `tsconfig` is JSON *with comments*, which
 * `JSON.parse` refuses.
 */
function workspaceAliases(): Alias[] {
  const path = from("./tsconfig.base.json");
  const { config, error } = ts.readConfigFile(path, (file) => ts.sys.readFile(file));
  if (error) {
    throw new Error(
      `Could not read ${path}, which is where the test runner's package aliases come from: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`,
    );
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
    const target = targets[0];
    if (target === undefined) {
      throw new Error(`"${specifier}" in tsconfig.base.json maps to nothing.`);
    }
    if (specifier.split("*").length > 2 || target.split("*").length > 2) {
      throw new Error(
        `"${specifier}" in tsconfig.base.json uses more than one "*". TypeScript allows at most one, and the alias below rewrites only the first.`,
      );
    }
    return {
      // `@kobai/core/*` → /^@kobai\/core\/(.*)$/, so a subpath export needs no edit.
      // Targets are relative to the repository root, which is where this file sits, so
      // `baseUrl: "."` needs no separate handling.
      find: new RegExp(`^${escapeRegExp(specifier).replace("\\*", "(.*)")}$`),
      replacement: from(target.replace("*", "$1")),
    };
  });
}

type TsconfigShape = { compilerOptions?: { paths?: Record<string, string[]> } };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
