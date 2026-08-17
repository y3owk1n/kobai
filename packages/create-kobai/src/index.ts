/**
 * `create-kobai` — the command that generates a Project a Developer owns outright (ADR-0001,
 * ADR-0025).
 *
 * **Everything exported here is reachable from the published CLI, and imports nothing but
 * Node builtins.** That is a constraint rather than a coincidence: a dependency on this path
 * is a dependency of `npm create kobai@latest`, and one that is missing from the tarball
 * fails for every Developer while passing every test run inside this workspace. The template
 * generator, which needs a JSONC parser, lives behind `create-kobai/authoring` for exactly
 * that reason.
 */
export { main, parseArguments } from "./cli.ts";
export {
  DOTFILES_STORED_DOTLESS,
  REFERENCE_PROJECT_NAME,
  TEMPLATE_PROJECT_NAME,
  toProjectName,
  toTemplateName,
} from "./naming.ts";
export { type ScaffoldOptions, type ScaffoldResult, scaffold } from "./scaffold.ts";
export { isBinary, projectFiles, toPlatformPath } from "./tree.ts";
