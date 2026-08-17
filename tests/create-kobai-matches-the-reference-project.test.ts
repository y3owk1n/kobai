import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adaptationsFor,
  buildTemplate,
  contextFrom,
  projectFiles,
  REFERENCE_PROJECT_NAME,
  STANDALONE_FILES,
  type TemplateFile,
  toPlatformPath,
} from "create-kobai";
import { describe, expect, it } from "vitest";

/**
 * Criterion 11 of #11: what `create-kobai` generates **is** the reference Project, and the
 * build fails when the two drift.
 *
 * This is the half of the scaffolder with a long life. A generator is easy to write once and
 * easy to forget: the reference Project is edited on nearly every ticket — it is the Project
 * kobai's maintainers actually boot (ADR-0029) — and nothing about editing it would remind
 * anyone that a template exists. A month of that and `create-kobai` generates a Project no
 * one has run.
 *
 * So this regenerates the template from the reference Project and compares it, byte for
 * byte, against what is checked in. That is the same arrangement `packages/core/openapi.json`
 * and `packages/client/src/schema.ts` already have — generated, checked in, and guarded by a
 * test that regenerates and compares.
 *
 * **The comparison fails closed.** Every difference between the two trees has to be a named
 * entry in `ADAPTATIONS` or `STANDALONE_FILES`; anything else fails, whichever direction it
 * points. A byte comparison with no allowances would fail the moment the reference Project
 * legitimately said `workspace:*`; an allowance broad enough to cover that quietly would
 * pass forever. The list being short enough to read in a review is the whole guarantee.
 */

const repoRoot = new URL("../", import.meta.url);
const referenceRoot = fileURLToPath(new URL("reference/", repoRoot));
const packageRoot = fileURLToPath(new URL("packages/create-kobai/", repoRoot));
const templateRoot = join(packageRoot, "template");
const standaloneRoot = join(packageRoot, "standalone");
const rootManifest = fileURLToPath(new URL("package.json", repoRoot));

/** Rebuilding the template shells out to nothing, but it does read ~50 files twice. */
const TIMEOUT = 30_000;

async function expected(): Promise<TemplateFile[]> {
  return buildTemplate({ referenceRoot, templateRoot, standaloneRoot, rootManifest });
}

/** What is checked in, read the same way `scaffold` reads it. */
async function checkedIn(): Promise<Map<string, Buffer>> {
  const files = await projectFiles(templateRoot);
  const contents = await Promise.all(
    files.map(async (path) => {
      const bytes = await readFile(join(templateRoot, toPlatformPath(path)));
      return [path, bytes] as const;
    }),
  );
  return new Map(contents);
}

describe("the generated Project matches the reference Project", () => {
  it(
    "has exactly the reference Project's files, plus the standalone ones",
    async () => {
      const generated = (await expected()).map((file) => file.path);
      const shipped = [...(await checkedIn()).keys()];

      // A file present in one tree and absent from the other is the failure this catches
      // most often and most quietly: a new module added to the reference Project, and a
      // template that simply never received it.
      expect(shipped).toEqual(generated);
    },
    TIMEOUT,
  );

  it(
    "matches byte for byte once the named adaptations are applied",
    async () => {
      const shipped = await checkedIn();

      const drifted = (await expected()).flatMap((file) => {
        // A file the template does not have at all reads as drifted here too, which is
        // right — it is the same fix, and the assertion above already named it precisely.
        if (shipped.get(file.path)?.equals(file.contents)) return [];
        return [file.path];
      });

      // Named rather than diffed, because the fix is always the same one command and the
      // list of files is what says how far the drift spread.
      expect(
        drifted,
        `These template files no longer match the reference Project they are generated from. Run \`devbox run template:generate\` to bring them back into step, and read the diff before committing it — a change you did not expect here is a change to what every Developer receives.`,
      ).toEqual([]);
    },
    TIMEOUT,
  );

  it("carries no workspace-only dependency into a generated Project", async () => {
    // The independent check, and the one that would survive `ADAPTATIONS` being wrong: a
    // `workspace:` specifier resolves only inside this repository, so one that reached the
    // template would produce a Project that cannot install anywhere. The version-range
    // adaptation is what prevents it, and this asserts the outcome rather than the rule.
    const offenders = (await expected()).flatMap((file) => {
      if (!file.path.endsWith("package.json")) return [];

      const manifest = JSON.parse(file.contents.toString("utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter(
          ([name, range]) => range.startsWith("workspace:") && name.startsWith("@kobai/"),
        )
        .map(([name]) => `${file.path} → ${name}`);
    });

    expect(offenders).toEqual([]);
  });

  it("leaves no trace of the reference Project's own name", async () => {
    // The rename is a plain string replacement, so the way it fails is by missing a file
    // rather than by mangling one. A surviving `kobai-reference` would be a `pnpm --filter`
    // that matches nothing, or a module specifier that resolves nowhere, in a Project whose
    // Developer has never heard the word "reference".
    const offenders = (await expected()).flatMap((file) =>
      file.contents.toString("utf8").includes(REFERENCE_PROJECT_NAME) ? [file.path] : [],
    );

    expect(offenders).toEqual([]);
  });

  it("ships no test file, because the reference Project's tests are kobai's", async () => {
    // Asserted rather than assumed: these tests import `@kobai/core/testing` and vitest,
    // neither of which a generated Project has, so one arriving would break the Project on
    // the first command a Developer ran.
    expect((await expected()).filter((file) => file.path.endsWith(".test.ts"))).toEqual(
      [],
    );
  });

  it("keeps the list of differences short enough to read", async () => {
    const adaptations = adaptationsFor(contextFrom(await readFile(rootManifest, "utf8")));

    // Not a style rule. This test is worth exactly as much as the adaptation list is honest,
    // and the way it stops being honest is one convenient entry at a time until the
    // comparison covers nothing. A number here forces the growth to be a decision someone
    // makes on purpose, in a diff, with this comment in front of them.
    expect(adaptations.length + STANDALONE_FILES.length).toBeLessThanOrEqual(14);

    // Every one of them has to say why it exists, in words, for whoever reads the failure.
    for (const adaptation of adaptations) {
      expect(
        adaptation.what.length,
        `${adaptation.file} has no reason written down`,
      ).toBeGreaterThan(20);
    }
    for (const standalone of STANDALONE_FILES) {
      expect(
        standalone.why.length,
        `${standalone.file} has no reason written down`,
      ).toBeGreaterThan(20);
    }
  });
});
