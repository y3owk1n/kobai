import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { projectFiles, REFERENCE_PROJECT_NAME, toPlatformPath } from "create-kobai";
import {
  adaptationsFor,
  buildTemplate,
  contextFrom,
  STANDALONE_FILES,
  type TemplateFile,
} from "create-kobai/authoring";
import { describe, expect, it } from "vitest";
import { TARBALL_ROOT, tarballEntries } from "./support/tarball.ts";

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
 * entry in `adaptationsFor` or `STANDALONE_FILES`; anything else fails, whichever direction
 * it points. A byte comparison with no allowances would fail the moment the reference Project
 * legitimately said `workspace:*`; an allowance broad enough to cover that quietly would
 * pass forever. The list being short enough to read in a review is the whole guarantee.
 */

const repoRoot = new URL("../", import.meta.url);
const referenceRoot = fileURLToPath(new URL("reference/", repoRoot));
const packageRoot = fileURLToPath(new URL("packages/create-kobai/", repoRoot));
const templateRoot = join(packageRoot, "template");
const standaloneRoot = join(packageRoot, "standalone");
const rootManifest = fileURLToPath(new URL("package.json", repoRoot));
const coreManifest = fileURLToPath(new URL("packages/core/package.json", repoRoot));

/** Rebuilding the template shells out to nothing, but it does read ~50 files twice. */
const TIMEOUT = 30_000;
/** Packing shells out to pnpm, which is seconds rather than milliseconds on a cold runner. */
const PACK_TIMEOUT = 180_000;

async function expected(): Promise<TemplateFile[]> {
  return buildTemplate({
    referenceRoot,
    templateRoot,
    standaloneRoot,
    rootManifest,
    coreManifest,
  });
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

  it(
    "sweeps up nothing a run of the reference Project wrote",
    async () => {
      // The reference Project is a Project as well as the template's source, and running one
      // writes files: the `MediaStorage` Core ships puts a Merchant's uploads under the
      // process's working directory (ADR-0078), which for `devbox run dev` and for the browser
      // seam that boots it in the gate is `reference/` itself. So a single upload — the Admin's
      // own Media case does one every run — left a PNG here, and generation swept it into the
      // checked-in template. Both assertions above went red naming a UUID, and what a Developer
      // would have received was an image from somebody's test run (#254).
      //
      // `.gitignore` names `kobai-media/` and could not have caught it: this walk reads no
      // ignore file, exactly as a `.dockerignore` cannot delegate to one (ADR-0068). So the
      // skip is `projectFiles`'s own, and this is the arrangement that broke it — a file put
      // where a run puts one, against the real tree rather than a synthetic stand-in.
      const directory = join(referenceRoot, "kobai-media");
      const stray = join(directory, `${randomUUID()}.png`);
      await mkdir(directory, { recursive: true });
      await writeFile(stray, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      try {
        expect(
          (await expected())
            .map((file) => file.path)
            .filter((path) => path.includes("kobai-media")),
          "A run of the reference Project left this behind, and generation put it in the template.",
        ).toEqual([]);
      } finally {
        // The file only, never the directory: `devbox run dev` writes a Developer's own
        // uploads here and this test has no business deleting them.
        await rm(stray, { force: true });
      }
    },
    TIMEOUT,
  );

  it("carries no workspace-only dependency into a generated Project", async () => {
    // The independent check, and the one that would survive the adaptation list being wrong:
    // a `workspace:` specifier resolves only inside this repository, so one that reached the
    // template would produce a Project that cannot install anywhere. The version-range
    // adaptation is what prevents it, and this asserts the outcome rather than the rule.
    //
    // Against the **checked-in** bytes, not the freshly computed ones. Asserting on
    // `expected()` would be asking the generator whether it did what it just did; these are
    // the bytes that get published, which is the only version of the question that matters.
    const offenders = [...(await checkedIn())].flatMap(([path, bytes]) => {
      if (!path.endsWith("package.json")) return [];

      const manifest = JSON.parse(bytes.toString("utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
        .filter(
          ([name, range]) => range.startsWith("workspace:") && name.startsWith("@kobai/"),
        )
        .map(([name]) => `${path} → ${name}`);
    });

    expect(offenders).toEqual([]);
  });

  it("leaves no trace of the reference Project's own name", async () => {
    // The rename is a plain string replacement, so the way it fails is by missing a file
    // rather than by mangling one. A surviving `kobai-reference` would be a `pnpm --filter`
    // that matches nothing, or a module specifier that resolves nowhere, in a Project whose
    // Developer has never heard the word "reference".
    //
    // Against the checked-in bytes for the same reason as above.
    const offenders = [...(await checkedIn())].flatMap(([path, bytes]) =>
      bytes.toString("utf8").includes(REFERENCE_PROJECT_NAME) ? [path] : [],
    );

    expect(offenders).toEqual([]);
  });

  it("holds nothing but what generation put there", async () => {
    // `projectFiles` applies the same skip list to both trees, which is right for comparing
    // them and leaves one hole: a file matching a skip — a `.test.ts`, a stray `.env` — that
    // someone hand-added under `template/` would be invisible to every assertion above and
    // would still be published, because npm packs the directory rather than the walk.
    //
    // So this walks the checked-in template with no skips at all. `syncTemplate` empties the
    // directory before writing, so anything here that generation did not produce arrived by
    // hand, and `template/` is not a directory to edit by hand.
    const everything: string[] = [];
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(join(directory, entry.name), path);
        else everything.push(path);
      }
    };
    await walk(templateRoot, "");

    const generated = new Set((await expected()).map((file) => file.path));
    expect(
      everything.filter((path) => !generated.has(path)).sort(),
      "These files are inside the template but generation does not produce them. Run `devbox run template:generate`, which rewrites the directory from scratch.",
    ).toEqual([]);
  });

  it("ships no test file, because the reference Project's tests are kobai's", async () => {
    // Against the checked-in bytes, which is what makes this an assertion rather than a
    // tautology: `projectFiles` filters `*.test.ts` out of what generation *produces*, so
    // asking `expected()` could never fail. What can fail is a test file sitting in the
    // published directory — and these import `@kobai/core/testing` and vitest, neither of
    // which a generated Project has, so one arriving breaks it on the first command run.
    expect(
      [...(await checkedIn()).keys()].filter((path) => path.endsWith(".test.ts")),
    ).toEqual([]);
  });

  it(
    "puts every template file into the tarball it publishes",
    async () => {
      // This closes the gap between "correct in this repository" and "correct for a
      // Developer", and it exists because that gap was real rather than theoretical: **npm
      // drops a `.gitignore` from every tarball it builds**, unconditionally and silently.
      // The Project's `.gitignore` was present here, asserted by every check above, and
      // absent from the packed package — every assertion in this file compares two
      // directories, and both of them were right.
      //
      // What a Developer installs is the tarball, so the tarball is what this reads. The two
      // packers also disagree about which dotfiles they drop, which is why the fix was to
      // store those under names neither has an opinion about rather than to appease one.
      const destination = await mkdtemp(join(tmpdir(), "kobai-create-pack-"));
      try {
        await promisify(execFile)(
          "pnpm",
          ["--dir", packageRoot, "pack", "--pack-destination", destination],
          { cwd: fileURLToPath(repoRoot) },
        );

        const [tarball] = await readdir(destination);
        if (tarball === undefined)
          throw new Error("Packing create-kobai wrote no tarball.");

        const inside = `${TARBALL_ROOT}template/`;
        const packed = new Set(
          tarballEntries(await readFile(join(destination, tarball)))
            .filter((entry) => entry.startsWith(inside))
            .map((entry) => entry.slice(inside.length)),
        );

        expect(
          [...(await checkedIn()).keys()].filter((path) => !packed.has(path)),
          "These template files are in this repository and not in the tarball, so they reach nobody who installs create-kobai.",
        ).toEqual([]);
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    },
    PACK_TIMEOUT,
  );

  it("keeps the list of differences short enough to read", async () => {
    const adaptations = adaptationsFor(
      contextFrom(
        await readFile(rootManifest, "utf8"),
        await readFile(coreManifest, "utf8"),
      ),
    );

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
