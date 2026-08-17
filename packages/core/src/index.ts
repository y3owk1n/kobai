/**
 * `@kobai/core` — the package a Project depends on.
 *
 * A Developer never edits Core; upgrading it is a version bump, not a merge (ADR-0001).
 * What that costs is that everything reachable from here is a promise, so the surface is
 * kept small on purpose.
 */

export type { ApiKeyKind, IssuedApiKey } from "./auth/api-key.ts";
export { API_KEY_KINDS, API_KEY_PREFIX } from "./auth/api-key.ts";
export type { MerchantIdentity, RoleSummary } from "./auth/identity.ts";
export type { Permission } from "./auth/permissions.ts";
export { ALL_PERMISSIONS, OWNER_ROLE, PERMISSIONS } from "./auth/permissions.ts";
export type { Price, Product, ProductDetail, Variant } from "./catalog/read.ts";
export {
  type CoreWorkflowOverrides,
  consoleLogger,
  defineKobaiConfig,
  type KobaiProjectConfig,
  type Logger,
} from "./config.ts";
export type { Database } from "./db/client.ts";
export type { HealthBody } from "./http/health.ts";
/**
 * The OpenAPI description is on the surface because ADR-0002 makes the API the product:
 * `kobai.openapi()` is how a Project publishes the description of the API *it* serves, and
 * `packages/core/openapi.json` — reachable as `@kobai/core/openapi.json` — is Core's own.
 */
export type { OpenApiDocument } from "./http/openapi.ts";
export { createKobai, type Kobai, type KobaiOptions } from "./kobai.ts";
export type {
  AppliedMigrationSet,
  MigrationOutcome,
  MigrationSet,
  MigrationState,
} from "./migrations/index.ts";
export type {
  LoadedPrices,
  PriceCandidate,
  PriceResolutionRefusal,
  PriceResolutionRequest,
  PriceResolutionWorkflow,
  ResolvedPrice,
  VariantIdentity,
} from "./pricing/resolve-price.ts";
export {
  loadPrices,
  priceResolutionWorkflow,
  selectPrice,
} from "./pricing/resolve-price.ts";
export type { Store } from "./store/read.ts";
export type { WorkflowContext } from "./workflow/context.ts";
export { openMetadata } from "./workflow/context.ts";
export type { CompensationFailure, StepReport, WorkflowRun } from "./workflow/run.ts";
/**
 * Exported because it is what a Project catches. Unwinding never replaces what stopped a run
 * (ADR-0036), so this is how the *other* fact — the Store may be inconsistent — reaches
 * anything that wrapped a Workflow's `run` in a `try`.
 */
export { UnwindFailure } from "./workflow/run.ts";
export type { Step } from "./workflow/step.ts";
export { defineStep, StepFailure } from "./workflow/step.ts";
/**
 * The Workflow surface, in full. Under ADR-0019 every name here is a promise, so it is only
 * what a Project needs: the two ways to declare, the two ways to read a declaration,
 * `StepInput`/`StepOutput`, which are what let a replacement be measured against the Step it
 * replaces (spec story 27), `InsertedStep` and the two insertion maps, which are what pin an
 * observing Step to the value it may not change (story 29), and the shape of an override map
 * for a Project that assembles one outside `kobai.config.ts`. The builder's own types, the
 * shape map behind those helpers, and `rewireWorkflow` itself stay internal — a Project
 * rewires a Workflow by declaring it in its config, and a second way in would be
 * customisation this repository's one config file could not show.
 */
export type {
  InsertedStep,
  StepDescriptor,
  StepInput,
  StepOutput,
  StepOverrides,
  StepsAfter,
  StepsBefore,
  Workflow,
  WorkflowDescription,
  WorkflowOverrides,
  WorkflowSlots,
  WorkflowStep,
} from "./workflow/workflow.ts";
export { defineWorkflow } from "./workflow/workflow.ts";
