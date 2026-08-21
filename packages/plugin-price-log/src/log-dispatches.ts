import type { FulfilmentDispatched, Subscriber } from "@kobai/core";

/**
 * The Subscriber this Plugin **offers** — and offering is the whole of what it does, exactly as
 * it is for the Step beside it (ADR-0017, ADR-0085, #323).
 *
 * Importing this module subscribes to nothing. A Project that wants dispatches logged says so in
 * its `kobai.config.ts`, beside every other thing it has customised:
 *
 * ```ts
 * const dispatches = dispatchLog();
 *
 * export default defineKobaiConfig({
 *   events: { subscribers: { "fulfilment-dispatched": [dispatches.logTheDispatch] } },
 * });
 * ```
 *
 * **This is the sharper half of ADR-0017's rule, and that is why it is worth a Plugin proving
 * it.** A Step at least has to satisfy the slot's input and output, so a Plugin that installed
 * one by being installed would still be constrained by the compiler. A Subscriber returns
 * nothing and decides nothing, so one that registered itself at load time would be running code
 * in a deployment with no compile-time trace of it at all — and the symptom, when eleven Plugins
 * are installed and an upgrade starts sending two confirmation emails, is a behaviour with no
 * file to open. So there is no `register` here, no side effect at import, and no way for this
 * module to reach Core: there is a value, and a Project names it or does not.
 *
 * ## Why this keeps its log in memory rather than in the table beside it
 *
 * `recordPriceResolution` writes a row, because a Step is handed a Workflow context with
 * `context.db` on it. **A Subscriber is handed the payload and nothing else** (ADR-0085) — no
 * transaction, no database handle, no context — which is precisely what makes it unable to undo
 * what it heard about. The two halves of this Plugin sitting side by side is the clearest way to
 * see that difference: what a Step may do is bounded by the context Core hands it, and what a
 * Subscriber may do is bounded by what the **Project** handed it at the moment it wired.
 *
 * Which is why {@link dispatchLog} is a factory rather than a bare function. A Plugin that needs
 * anything of the deployment's exports one — the way `stripePayments` takes its secret key — and
 * what this one needs is somewhere to put what it hears. A module-level book would be shared
 * state no Project asked for and no test could isolate.
 *
 * **A Subscriber is a place to react, not a place to put work that must happen.** Delivery is
 * in-process and at most once, so this log is what a deployment can read back in the process that
 * heard it and nothing more; a Plugin whose work must never be skipped is written against the row
 * kobai committed, which is what `orderId` is for. It is in memory and **bounded** — see
 * {@link DISPATCHES_KEPT} — because nothing drains it, and this file is one every Project that
 * installs the package receives.
 */

/** One dispatch this log has heard about, as the payload described it. */
export type DispatchLogEntry = {
  /** What moved. This log is keyed by it — see {@link dispatchLog}. */
  readonly fulfilmentId: string;
  /** The Order that Fulfilment is part of, which is what {@link DispatchLog.entriesFor} asks by. */
  readonly orderId: string;
  /** Kept as kobai handed it over, `null` and all. This Plugin parses no more out of it than Core does. */
  readonly trackingReference: string | null;
  /**
   * The payload's own `occurredAt`, kept verbatim as the ISO 8601 string it is.
   *
   * Deliberately not the moment this ran, and not a clock reading of any kind: a Subscriber may
   * run late, so a log that stamped its own time would be recording when this process heard
   * about the parcel rather than when the parcel left.
   */
  readonly occurredAt: string;
};

/**
 * A log of dispatches, and the Subscriber that fills it.
 *
 * **It keeps books, and asking them is the point** — the same judgement the Step beside it
 * invites by writing a row, and the rule kobai's tests hold everywhere: *the callback ran* and
 * *this log knows the parcel left, with this reference, at this moment* are two different facts,
 * and a counter only ever knows the first.
 */
export type DispatchLog = {
  /**
   * What a Project wires against `fulfilment-dispatched`.
   *
   * A property holding a function rather than a method, so that a mistake about what kobai sends
   * is a compile error where it is wired rather than an `undefined` at run time — the spelling
   * every interface kobai asks somebody else to implement uses, and for the same reason.
   */
  readonly logTheDispatch: Subscriber<"fulfilment-dispatched">;
  /**
   * What this log holds for one Order, oldest first.
   *
   * By Order rather than *everything heard*, because one process serves many and an unqualified
   * read would be a question with no stable answer.
   */
  readonly entriesFor: (orderId: string) => readonly DispatchLogEntry[];
};

/**
 * How many dispatches a log keeps before the oldest falls off it.
 *
 * **It is bounded on purpose, and a Plugin has a stronger reason to bound one than a Project
 * does.** Nothing here drains the log, so an unbounded one grows by an entry per dispatch for as
 * long as the process runs — and this code arrives in every Project that installs the package,
 * which makes it a leak a Developer would have inherited rather than written. A Project's own
 * outbox at least sits in a file its author opened.
 *
 * The moment a Project gives this something that drains — a table, a queue, a job — it is
 * writing its own Subscriber rather than wiring this one, and the bound is not its problem.
 *
 * Large enough that nothing anybody would look at has fallen off it, small enough to be nothing
 * at all in memory.
 */
const DISPATCHES_KEPT = 100;

/**
 * Makes a log, and the Subscriber that writes to it.
 *
 * **What it writes is keyed by Fulfilment, which is this Plugin's answer to ADR-0085's
 * idempotence requirement.** In-process delivery is at most once; a durable one would be at
 * least once, and a Plugin written to the weaker guarantee is one that starts double-counting
 * the day that changes. Keying by what moved rather than appending means being told twice leaves
 * one entry — and the second telling wins, so an entry is always the most recent account of the
 * transition rather than the first one heard.
 *
 * A `Map` rather than an array for exactly that: insertion order is kept, which is what makes
 * {@link DispatchLog.entriesFor} oldest-first and what makes {@link DISPATCHES_KEPT} drop the
 * oldest, and re-setting a key does not move it — so hearing about one Fulfilment twice does not
 * push another off the end.
 */
export function dispatchLog(): DispatchLog {
  const heard = new Map<string, DispatchLogEntry>();

  return {
    logTheDispatch: (dispatched: FulfilmentDispatched) => {
      heard.set(dispatched.fulfilmentId, {
        fulfilmentId: dispatched.fulfilmentId,
        orderId: dispatched.orderId,
        trackingReference: dispatched.trackingReference,
        occurredAt: dispatched.occurredAt,
      });
      // Oldest first out, so what is kept is what somebody is most likely to still be asking
      // about. A Subscriber must return quickly (ADR-0085) and this is the whole of the work.
      for (const oldest of heard.keys()) {
        if (heard.size <= DISPATCHES_KEPT) break;
        heard.delete(oldest);
      }
    },
    entriesFor: (orderId) =>
      [...heard.values()].filter((entry) => entry.orderId === orderId),
  };
}
