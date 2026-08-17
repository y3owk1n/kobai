/**
 * `create-kobai/authoring` — the half of this package kobai's own repository uses, and a
 * Developer never does.
 *
 * It is a separate entry point from `create-kobai` for one concrete reason: **everything
 * reachable from the CLI is a runtime dependency of the published command.** Generating the
 * template rewrites `tsconfig.json` files without destroying their comments, which needs
 * `jsonc-parser`; scaffolding copies bytes and replaces one token, which needs nothing at
 * all. Left in one module, the parser sat on the load path of `npm create kobai@latest` —
 * and a devDependency on that path is a command that dies with `ERR_MODULE_NOT_FOUND` for
 * everyone who installs it, while passing every test inside this workspace where the
 * repository root resolves it.
 *
 * So the split is not tidiness. It is the difference between a CLI whose dependencies are
 * Node's and one whose dependencies are whatever the template generator happened to need.
 *
 * `tests/create-kobai-matches-the-reference-project.test.ts` imports this, and so will #12's
 * upgrade gate.
 */
export {
  type Adaptation,
  type AdaptationContext,
  adaptationsFor,
  adaptToTemplate,
  contextFrom,
  PUBLISHED_KOBAI_PACKAGES,
  STANDALONE_FILES,
} from "./adaptations.ts";
export {
  buildTemplate,
  syncTemplate,
  type TemplateFile,
  type TemplateSources,
} from "./template.ts";
