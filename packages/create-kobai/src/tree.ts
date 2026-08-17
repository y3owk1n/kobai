import { readdir } from "node:fs/promises";
import { join, posix, sep } from "node:path";

/**
 * Walking a Project's files, the same way for the three things that need to: generating the
 * template from the reference Project, scaffolding a Project from the template, and checking
 * the two still agree.
 *
 * One implementation because the three have to agree about what a Project *is*. If the drift
 * check walked a different set of files from the generator, it would pass while the generator
 * shipped something it never compared.
 */

/**
 * Directories that are build output or installed dependencies, never Project source.
 *
 * Named rather than pattern-matched, so adding one is a decision. `dist` is on the list twice
 * over: it is the Project's compiled TypeScript *and* the Admin's built bundle, and neither
 * belongs in a template — `create-kobai` generates source, and the first thing a Developer
 * runs builds it.
 */
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".devbox", ".git"]);

/**
 * Files that are not a Project's source.
 *
 * `.env.example` is source and `.env` is not — the first is the documented list of every
 * variable kobai reads, the second is a Developer's own copy with their own values in it.
 *
 * **`*.test.ts` is the interesting one.** The reference Project's tests are *kobai's* tests:
 * they boot Core with a throwaway database through `@kobai/core/testing`, and they exist to
 * prove the extension surface works on every commit (ADR-0029). A Developer's Project
 * inherits none of that — it has no vitest, no test harness and nothing yet worth asserting
 * — so shipping them would generate a Project that fails its own typecheck on the first
 * command anyone ran. What a Project tests is the Developer's to decide.
 */
function isSkippedFile(name: string): boolean {
  return (
    name.endsWith(".tsbuildinfo") ||
    name.endsWith(".test.ts") ||
    name === ".DS_Store" ||
    (name.startsWith(".env") && name !== ".env.example")
  );
}

/**
 * Every file under `root`, as POSIX-separated paths relative to it, sorted.
 *
 * Sorted because two trees are compared by walking both, and an unstable order would make
 * the comparison report differences that are only ordering. POSIX-separated because the
 * paths are compared against the adaptation list, which is written with `/`.
 */
export async function projectFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(join(directory, entry.name), posix.join(prefix, entry.name));
        continue;
      }

      // A symlink in a Project would be a file whose contents depend on where it points,
      // which nothing here could copy faithfully. None exists; this makes that a fact rather
      // than an assumption.
      if (!entry.isFile()) continue;
      if (isSkippedFile(entry.name)) continue;

      found.push(posix.join(prefix, entry.name));
    }
  };

  await walk(root, "");
  return found.sort();
}

/** A relative POSIX path, as this platform's path. */
export function toPlatformPath(relative: string): string {
  return sep === "/" ? relative : relative.split("/").join(sep);
}
