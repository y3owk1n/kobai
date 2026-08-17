import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const from = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * One config for the whole repository.
 *
 * `@kobai/core` resolves to source here, not to `dist`. The package's own `exports` point at
 * `dist` so a Project gets built JavaScript, but a test run should not need a build step
 * first. The Dockerfile and the reference Project's own tests exercise the `dist` path.
 */
export default defineConfig({
  resolve: {
    // The same two mappings `tsconfig.base.json` declares under `paths`. Keep them in step:
    // a new subpath export needs no edit here, but a new package does.
    alias: [
      {
        find: /^@kobai\/core\/(.*)$/,
        replacement: from("./packages/core/src/$1/index.ts"),
      },
      { find: /^@kobai\/core$/, replacement: from("./packages/core/src/index.ts") },
    ],
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
