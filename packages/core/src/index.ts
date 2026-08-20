/**
 * `@kobai/core` — the package a Project depends on.
 *
 * A Developer never edits Core; upgrading it is a version bump, not a merge (ADR-0001).
 * What that costs is that everything reachable from here is a promise, so the surface is
 * kept small on purpose.
 */

/**
 * An Address — the live one a Cart carries, and the **snapshot** an Order holds (ADR-0072).
 *
 * Both are named because both are already reachable: `CartToPlace.address` is what a replaced
 * `place-order` Step is handed, and `Order.address` is what a Capture answers with. Two names for
 * one noun is ADR-0009's asymmetry made visible — correcting the first cannot rewrite the second,
 * and `OrderAddress.region.id` goes `null` where its `name` does not.
 *
 * `AddressInput` and `ParsedAddress` are deliberately absent: reading a body is Core's, and a
 * Project that wants to judge an address does so in front of kobai or in a Step of its own.
 */
export type { Address, OrderAddress, OrderAddressRegion } from "./address/address.ts";
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
export type {
  ListedPrice,
  Price,
  Product,
  ProductDetail,
  Variant,
  VariantFulfilment,
} from "./catalog/read.ts";
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
/**
 * **Fulfilment** — the Strategy interface a Plugin implements, and the entity an Order records.
 *
 * `FulfilmentStrategy` is ADR-0003's third Extension Point at its widest: a Plugin exports an
 * object satisfying it, a Project names that object in `kobai.config.ts` under the key its
 * Variants point at, and nothing else connects the two (ADR-0017, ADR-0052). `FulfilledVariant`
 * and `FulfilmentAnswers` are what such an object is handed and what it returns, so both have to
 * be nameable; `FulfilmentOptions` is the shape of the config key.
 *
 * `CORE_FULFILMENT_STRATEGIES` is the one value here, because a Project that wants to answer as
 * `physical` does but for one extra question should not have to restate answers Core already
 * gives. The name a Variant defaults to is deliberately **not** exported: it is a property of
 * the column, said in the API description, and a constant for it would be a way to write code
 * that depends on which of Core's two it happens to be.
 *
 * `AppliedFulfilment` is on the surface because it sits on `CartLineToPlace`, which is what a
 * replaced `place-order` Step is measured against. `Fulfilment` is what a caller reads off an
 * Order.
 */
export type { Fulfilment } from "./fulfilment/fulfilment.ts";
export type {
  AppliedFulfilment,
  FulfilledVariant,
  FulfilmentAnswers,
  FulfilmentOptions,
  FulfilmentStrategies,
  FulfilmentStrategy,
} from "./fulfilment/strategy.ts";
export { CORE_FULFILMENT_STRATEGIES } from "./fulfilment/strategy.ts";
export type { HealthBody } from "./http/health.ts";
/**
 * The OpenAPI description is on the surface because ADR-0002 makes the API the product:
 * `kobai.openapi()` is how a Project publishes the description of the API *it* serves, and
 * `packages/core/openapi.json` — reachable as `@kobai/core/openapi.json` — is Core's own.
 */
export type { OpenApiDocument } from "./http/openapi.ts";
export { createKobai, type Kobai, type KobaiOptions } from "./kobai.ts";
/**
 * **Media** — the record Core keeps, and the interface that decides where the bytes live.
 *
 * `MediaStorage` is Extension Point 3's third named interface (ADR-0015). A Project writes an
 * object satisfying it and names it as `media: { storage }` in `kobai.config.ts`;
 * `MediaUpload` and `StoredMedia` are what such an object is handed and what it returns, so
 * both have to be nameable, and `MediaOptions` is the shape of the config key.
 *
 * **The value here is the one thing `PaymentProvider` deliberately has no counterpart to.**
 * Core ships `filesystemMediaStorage` and a deployment that configures nothing runs on it, on
 * ADR-0051's argument — recorded on the interface itself. It is exported because a Project may
 * want to name its own directory, and because a Project wiring a bucket in production and
 * files in development writes exactly that ternary in the one file that shows it.
 * `MEDIA_PATH` and `DEFAULT_MEDIA_DIRECTORY` are the two facts that storage's answers are
 * built from, on the surface so that a Project mounting kobai behind something can say where
 * its own media route ends up.
 *
 * `Media` is what a caller reads back off the API. `ImageDimensions` is not here and neither is
 * `imageDimensions`: reading a header is Core's own business and a Project that wants an image
 * measured has the answer on the record already.
 */
export type { Media } from "./media/media.ts";
export type {
  FilesystemMediaStorageOptions,
  MediaOptions,
  MediaStorage,
  MediaUpload,
  StoredMedia,
} from "./media/storage.ts";
export {
  DEFAULT_MEDIA_DIRECTORY,
  filesystemMediaStorage,
  MEDIA_PATH,
} from "./media/storage.ts";
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
  PaidOrder,
  PlaceOrderRefusal,
  PlaceOrderRequest,
  PlaceOrderWorkflow,
  PricedLine,
  PricedLines,
  ReservedLines,
  TakenPayment,
  TaxedAdjustment,
  TaxedLine,
  TaxedLines,
} from "./order/place-order.ts";
export {
  applyAdjustments,
  calculateTax,
  captureOrder,
  holdReservations,
  loadCart,
  placeOrderWorkflow,
  priceLines,
  takePayment,
} from "./order/place-order.ts";
/**
 * **Quoting a Cart is deliberately absent from this surface** (ADR-0077).
 *
 * `POST /store/carts/{id}/quote` is a route, and a Project asks it the way a storefront does —
 * `kobai.request(…)` in a Project's own route, or `@kobai/client` from anywhere else — so what
 * it needs to name the answer with is the *wire* shape, which `@kobai/client` already carries as
 * `Quote`. `quote-cart.ts`'s own types are Core's internals: `quotedAt` is a `Date` there and an
 * ISO string on the wire, and a name here would put that difference under ADR-0019's promise
 * forever in exchange for nothing. Nothing a Project supplies is measured against them either —
 * a replaced pricing Step is measured against `PricedLines` and the rest, above, and the quote
 * runs whatever that produced. `CartHold` is absent for the same reason.
 */
export type {
  Order,
  OrderAdjustment,
  OrderLevelAdjustment,
  OrderLineItem,
  OrderShopper,
  Payment,
} from "./order/read.ts";
/**
 * The interface Core defines and implements nowhere (ADR-0053) — Extension Point 3's second, and
 * the first whose only implementations come from outside kobai.
 *
 * Types alone: a Project writes an object satisfying `PaymentProvider` and names it in
 * `kobai.config.ts`, so there is nothing here to call and nothing to extend. `PaymentsOptions` is
 * the shape of that key.
 */
export type {
  PaymentOutcome,
  PaymentProvider,
  PaymentRequest,
  PaymentsOptions,
  RefundRequest,
} from "./payment/provider.ts";
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
/**
 * A Reservation as the Workflow carries one, and what a Project may say about how long one
 * stands.
 *
 * `HeldReservation` sits on `ReservedLines`, which is the type a replaced `take-payment` or
 * `capture-order` is measured against, so it has to be nameable. `ReservationsOptions` is the
 * shape of the `reservations` key in `kobai.config.ts` (ADR-0075).
 *
 * The provider interface behind them is deliberately **not** here: ADR-0018 promises one
 * interface with two providers and both are Core's own — Inventory today, Capacity later — so
 * exporting it would promise a shape nothing lets a Project supply. The day a deployment may
 * bring its own kind of scarcity is a decision with a config key and an ADR behind it, and this
 * is where it would show up. That day is not this one: `reservations` says how long a claim
 * lasts, not who may make one.
 */
export type {
  HeldReservation,
  ReservationsOptions,
} from "./reservation/reservation.ts";
export type { Channel } from "./store/channel.ts";
export type { EnabledCurrency } from "./store/currency.ts";
export type { Store } from "./store/read.ts";
export type { Region } from "./store/region.ts";
/**
 * What a boot's Region seeding did (`store/seed.ts`, #291).
 *
 * On the surface for {@link InitialMerchantSeed}'s reason: a Project calls
 * `kobai.seedDefaultRegion()` itself, after its migrations, and decides what each outcome means
 * for its own boot.
 */
export type { DefaultRegionSeed, SeededRegion } from "./store/seed.ts";
/**
 * The background sweep (`sweep.ts`): what a Project starts at boot, and what one run of it did.
 *
 * On the surface because a Project calls `kobai.startSweeper()` itself — deliberately, after its
 * migrations — and because a deployment that would rather sweep on a schedule of its own calls
 * `kobai.sweep()` from wherever that schedule lives.
 */
export type { SweeperOptions, SweepOutcome } from "./sweep.ts";
export type {
  OpenMetadataResult,
  WorkflowContext,
  WorkflowRegistry,
} from "./workflow/context.ts";
/**
 * How the open half of a Workflow's context is read off a request (ADR-0013, #121).
 *
 * Two of them because a route that takes a body has two halves to read and a refusal to make,
 * and a route that takes none has neither. On the surface because a Project that serves a
 * Workflow of its own from a route of its own fills a context the way Core's routes do.
 */
export { openMetadata, openMetadataWithBody } from "./workflow/context.ts";
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
 * for a Project that assembles one outside `kobai.config.ts`. `StepOrigin` is here because
 * `WorkflowStep` carries one (ADR-0080) and a name a public type refers to should be one a
 * Project can spell. The builder's own types, the
 * shape map behind those helpers, `STEP_ORIGINS` and `rewireWorkflow` itself stay internal — a
 * Project rewires a Workflow by declaring it in its config, and a second way in would be
 * customisation this repository's one config file could not show.
 */
export type {
  InsertedStep,
  StepDescriptor,
  StepInput,
  StepOrigin,
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
