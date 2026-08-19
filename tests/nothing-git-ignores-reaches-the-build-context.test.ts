import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The same anchoring mistake #203 found in `biome.json`, held against every `.dockerignore`.
 *
 * `.gitignore` matches a pattern with no slash in it **at any depth**; a `.dockerignore`
 * pattern is anchored at the build context's root unless it opens with `**\/`. So the two
 * files say the same words and mean different things, and the difference is invisible until
 * something generates a file below the root — which `cd reference && devbox run build` does,
 * every time (ADR-0068).
 *
 * Both `.dockerignore`s carried `.devbox`, `.env` and `.env.*` root-anchored, directly beside
 * `**\/node_modules` and `**\/dist`, and the workspace Dockerfile opens with `COPY . .` and
 * ends with `COPY --from=build /repo /repo`. Measured against a real `docker build` rather
 * than reasoned about: with the old patterns, `reference/.devbox/nix/manifest.json` and
 * `reference/.env` both arrive in the context; with `**\/` in front of them, neither does and
 * an ordinary file beside them still arrives.
 *
 * `.env` is the one that makes this more than housekeeping. `.gitignore` hides it from
 * `git status` at every depth, so nobody would see it sitting there — and a credential that
 * reaches a layer is in that layer forever, which is the reason `.npmrc` is mounted as a
 * build secret rather than copied (AGENTS.md § Writing tests, the image seam).
 *
 * The rule below is therefore **derived, not listed**: a `.dockerignore` pattern naming
 * something the governing `.gitignore` also ignores has to match at the same depths. It says
 * nothing about `.git`, `docs`, `*.md` or `.npmrc`, which no ignore file names — those are
 * tracked or absent, so how they are anchored is a build-context question rather than this
 * one.
 */
const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * A build context, and the ignore file that says what a checkout of it generates.
 *
 * Three, because a fix applied to one reaches the third only through
 * `devbox run template:generate` — and the third is the one a Developer actually receives.
 * `tests/a-fresh-checkout-is-told-what-to-run.test.ts` runs all three copies of the install
 * guard for the same reason.
 */
const CONTEXTS: readonly { dockerignore: string; gitignore: string; why: string }[] = [
  {
    dockerignore: ".dockerignore",
    gitignore: ".gitignore",
    why: "The workspace's image is built from the repository root, so the repository's own ignore file is the one naming what a checkout generates.",
  },
  {
    dockerignore: "reference/.dockerignore",
    gitignore: ".gitignore",
    why: "The reference Project is a folder inside this repository and has no ignore file of its own; the root's covers it.",
  },
  {
    dockerignore: "packages/create-kobai/template/dockerignore",
    gitignore: "packages/create-kobai/standalone/gitignore",
    why: "What a Developer receives, beside the ignore file `create-kobai` writes into the same Project. Generated from the reference Project's, so it is checked separately rather than assumed to have followed.",
  },
];

/** Patterns, with comments and blank lines dropped. Neither file format has any other syntax. */
function patternsIn(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** What a pattern names, with its negation and its `**` and directory markers taken off. */
function subject(pattern: string): string {
  return pattern
    .replace(/^!/, "")
    .replace(/^\*\*\//, "")
    .replace(/\/$/, "");
}

/** Whether a pattern matches at every depth, which is what a `.gitignore` entry does by default. */
function matchesAtEveryDepth(pattern: string): boolean {
  return pattern.replace(/^!/, "").startsWith("**/");
}

describe("the build context", () => {
  it.each(CONTEXTS)(
    "anchors $dockerignore the way .gitignore does",
    async ({ dockerignore, gitignore, why }) => {
      const ignored = new Set(
        patternsIn(await readFile(join(repoRoot, gitignore), "utf8")).map(subject),
      );
      const patterns = patternsIn(await readFile(join(repoRoot, dockerignore), "utf8"));

      expect(patterns.length).toBeGreaterThan(0);

      for (const pattern of patterns) {
        if (!ignored.has(subject(pattern))) continue;
        expect(
          matchesAtEveryDepth(pattern),
          `${dockerignore} has "${pattern}", which is anchored at the build context's root — but ${gitignore} ignores "${subject(pattern)}" at every depth, so a checkout generates one below the root and nothing shows you it is there. Write it as "${pattern.replace(/^(!?)/, "$1**/")}". ${why}`,
        ).toBe(true);
      }
    },
  );

  /**
   * A `.dockerignore` this file has never heard of is a build context nothing above checks,
   * so the table is held complete rather than trusted. Asked of git, because a file that is
   * not tracked is not one a build anybody else runs would use.
   */
  it("knows about every .dockerignore in the repository", async () => {
    const { stdout } = await run(
      "git",
      ["ls-files", "--", ":(glob)**/.dockerignore", ":(glob)**/dockerignore"],
      { cwd: repoRoot },
    );
    const tracked = stdout.trim().split("\n").filter(Boolean).sort();

    expect(tracked).toEqual(CONTEXTS.map((c) => c.dockerignore).sort());
  });
});
