/**
 * **`FulfilmentStrategy`** — the named interface a Variant points at (ADR-0014, ADR-0052).
 *
 * It is the **fourth** interface Core has named and the **third** a Project may supply: `Logger`,
 * `PaymentProvider` and this one are wired in a Project's own file, while `ReservationProvider`
 * is Core's own — ADR-0018 promises one interface with two providers and both of them are
 * Core's, so nothing exports it and nothing lets a deployment bring a kind of scarcity.
 *
 * A Variant carries the *name* of a Strategy and nothing else about how it is delivered. Core
 * asks the Strategy the three questions ADR-0014 lists — does this ship, does it consume stock,
 * does it have a Lead Time — and asks them of the Variant, rather than reading a flag off it.
 * That is the whole decision, and the reason for it is in ADR-0014: `requires_shipping` and
 * `tracks_inventory` as columns would be a **closed set**, and a closed set is what forces a Core
 * change the first time somebody sells a rental, a service or a subscription — the failure
 * ADR-0003 exists to prevent.
 *
 * **It is not a sixth Extension Point** (ADR-0052). It is number three, dependency substitution
 * behind a named interface, reached through number one, configuration:
 *
 * ```ts
 * // kobai.config.ts
 * export default defineKobaiConfig({
 *   fulfilment: { strategies: { "made-to-order": madeToOrderStrategy } },
 * });
 * ```
 *
 * A Plugin **offers** a Strategy and the Project **wires** it. Installing the Plugin does
 * nothing at all: the object is importable, and until a line of `kobai.config.ts` names it, no
 * Variant may point at it and nothing in Core has heard of it (ADR-0017). Core ships
 * {@link CORE_FULFILMENT_STRATEGIES} — `physical` and `digital` — and a deployment that says
 * nothing has exactly those two.
 *
 * ## The shape, and why it is this one
 *
 * ADR-0019 puts an interface's shape under semver **forever** once shipped, and #72 asked for a
 * deliberate look at `Logger`'s before more interfaces copied it. Three of them now exist to
 * compare against — `Logger`, `PaymentProvider`, `ReservationProvider` — so what was kept from
 * each and what was changed is written down here rather than inferred later. #110 is where the
 * comparison belongs as documentation; this is the record it is owed.
 *
 * **Kept from all three.** A plain object type, wired through `kobai.config.ts` and substituted
 * whole. No class to extend, no base to inherit, no `init` and no `close` — Core never constructs
 * a Strategy and never disposes of one, so a lifecycle would be a contract about something Core
 * does not manage. Anything that answers the questions is acceptable, which is what makes a
 * Plugin's Strategy a five-line object.
 *
 * **Kept from `PaymentProvider`, and not from `Logger` or `ReservationProvider`: the operation is
 * a property holding a function rather than a method.** TypeScript checks method parameters
 * *bivariantly* and function-property parameters *contravariantly*, so only this spelling makes a
 * Strategy that demands **more** than Core sends a compile error instead of a `undefined` at
 * runtime. The mistake it catches is a plausible one here — `answersFor: (variant:
 * FulfilledVariant & { leadTimeDays: number }) => …`, from a made-to-order Strategy that wants a
 * number Core does not model — and the honest answer to it is that such a number arrives through
 * {@link FulfilledVariant.metadata}, which is ADR-0013's open door and needs no change to Core.
 * `Logger` and `ReservationProvider` are both spelled with methods and are the older shape; that
 * is a finding about them rather than a precedent to follow, and #110 is where it is recorded.
 *
 * **Changed from all three: there is no `name` on the Strategy.** `Logger` needs none,
 * `PaymentProvider` carries one because a Payment records which system holds the money, and
 * `ReservationProvider` carries one because a Reservation row names the provider that must give
 * the units back. A Strategy is named by the **key it is wired under**, exactly as a replaced
 * Workflow Step is named by its slot — so the name a Variant points at is visible in
 * `kobai.config.ts` rather than buried in a Plugin's source, and two Plugins that both call
 * theirs `rental` can be wired side by side. A `name` inside as well would be a second answer to
 * what this Strategy is called, and the two could disagree.
 *
 * **One function, not three.** The three questions are always wanted together — Capture
 * snapshots all of them onto the Fulfilment it writes — so asking once means one call site, one
 * answer per Variant, and no way for a Strategy to answer a question one way here and another
 * way there. It also makes the fourth question, if one is ever needed, an optional field of
 * {@link FulfilmentAnswers} rather than a fourth member of this type.
 *
 * ## What may change later, and what may not
 *
 * The direction of each type is what keeps the extension additive, and it is the property to
 * preserve if either is ever changed (ADR-0019). {@link FulfilledVariant} is **produced by Core
 * and read by a Strategy**, so Core may add a field to it and every Strategy written against
 * today's shape still compiles. {@link FulfilmentAnswers} runs the other way — produced by a
 * Strategy, read by Core — so a fourth answer may only ever arrive as an **optional** field with
 * a documented default, the way `PaymentOutcome.received` did.
 */

/**
 * The Variant a Strategy is being asked about.
 *
 * Deliberately not the whole row and deliberately not a Product: a Strategy decides how a
 * sellable thing is delivered, and a title, a Price or a stock count would let it decide
 * something else. `metadata` is ADR-0013's open door — a made-to-order Strategy reading its own
 * key out of it is reading data Core has never modelled, which is exactly what the door is for,
 * and Core reads no key out of it either.
 */
export type FulfilledVariant = {
  readonly id: string;
  readonly sku: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};

/**
 * What a Strategy answers — ADR-0014's three questions, and only those.
 *
 * Each is a fact about *this* Variant rather than about the Strategy, which is why they arrive
 * from a call rather than as constants: a Strategy that answers the same thing for everything it
 * is pointed at is free to ignore its argument, and one that does not is not forced into a second
 * Strategy to say so.
 */
export type FulfilmentAnswers = {
  /**
   * Does this go anywhere physical?
   *
   * Nothing in Core reads it yet — shipping is its own spec — and it is snapshotted onto every
   * Fulfilment from the first Order, for ADR-0009's reason: a record that gained the field later
   * would change what every Order written before it means, and there would be no honest value to
   * backfill.
   */
  readonly requiresShipping: boolean;
  /**
   * Does selling one take something off a shelf?
   *
   * The load-bearing one today: `hold-reservations` claims Inventory for a line whose Strategy
   * says yes and **skips it entirely** for one that says no, rather than claiming zero. So a
   * digital Variant needs no Inventory row to be sellable, and one that has a row anyway — a
   * Merchant counted it once, or it used to be a poster — still sells freely, because the
   * Strategy is the answer and the row is only how many.
   */
  readonly tracksInventory: boolean;
  /**
   * Is there an interval between Capture and delivery this Store has to plan for?
   *
   * `true` is made-to-order's answer. Core has no calendar and will not have one — Capacity is
   * its own spec (ADR-0012) — so this says only *that* there is a Lead Time; how long, and what
   * it costs, belong to the Plugin that knows, and reach an Order as an Adjustment through a
   * replaced Step (ADR-0022, ADR-0013).
   */
  readonly hasLeadTime: boolean;
};

/**
 * A Fulfilment Strategy: one question, asked of one Variant.
 *
 * ```ts
 * export const madeToOrder: FulfilmentStrategy = {
 *   answersFor: () => ({
 *     requiresShipping: true,
 *     tracksInventory: false,
 *     hasLeadTime: true,
 *   }),
 * };
 * ```
 */
export type FulfilmentStrategy = {
  /**
   * How this Variant is delivered — the three questions, answered together.
   *
   * A **property holding a function** rather than a method, so that a Strategy demanding more
   * than Core sends does not compile. See this module's own documentation for why that spelling
   * is the one under semver.
   *
   * It is synchronous on purpose. Core asks once per line at the front of `place-order` and once
   * per Variant when a Merchant reads a Product, so a Strategy that had to make a network call to
   * answer would put somebody else's service in front of the catalog. What a Strategy needs is on
   * the Variant it was handed, including the open half of it.
   */
  readonly answersFor: (variant: FulfilledVariant) => FulfilmentAnswers;
};

/** The Strategies a deployment has, by the name a Variant points at. */
export type FulfilmentStrategies = Readonly<Record<string, FulfilmentStrategy>>;

/**
 * A Strategy's answers about one Variant, with the name it was answered under.
 *
 * **Asked once and carried**, rather than asked again wherever it is wanted. `place-order`
 * resolves this for every line as it loads the Cart, and the same value then decides whether
 * stock is claimed and becomes the Fulfilment's snapshot at Capture — so a Strategy that
 * answered one way at the front of a placement cannot have answered another way at the end of
 * it, whatever it reads or however it is rewired mid-flight.
 */
export type AppliedFulfilment = FulfilmentAnswers & {
  /** The name this deployment wired the Strategy under. */
  readonly strategy: string;
};

/**
 * What a Project says about fulfilment in `kobai.config.ts` — a subject, not a scalar (ADR-0050).
 *
 * Nested so that the next thing a deployment needs to say about how it fulfils goes beside the
 * Strategies rather than forcing this shape after the fact, which is the same reason `payments`
 * is a key holding a provider and `session` a key holding a window.
 */
export type FulfilmentOptions = {
  /**
   * The Strategies this deployment adds, keyed by the name its Variants point at.
   *
   * Merged over Core's two, so `physical` and `digital` are there whether or not this key is —
   * and a Project that names one of them here **replaces** it, which is what substituting a
   * dependency means and is visible in the one file that exists to show it.
   */
  readonly strategies?: FulfilmentStrategies;
};

/**
 * Core's own two, and the whole of what Core knows how to sell (ADR-0014).
 *
 * Two rather than an enum of everything a Store might ever sell: the open set is the point, and
 * these are the two whose answers Core can state truthfully without knowing anything about the
 * Store. Everything else — rentals, services, subscriptions, made-to-order — is a Plugin's, and
 * needs no change here to arrive.
 */
export const CORE_FULFILMENT_STRATEGIES: FulfilmentStrategies = {
  /** A thing on a shelf: it ships, it comes off the count, and it is ready now. */
  physical: {
    answersFor: () => ({
      requiresShipping: true,
      tracksInventory: true,
      hasLeadTime: false,
    }),
  },
  /**
   * A thing that is sent rather than shipped: a download, a licence, a PDF.
   *
   * Nothing about it is scarce, which is why it needs no Inventory row to be sellable — and a
   * Store selling only these never holds a Reservation at all.
   */
  digital: {
    answersFor: () => ({
      requiresShipping: false,
      tracksInventory: false,
      hasLeadTime: false,
    }),
  },
};

/** The name a Variant points at when nobody says otherwise, and the column's default. */
export const DEFAULT_FULFILMENT_STRATEGY = "physical";

/**
 * The Strategies one deployment runs: Core's, with whatever the Project wired over them.
 *
 * Built once at boot and handed to whatever needs to ask, exactly as the Workflow registry is —
 * so "which Strategies does this deployment have" has one answer, and a Project that replaced
 * `physical` replaced it everywhere rather than in whichever module happened to import Core's.
 */
export function resolveFulfilmentStrategies(
  options?: FulfilmentOptions,
): FulfilmentStrategies {
  return { ...CORE_FULFILMENT_STRATEGIES, ...options?.strategies };
}

/**
 * The Strategy this deployment wired under that name, or `undefined` — **the one lookup**.
 *
 * `Object.hasOwn` rather than `in` or a bare index, and that is the whole reason this is a
 * function. The Strategies are an object keyed by a name that arrives from a request, and every
 * object answers to `toString`, `constructor` and `valueOf` — so `in` says a Variant may be
 * fulfilled by `toString`, and indexing then hands back a function rather than a Strategy. The
 * failure is a 500 at the first Order for that Variant, a long way from the request that created
 * it. Two spellings of "does this deployment have that Strategy" is how the two halves come to
 * disagree, so there is one.
 */
export function fulfilmentStrategyFor(
  strategies: FulfilmentStrategies,
  strategy: string,
): FulfilmentStrategy | undefined {
  return Object.hasOwn(strategies, strategy) ? strategies[strategy] : undefined;
}

/**
 * What a Strategy says about a Variant, or `undefined` when this deployment has no such Strategy.
 *
 * Absent is a real answer rather than an error to raise here, because the two callers do
 * different things about it: creating a Variant refuses, and placing an Order refuses with a
 * reason of its own. A deployment reaches the second only by unwiring a Strategy its Variants
 * already point at, which is a configuration change rather than a request anybody made.
 */
export function fulfilmentAnswersFor(
  strategies: FulfilmentStrategies,
  strategy: string,
  variant: FulfilledVariant,
): FulfilmentAnswers | undefined {
  return fulfilmentStrategyFor(strategies, strategy)?.answersFor(variant);
}

/** The names this deployment has, in a fixed order, for a message that has to list them. */
export function fulfilmentStrategyNames(strategies: FulfilmentStrategies): string[] {
  return Object.keys(strategies).sort();
}
