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
  consoleLogger,
  defineKobaiConfig,
  type KobaiProjectConfig,
  type Logger,
} from "./config.ts";
export type { Database } from "./db/client.ts";
export type { HealthBody } from "./http/health.ts";
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
export type { StepReport, WorkflowRun } from "./workflow/run.ts";
export type { Step } from "./workflow/step.ts";
export { defineStep, StepFailure } from "./workflow/step.ts";
/**
 * The Workflow surface, in full. Under ADR-0019 every name here is a promise, so it is only
 * what a Project needs: the two ways to declare, the two ways to read a declaration, and
 * `StepInput`/`StepOutput`, which are what let a replacement be measured against the Step it
 * replaces (spec story 27). The builder's own types and the shape map behind those helpers
 * stay internal — they are how the promise is kept, not part of it.
 */
export type {
  StepDescriptor,
  StepInput,
  StepOutput,
  Workflow,
  WorkflowDescription,
  WorkflowSlots,
  WorkflowStep,
} from "./workflow/workflow.ts";
export { defineWorkflow } from "./workflow/workflow.ts";
