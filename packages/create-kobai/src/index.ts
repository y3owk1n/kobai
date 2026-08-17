/**
 * `create-kobai` — the command that generates a Project a Developer owns outright (ADR-0001,
 * ADR-0025).
 *
 * The scaffolding itself is `scaffold`. Everything else exported here exists because two
 * other things need it: the drift check that keeps what is generated equal to the reference
 * Project, and #12's upgrade gate, which scaffolds a Project and bumps Core across a
 * synthetic major.
 */
export {
  type Adaptation,
  type AdaptationContext,
  adaptationsFor,
  adaptToTemplate,
  contextFrom,
  KOBAI_VERSION_RANGE,
  PUBLISHED_KOBAI_PACKAGES,
  REFERENCE_PROJECT_NAME,
  STANDALONE_FILES,
  TEMPLATE_PROJECT_NAME,
} from "./adaptations.ts";
export { main, parseArguments } from "./cli.ts";
export { type ScaffoldOptions, type ScaffoldResult, scaffold } from "./scaffold.ts";
export {
  buildTemplate,
  syncTemplate,
  type TemplateFile,
  type TemplateSources,
} from "./template.ts";
export { projectFiles, toPlatformPath } from "./tree.ts";
