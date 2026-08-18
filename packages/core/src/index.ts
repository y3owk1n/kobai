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
/**
 * Exported because a Project hands the credentials in and reads the outcome back: the first
 * Merchant is seeded at boot, and Core has no unauthenticated way to create one (#25).
 */
export type {
  InitialMerchantCredentials,
  InitialMerchantSeed,
} from "./auth/seed.ts";
/**
 * The one thing a Project may say about how long its sessions live (ADR-0050). Exported as a
 * type alone: the window is a number in `kobai.config.ts`, and the bounds on it are in that
 * key's documentation and in the message a boot fails with, so there is nothing here a
 * Project has to import to write one. The absolute cap is Core's and is not on this surface.
 */
export type { SessionOptions } from "./auth/session.ts";
export type { Price, Product, ProductDetail, Variant } from "./catalog/read.ts";
export {
  type CoreWorkflowOverrides,
  consoleLogger,
  defineKobaiConfig,
  type KobaiProjectConfig,
  type Logger,
} from "./config.ts";
export type { Database } from "./db/client.ts";
/**
 * Exported because a Project reads the outcome and decides what it means, exactly as it does
 * for a migration — and because keeping the two answers apart is the point of having two
 * (ADR-0048).
 */
export type { DatabaseReadiness, WaitForDatabaseOptions } from "./db/readiness.ts";
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
/**
 * `place-order`, in full, for the same reason `resolve-price` is: a Project replacing a Step
 * needs the declaration to measure the replacement against and the types the slot moves.
 */
export type {
  AdjustedLine,
  AdjustedLines,
  Adjustment,
  CartLineToPlace,
  CartToPlace,
  LoadedCart,
  PlaceOrderRefusal,
  PlaceOrderRequest,
  PlaceOrderWorkflow,
  PricedLine,
  PricedLines,
  TaxedLine,
  TaxedLines,
} from "./order/place-order.ts";
export {
  applyAdjustments,
  calculateTax,
  captureOrder,
  loadCart,
  placeOrderWorkflow,
  priceLines,
} from "./order/place-order.ts";
export type {
  Order,
  OrderAdjustment,
  OrderLineItem,
  OrderShopper,
} from "./order/read.ts";
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
export type { WorkflowContext, WorkflowRegistry } from "./workflow/context.ts";
export { openMetadata } from "./workflow/context.ts";
export type { CompensationFailure, StepReport, WorkflowRun } from "./workflow/run.ts";
/**
 * `runWorkflow` is the one way a Step invokes another Workflow (ADR-0054), on the surface
 * because a Plugin's Step and a Project's Step compose for the same reasons Core's do — and
 * because reaching for `workflow.run` instead is the mistake it exists to prevent: that one
 * runs the declaration it was handed, which is Core's own whatever the deployment wired.
 *
 * `UnwindFailure` is here because it is what a Project catches. Unwinding never replaces what
 * stopped a run (ADR-0036), so this is how the *other* fact — the Store may be inconsistent —
 * reaches anything that wrapped a Workflow's `run` in a `try`.
 */
export { runWorkflow, UnwindFailure } from "./workflow/run.ts";
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
