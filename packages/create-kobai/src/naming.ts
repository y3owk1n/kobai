/**
 * The names the two trees disagree about, and nothing else.
 *
 * This module imports nothing — not even a Node builtin — and that is deliberate. `scaffold`
 * needs these constants, and `scaffold` is what the published CLI runs; everything it can
 * reach becomes a runtime dependency of `create-kobai`. Keeping the constants here rather
 * than in `adaptations.ts` keeps `jsonc-parser`, which only `template:generate` ever needs,
 * off the command's load path.
 */

/** The reference Project's npm name — the token every adaptation renames away from. */
export const REFERENCE_PROJECT_NAME = "kobai-reference";

/**
 * The name the template carries, and the token `scaffold` replaces with whatever the
 * Developer called their Project.
 *
 * One token covers the Admin's package too, because `kobai-project-admin` has
 * `kobai-project` as a prefix — so a single replacement renames the Project, its Admin, the
 * `pnpm --filter` arguments in `devbox.json`, and the two module specifiers that resolve
 * them at runtime. That is why no `.ts` file in the template needs a placeholder that would
 * stop it being valid TypeScript.
 */
export const TEMPLATE_PROJECT_NAME = "kobai-project";

/**
 * Files a Project carries with a leading dot, stored in the template without one.
 *
 * **npm strips a `.gitignore` out of every tarball it builds.** Not as an ignore rule and not
 * as a `files` question — the name is dropped unconditionally, so the file is present in this
 * repository, correct in every test, and simply missing from the published package. That was
 * measured here: `pnpm pack` produced a tarball holding 50 of the template's 51 files, and
 * the one it left behind was `.gitignore`.
 *
 * npm *also* reads a `.gitignore` inside a packed directory as ignore rules for that
 * subtree, so leaving one in place lets the template's own contents be filtered out of the
 * tarball by rules written for a Developer's Project — a second, quieter failure from the
 * same file.
 *
 * `.dockerignore` survives `pnpm pack` today and is on this list anyway. The two packers do
 * not agree about which dotfiles they drop, and a Project whose contents depend on which one
 * happened to publish it is not a Project anybody has tested. Storing every such file under a
 * name no packer has an opinion about takes the question off the table.
 *
 * `.env.example` is deliberately **not** here: it survives packing, and renaming it would
 * mean renaming the file `.env.example` tells a Developer to copy.
 */
export const DOTFILES_STORED_DOTLESS: readonly string[] = [".gitignore", ".dockerignore"];

/** One path as the template stores it — dotless, if it is one of the files above. */
export function toTemplateName(projectPath: string): string {
  return DOTFILES_STORED_DOTLESS.includes(projectPath)
    ? projectPath.slice(1)
    : projectPath;
}

/** One path as a generated Project holds it — the leading dot put back. */
export function toProjectName(templatePath: string): string {
  return DOTFILES_STORED_DOTLESS.includes(`.${templatePath}`)
    ? `.${templatePath}`
    : templatePath;
}
