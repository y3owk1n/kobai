import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adaptToTemplate, contextFrom, STANDALONE_FILES } from "./adaptations.ts";
import { toTemplateName } from "./naming.ts";
import { isBinary, projectFiles, toPlatformPath } from "./tree.ts";

/**
 * The template, built from the reference Project.
 *
 * **The reference Project is the source and the template is the artifact**, which is the
 * only arrangement that makes ADR-0029 true. The maintainers edit the Project they actually
 * boot, run and test; `devbox run template:generate` carries those edits into what a
 * Developer receives; and `tests/create-kobai-matches-the-reference-project.test.ts` fails
 * the build when the two have drifted. That is the same shape `packages/core/openapi.json`
 * and `packages/client/src/schema.ts` already have in this repository — generated, checked
 * in, and guarded by a test that regenerates and compares.
 *
 * The template is checked in rather than built at pack time because `create-kobai` has to
 * work as a standalone tarball on a Developer's machine, where there is no `reference/` to
 * read. `files` in its manifest ships this directory for exactly that reason.
 */

export type TemplateSources = {
  /** The reference Project — the source of everything except the standalone files. */
  readonly referenceRoot: string;
  /** Where the template is written. Emptied first, so a deleted file does not linger. */
  readonly templateRoot: string;
  /** The files a generated Project has and the reference Project does not. */
  readonly standaloneRoot: string;
  /** The repository root's `package.json`, which pins the pnpm a generated Project pins. */
  readonly rootManifest: string;
  /** `@kobai/core`'s `package.json`, whose version a generated Project depends on. */
  readonly coreManifest: string;
};

/** One file of the template, and where its bytes came from. */
export type TemplateFile = {
  readonly path: string;
  readonly contents: Buffer;
};

/**
 * What the template should contain, computed but not written.
 *
 * Separated from writing so the drift test can ask for it without touching the working tree
 * — the test compares this against what is checked in, and a test that had to write files
 * first would be reporting on its own output.
 */
export async function buildTemplate(sources: TemplateSources): Promise<TemplateFile[]> {
  const files: TemplateFile[] = [];
  const context = contextFrom(
    await readFile(sources.rootManifest, "utf8"),
    await readFile(sources.coreManifest, "utf8"),
  );

  for (const relative of await projectFiles(sources.referenceRoot)) {
    const contents = await readFile(
      join(sources.referenceRoot, toPlatformPath(relative)),
    );

    files.push({
      // Adapted under the path the *Project* uses, stored under the one the template uses.
      // A dotfile the packers disagree about is renamed here and renamed back by `scaffold`,
      // so the adaptation list never has to know about it.
      path: toTemplateName(relative),
      contents: isBinary(contents)
        ? contents
        : Buffer.from(
            adaptToTemplate(relative, contents.toString("utf8"), context),
            "utf8",
          ),
    });
  }

  for (const { file } of STANDALONE_FILES) {
    // Authored under `standalone/` under the same name it takes in the template. The
    // Project's `.gitignore` is `gitignore` in both places and becomes a real one only when
    // `scaffold` writes it out — see DOTFILES_STORED_DOTLESS for the two separate reasons.
    files.push({
      path: file,
      contents: await readFile(join(sources.standaloneRoot, file)),
    });
  }

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Writes the template, replacing whatever was there. */
export async function syncTemplate(sources: TemplateSources): Promise<TemplateFile[]> {
  const files = await buildTemplate(sources);

  // Emptied rather than merged: a file deleted from the reference Project has to disappear
  // from the template too, and a merge would leave it behind to be generated forever.
  await rm(sources.templateRoot, { recursive: true, force: true });

  for (const file of files) {
    const destination = join(sources.templateRoot, toPlatformPath(file.path));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.contents);
  }

  return files;
}
