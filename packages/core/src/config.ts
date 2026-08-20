import type { SessionOptions } from "./auth/session.ts";
import type { FulfilmentOptions } from "./fulfilment/strategy.ts";
import type { MediaOptions } from "./media/storage.ts";
import type { MigrationSet } from "./migrations/set.ts";
import type { placeOrderWorkflow } from "./order/place-order.ts";
import type { PaymentsOptions } from "./payment/provider.ts";
import type { priceResolutionWorkflow } from "./pricing/resolve-price.ts";
import type { ReservationsOptions } from "./reservation/reservation.ts";
import type { WorkflowOverrides } from "./workflow/workflow.ts";

/**
 * The single place a Project declares what it has customised — `kobai.config.ts` in the
 * Project's repository (ADR-0025). Everything a Developer has changed is visible here, in
 * one file, rather than spread across the Project.
 *
 * Nothing takes effect by being installed. A Plugin *offers* capabilities; the Project
 * wires them here, deliberately, so load order never silently decides behaviour (ADR-0017).
 */
export type KobaiProjectConfig = {
  /**
   * Migration sets contributed by the Plugins this Project has wired. Core's own set always
   * runs and is not listed here — it is not the Project's to opt out of.
   */
  readonly migrationSets?: readonly MigrationSet[];
  /**
   * What this Project has changed about Core's Workflows — ADR-0003's flagship, and the
   * reason this file exists at all.
   *
   * ```ts
   * workflows: { "resolve-price": { steps: { "select-price": myStep } } }
   * ```
   *
   * Keyed by Workflow and then by slot, so a Developer reading it sees which Workflow they
   * altered and where, and two Workflows are free to name a slot the same thing. A Step
   * supplied here must satisfy the types of the slot it fills; one that does not is a compile
   * error, which is what makes swapping a Step safe rather than merely possible (ADR-0017).
   *
   * Note what is *not* here: nothing a Plugin can reach. A Plugin offers Steps and a Project
   * wires them, in this file, deliberately — so load order never silently decides behaviour.
   */
  readonly workflows?: CoreWorkflowOverrides;
  /**
   * What this Project has changed about how long a signed-in Merchant stays signed in.
   *
   * ```ts
   * session: { idleWindowMs: 45 * 60 * 1000 }
   * ```
   *
   * **A subject, not a scalar.** Every key in this file names something a Project customised
   * — its migration sets, its Workflows — and reads as a heading with the details beneath it.
   * A bare `sessionIdleWindowMs` at the top level would be the first key that is a number
   * instead, and it would spell that grouping into its own name; the next thing a deployment
   * needs to say about its sessions would then either add a second top-level key or force
   * this shape after the fact, and a config file whose shape has to be reorganised is one
   * every Project has to rewrite.
   *
   * Note what is deliberately *not* here: the twelve-hour absolute cap. It is Core's ceiling
   * rather than a Project's setting, because an idle window protects a deployment against an
   * abandoned browser and nothing against a stolen token — the thief's own traffic is what
   * keeps that one alive, and the cap is the only bound left (ADR-0045, ADR-0050).
   *
   * A window Core will not enforce stops the boot, with a message naming this key. Nothing is
   * clamped: a deployment whose sessions quietly last something other than what this file
   * says is worse than one that refuses to start.
   */
  readonly session?: SessionOptions;
  /**
   * How this Project takes money — the Payment Provider it supplies, because Core supplies none
   * (ADR-0053).
   *
   * ```ts
   * payments: { provider: myProvider }
   * ```
   *
   * **A subject, not a scalar**, for `session`'s reason above: a bare `paymentProvider` at the
   * top level would be the first key in this file naming a mechanism rather than a subject, and
   * the next thing a deployment needs to say about its payments would have nowhere to go.
   *
   * Saying nothing here is a working deployment that cannot be bought from yet. It boots, serves
   * its catalog and serves the Admin, and refuses `place-order` alone with
   * `no-payment-provider` — refusing to boot is reserved for a database that cannot be migrated
   * (ADR-0048).
   */
  readonly payments?: PaymentsOptions;
  /**
   * How this Project's Variants are delivered — the Fulfilment Strategies it has wired
   * (ADR-0014, ADR-0052).
   *
   * ```ts
   * fulfilment: { strategies: { "made-to-order": madeToOrderStrategy } }
   * ```
   *
   * A Plugin **offers** a Strategy and this line is what makes it real: until a Variant can
   * name it here, no Variant may point at it and nothing in Core has heard of it. Take the line
   * out and the Plugin is still installed, still importable, and still inert (ADR-0017).
   *
   * Core's own `physical` and `digital` are there whether or not this key is, so a deployment
   * that says nothing has exactly those two — and naming one of them here **replaces** it,
   * which is what substituting a dependency means and is visible in this one file.
   *
   * **A subject, not a scalar**, for `session`'s and `payments`' reason: this is where the next
   * thing a deployment needs to say about how it fulfils goes.
   */
  readonly fulfilment?: FulfilmentOptions;
  /**
   * What this Project has changed about how long a Cart's stock is held while an Order is
   * being placed.
   *
   * ```ts
   * reservations: { holdWindowMs: 30 * 60 * 1000 }
   * ```
   *
   * **A subject, not a scalar**, for `session`'s reason above.
   *
   * Fifteen minutes if this key is absent, which is what every deployment had before this key
   * existed. It is a Project's because a hold now spans a Shopper walking into their banking
   * app, and how long that takes is a fact about a Store's Shoppers and their banks
   * (ADR-0070).
   *
   * Note what is deliberately *not* here: a ceiling. Unlike `session.idleWindowMs`, nothing
   * bounds this from above — a hold is never renewed, so its window already **is** the bound,
   * and what a long one costs is this Store's own stock. The floor is Core's, and it is about
   * kobai working rather than about inventory policy: a window a placement can overrun is one
   * that takes a Shopper's money and then fails to write their Order. A window Core will not
   * enforce stops the boot, with a message naming this key, and nothing is clamped (ADR-0075).
   */
  readonly reservations?: ReservationsOptions;
  /**
   * Where this Project keeps its Media — the images and other catalog assets a Merchant
   * uploads (ADR-0015).
   *
   * ```ts
   * media: { storage: myBucket, maxBytes: 50 * 1024 * 1024, accept: ["image/png"] }
   * ```
   *
   * **A subject, not a scalar**, for `session`'s and `payments`' reason — and this is the key
   * where that paid off in as many words. It shipped holding a storage alone, saying that the
   * next thing a deployment needed to say about its Media would go beside it; a size ceiling
   * and an accepted set of content types are what arrived (#278), and they cost one key each
   * rather than a shape every Project would have had to rewrite.
   *
   * **All three are the Project's, with Core's defaults behind them**, which is ADR-0050's
   * shape. The reason the two new ones are not Core's alone is on `MediaOptions` in
   * `media/storage.ts`: what ceiling is right depends on where the bytes go, and what a Store's
   * catalog assets *are* is the Store's business — a Project selling datasheets accepts PDFs
   * and has not misconfigured anything. Core's own are ten mebibytes and the five raster image
   * types; `image/svg+xml` is deliberately not among them, and that absence is argued where the
   * key is. A value Core will not serve stops the boot, with a message naming the key, and
   * nothing is clamped.
   *
   * **Unlike `payments`, saying nothing here is a fully working Store**, and the reason Core may
   * ship a default at all is recorded on `MediaStorage` in `media/storage.ts`: ADR-0051 closed #72 with two
   * implementations from outside kobai, so Media no longer has to be the proof that dependency
   * substitution works with somebody else's code. A deployment that says nothing writes files
   * under `kobai-media/` and serves them from kobai's own `/media/{key}` — which is local disk,
   * with everything that implies for a second container and for a deploy that keeps no volume.
   *
   * What a storage decides is not only *where* the bytes are but **where a storefront fetches
   * them from**: the address on a Media is the storage's own answer, asked at read time, so a
   * bucket behind a CDN serves its own bytes and none of them pass through this process.
   */
  readonly media?: MediaOptions;
};

/**
 * The Workflows Core declares, and what a Project may override in each.
 *
 * Written out by name rather than derived from a registry: this is the list a Developer is
 * promised stability on, so it should be readable as a list. A new Workflow adds a line here,
 * and that line is the decision to expose it.
 */
export type CoreWorkflowOverrides = {
  readonly "resolve-price"?: WorkflowOverrides<typeof priceResolutionWorkflow>;
  readonly "place-order"?: WorkflowOverrides<typeof placeOrderWorkflow>;
};

/** Identity, for the types. A Project's `kobai.config.ts` calls this. */
export function defineKobaiConfig(config: KobaiProjectConfig): KobaiProjectConfig {
  return config;
}

/**
 * The minimum a logger must do for Core. A Project may pass anything that does it.
 *
 * It goes to `createKobai` beside `databaseUrl` rather than into `kobai.config.ts`, because it
 * is about the running process rather than about what this deployment customised — the one
 * named interface on the promised surface that is not a subject in that file.
 *
 * **Each operation is a property holding a function rather than a method** (#127), which is the
 * spelling every interface kobai asks somebody else to implement uses — `Step.run`,
 * `PaymentProvider.charge`, `FulfilmentStrategy.answersFor`, `ReservationProvider`,
 * `Codemod.apply` — and for the identical reason: TypeScript checks method parameters
 * *bivariantly* and
 * function-property parameters *contravariantly*, so only this spelling makes a logger that
 * demands **more** than Core sends a compile error rather than a runtime surprise. Under the
 * method spelling this compiled:
 *
 * ```ts
 * const logger: Logger = {
 *   info: (message: string, fields: { requestId: string }) => console.log(fields.requestId),
 *   error: () => {},
 * };
 * ```
 *
 * and then Core called `logger.info("listening")` with no second argument, and the Project read
 * `.requestId` off `undefined`. `fields` is optional **and stays optional**: Core sends it when
 * it has something to say and omits it when it does not, so a logger that insists on receiving
 * one is insisting on a thing that was never promised.
 *
 * ## Why the change was takeable at all
 *
 * An interface's shape is under semver forever from the moment it ships (ADR-0019), and this is
 * the oldest of Core's — exported from `@kobai/core` since before there was a spec. What made
 * tightening it a decision rather than a refactor is **ADR-0058**: before the first published
 * release a promised surface may be broken outright, provided the argument is written where the
 * type is — this comment — and a break the Project's own compiler catches is announced by the
 * compiler rather than by a codemod. Nothing has been released, so there is no Project this
 * could have broken; the licence closes at the first publish, and ADR-0058 records this break
 * beside #117's.
 *
 * **Almost nothing was broken even so, and the exceptions are worth naming.** Every logger that
 * accepted what Core actually sends still compiles — a wider `fields`, a narrower parameter
 * list, `console` itself. Two shapes stop compiling, and both were already wrong:
 *
 * - one declaring `fields` **required** rather than optional, which was being handed `undefined`
 *   whenever Core had nothing to add. The fix is one character: `fields?`.
 * - one demanding a **narrower** `fields` than `Record<string, unknown>`, which was reading a key
 *   off `undefined` on every call that sent no fields. That one is a finding about the logger:
 *   Core promises open data and promises nothing about what is in it.
 *
 * The `readonly` on each is not part of that argument and breaks nobody — a method was never
 * reassignable either — but it matches `PaymentProvider` and `FulfilmentStrategy`, and there is
 * no reason for a running deployment to swap out its own logger's `info`.
 */
export type Logger = {
  readonly info: (message: string, fields?: Record<string, unknown>) => void;
  readonly error: (message: string, fields?: Record<string, unknown>) => void;
};

export const consoleLogger: Logger = {
  info: (message, fields) => console.log(format("info", message, fields)),
  error: (message, fields) => console.error(format("error", message, fields)),
};

function format(
  level: string,
  message: string,
  fields: Record<string, unknown> | undefined,
): string {
  return JSON.stringify({ level, message, ...fields, time: new Date().toISOString() });
}
