import type { Logger } from "../config.ts";

/**
 * **Events** — ADR-0003's fourth Extension Point, and the one that had never existed in any
 * form (ADR-0085, #70, #322).
 *
 * Core emits a fact about something kobai did; a Project wires a Subscriber against it by name
 * in `kobai.config.ts`; and that is the whole of the mechanism:
 *
 * ```ts
 * // kobai.config.ts
 * events: { subscribers: { "fulfilment-dispatched": [emailTheShopper] } },
 * ```
 *
 * Everything below is ADR-0085's decision rather than this module's. What is worth having in
 * front of you while reading the code:
 *
 * - **Core emits and nothing else does.** A Plugin does not emit and a Project does not emit, so
 *   the set of Event names is Core's the way the set of Workflow slots is — a name-space two
 *   packages may both write into is a registry whose contents depend on what is installed, which
 *   is the thing this Extension Point exists to be an alternative to.
 * - **A Plugin offers a Subscriber and the Project wires it** (ADR-0017). Installing a package
 *   subscribes to nothing. A Subscriber returns nothing and decides nothing, so one that
 *   registered itself at load time would be running code in a deployment with no compile-time
 *   trace of it at all.
 * - **An Event is emitted after the transaction that made the fact has committed, and never
 *   from inside a Workflow Step.** That is what makes *a Subscriber cannot undo what emitted*
 *   structurally true rather than a `try`/`catch` promise: at the moment a Subscriber runs there
 *   is nothing left to undo. The `try`/`catch` in {@link createEventEmitter} is still there —
 *   a throw must not become a 500 on a route that succeeded — but it is not what the guarantee
 *   rests on.
 * - **A Subscriber cannot refuse.** `StepFailure` has no meaning here and Core does not look for
 *   one. Anything a Subscriber throws is a bug: caught, logged through the deployment's
 *   `Logger`, and changing nothing about the answer the caller gets.
 * - **Sequential, awaited, in wired order, and every one is called** — including the ones after
 *   a Subscriber that threw, because the failure that matters is not one integration being
 *   broken but one broken integration silencing the three wired after it. Core attempts each
 *   exactly once and there is **no retry**.
 * - **Delivery is in-process and events are not durable.** Nothing is written to Postgres, and
 *   an Event whose process dies between the commit and the call is lost. What is given up is
 *   *at most once, and no proof of delivery*: kobai's events are not webhooks, and a Subscriber
 *   is a place to **react** rather than a place to put work that must happen. The fact is
 *   durable even when the Event is not — a dispatched Fulfilment is a committed row — so a
 *   Subscriber whose work must never be skipped is written against the row, and a deployment
 *   wanting durable delivery wires one that enqueues into a queue it already runs.
 *
 * ## What a payload promises, and which way its type runs
 *
 * A payload is **plain JSON data, produced by Core and read by a Subscriber** — strings,
 * numbers, booleans, `null`, and nested objects of those. No `Date`, no entity object, no
 * handle; timestamps are ISO 8601 strings. The direction is the property to preserve
 * (ADR-0019), and it is `FulfilledVariant`'s in `fulfilment/strategy.ts`: Core may **add** a
 * field and every
 * Subscriber written against today's shape still compiles. What may never happen without a
 * major is removing a field, renaming one, widening a `string` to `string | null`, or keeping a
 * field's name and changing what it means.
 *
 * **A payload carries the identity of what happened and the facts of the transition, and
 * nothing else** — never a copy of the record it concerns. Two reasons: a copied field is a
 * second promise about data the HTTP surface already promises (ADR-0060), and a payload is read
 * at an unknown later moment, where a copy of a record is stale by construction and an
 * identifier is not.
 *
 * **A Subscriber must be idempotent.** In-process delivery is at most once; a durable one would
 * be at least once, and saying so from the first day is what stops the delivery guarantee
 * tightening into a semver break.
 */

/**
 * A Fulfilment has been dispatched — the first Event, and the only one today (ADR-0085).
 *
 * Emitted by `POST /admin/orders/{id}/fulfilments/{fulfilmentId}/dispatch` once the transition
 * has committed. Delivered and cancelled get Events on the same terms when something wants them;
 * they are not added speculatively, because an Event nobody subscribes to is a promise with no
 * consumer.
 *
 * Nothing about the Fulfilment beyond the transition is here: not its Strategy, not
 * `requiresShipping`, not its lines. Those are on a row the Subscriber can read back through
 * `GET /admin/orders/{orderId}`, which is what {@link FulfilmentDispatched.orderId} is for.
 */
export type FulfilmentDispatched = {
  /** Which Fulfilment moved. */
  readonly fulfilmentId: string;
  /**
   * The Order it is part of.
   *
   * Here rather than looked up because a Fulfilment is read **through** its Order (#320):
   * without it a Subscriber holds the identity of something it has no route to read.
   */
  readonly orderId: string;
  /**
   * The opaque string the Merchant recorded at dispatch, exactly as recorded, or `null` where
   * the transition recorded none.
   *
   * kobai parses nothing out of it and models no carrier. A download has nothing to track,
   * which is why this is nullable rather than required.
   */
  readonly trackingReference: string | null;
  /**
   * When the transition was committed, ISO 8601.
   *
   * Every payload carries one, because a Subscriber may run late and *now* is not when it
   * happened. It is a reading of the row's own `updated_at` — the value Postgres wrote — rather
   * than a clock consulted afterwards.
   */
  readonly occurredAt: string;
};

/**
 * Every Event kobai emits, by the name a Project wires against.
 *
 * **Names are kebab-case and flat** — subject then what happened — because kobai already names
 * Workflows, Steps and refusal `reason`s that way, and a dotted `fulfilment.dispatched` would
 * invent a hierarchy the registry does not have.
 *
 * A new Event is **additive**: with no wildcard to subscribe to everything, nothing starts
 * receiving an Event added in a minor without a line being written for it.
 *
 * **`fulfilment-dispatched` is spelled the same as a refusal `reason`, and they are opposite
 * facts.** `FULFILMENT_REFUSALS.dispatched` in `fulfilment/lifecycle.ts` is the word a Merchant
 * is refused a move *with*, meaning **this one has already gone**; this is the announcement that
 * one just did. Both are named by ADR-0060's and ADR-0085's own rule — subject then state — and
 * both are promised for ever, so neither may be renamed to relieve the collision. They never
 * meet: one is a string in a refusal body a client branches on, the other a key in a config file
 * a Developer writes, and nothing reads a value of one where the other is expected. It is
 * written down here because reading them side by side is otherwise confusing.
 */
export type KobaiEvents = {
  readonly "fulfilment-dispatched": FulfilmentDispatched;
};

/** The name of an Event kobai emits. Core's set, closed, and there is no wildcard. */
export type EventName = keyof KobaiEvents;

/**
 * What runs when an Event is emitted — a Plugin **offers** one and a Project **wires** it.
 *
 * ```ts
 * const emailTheShopper: Subscriber<"fulfilment-dispatched"> = async (dispatched) => {
 *   await mailer.send(dispatched.orderId, dispatched.trackingReference);
 * };
 * ```
 *
 * **A property-style function type rather than a method signature**, which is the spelling every
 * interface kobai asks somebody else to implement uses — `Step.run`, `PaymentProvider.charge`,
 * `FulfilmentStrategy.answersFor` — and for the identical reason: TypeScript checks a function
 * type's parameters *contravariantly* under `strictFunctionTypes`, so a Subscriber that demands
 * **more** than Core sends is a compile error rather than an `undefined` at run time.
 *
 * **It is handed the payload and nothing else** — no transaction, no database handle, no
 * Workflow context. The two things it might plausibly want, a logger and the deployment's own
 * configuration, are things the Project is holding at the moment it wires, so a closure has
 * them; a Plugin that needs configuring exports a factory, the way `stripePayments` already
 * does. The one thing a context could usefully contain — the transaction — is precisely the
 * thing that would let a Subscriber undo what emitted.
 *
 * **Its return value is never read**, so a durable path need not invent a meaning for something
 * it was handed. It may be `async`, and Core awaits it before answering the request.
 */
export type Subscriber<E extends EventName> = (
  payload: KobaiEvents[E],
) => void | Promise<void>;

/**
 * The Subscribers a deployment has wired, by Event name — a list per Event, run in the order it
 * was written.
 *
 * A list because a deployment may want two things to happen and because sequential order is a
 * decision a Project takes by writing them down. **There is no wildcard key**: a Subscriber
 * names one Event, and nothing may ask for all of them.
 */
export type EventSubscribers = {
  readonly [E in EventName]?: readonly Subscriber<E>[];
};

/**
 * What a Project says about events in `kobai.config.ts` — a subject, not a bare map (ADR-0050).
 *
 * ```ts
 * events: { subscribers: { "fulfilment-dispatched": [emailTheShopper] } },
 * ```
 *
 * Nested so that the day kobai has something else to say about events — durable delivery is the
 * obvious candidate — it is a key beside `subscribers` rather than a reshape of every Project's
 * config file.
 */
export type EventsOptions = {
  /** The Subscribers this deployment wires, by the Event each one is listening for. */
  readonly subscribers?: EventSubscribers;
};

/**
 * What Core emits through — one function, held by the instance and reached by the routes that
 * have something to announce.
 *
 * A named type rather than a bare function so that a route's dependencies read as *what this
 * deployment emits through*, and so that the thing a Project wired and the thing Core calls are
 * two names for one object built once at boot.
 */
export type EventEmitter = {
  /**
   * Announces that this happened, to whatever this deployment wired for it.
   *
   * **Call it after the transaction that made the fact has committed, and never from inside a
   * Workflow Step.** A Step that emitted would be the one piece of work in an unwindable region
   * with no compensation available (ADR-0036), because an Event already delivered cannot be
   * recalled — a confirmation email for an Order that was then unwound.
   *
   * It resolves once every wired Subscriber has been attempted, and it never rejects.
   */
  readonly emit: <E extends EventName>(
    event: E,
    payload: KobaiEvents[E],
  ) => Promise<void>;
};

/**
 * The emitter one deployment runs — the Subscribers its `kobai.config.ts` wired, and the
 * `Logger` a broken one is reported through.
 *
 * Built once at boot beside the Workflow registry and the Fulfilment Strategies, for their
 * reason: a second answer to *what does this deployment subscribe to* is how a Subscriber runs
 * in one module and not in another.
 *
 * A deployment that wired none gets an emitter that has nothing to call, which is the whole of
 * what *installing a package subscribes to nothing* means at run time.
 */
export function createEventEmitter(
  logger: Logger,
  options?: EventsOptions,
): EventEmitter {
  const subscribers = options?.subscribers ?? {};

  return {
    async emit(event, payload) {
      // Sequential and awaited rather than concurrent: a Project that wrote two in an order
      // chose that order, and `Promise.all` rejects on the first throw — which is the behaviour
      // ADR-0085 refuses. Firing without awaiting was refused too: a floating promise cannot be
      // observed by a test, and an unhandled rejection ends a Node process.
      const wired = subscribers[event] ?? [];
      for (const [position, subscriber] of wired.entries()) {
        try {
          await subscriber(payload);
        } catch (cause) {
          // Reported in the log and nowhere else. The response body a Merchant's Admin or a
          // storefront parses should not grow a field about whether somebody's email
          // integration is working — ADR-0036's reasoning about `uncompensated`, applied to a
          // smaller fact — and the next Subscriber is called regardless, because one broken
          // integration silencing the three wired after it is the failure that matters.
          //
          // **`position` is which one of them broke**, counted from the top of the list in
          // `kobai.config.ts`. A Subscriber has no name of its own — it is a function, and one
          // wired from a Plugin may be anonymous — so where the Project wrote it is the only
          // handle that exists, and without it a deployment with three wired against one Event
          // is told that one of them failed and nothing about which.
          reportQuietly(logger, {
            event,
            position,
            of: wired.length,
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    },
  };
}

/**
 * Says a Subscriber failed, and cannot itself fail.
 *
 * **A `Logger` is a Project's** (ADR-0003's third Extension Point), so `logger.error` is
 * somebody else's code and may throw — and if it did, a throw from the one place that exists to
 * contain a throw would travel out of `emit`, become a 500 on a route that had already
 * succeeded, and undo the guarantee in exactly the case it was written for. So the report is
 * attempted and the failure of the report is dropped.
 *
 * **Dropped rather than re-reported**, because the only thing left to report it through is the
 * `Logger` that just threw. A deployment whose logger throws has a bug it will find at the first
 * line kobai logs anywhere; what it must not also have is a dispatch that answers 500.
 */
function reportQuietly(logger: Logger, fields: Record<string, unknown>): void {
  try {
    logger.error("a subscriber failed", fields);
  } catch {
    // Deliberately nothing. See above.
  }
}
