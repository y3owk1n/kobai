import type { FulfilmentDispatched, Subscriber } from "@kobai/core";

/**
 * **What this Project does when kobai says a Fulfilment has been dispatched** — ADR-0003's
 * fourth Extension Point, wired in `kobai.config.ts` and reachable from nowhere else
 * (ADR-0085, ADR-0017).
 *
 * Story 22 of #211 is *I want to subscribe to a Fulfilment being dispatched, so that I can send
 * a confirmation email without patching Core*, and this is that Developer's file. Nothing here
 * is Core's and nothing here is a Plugin's: kobai announces a fact, and what a deployment does
 * about it is its own business, in its own source, in a language kobai has never heard of.
 *
 * **It queues a notice and returns; it does not send anything.** That is the shape ADR-0085
 * asks for rather than a shortcut around a mail server this repository must never acquire.
 * Delivery is in-process, at most once, and never retried — so a Subscriber that did the
 * sending inline would put somebody's SMTP timeout in front of a Merchant's dispatch, and would
 * lose a Shopper's confirmation to any process that died at the wrong moment. A deployment that
 * needs the notice not to be lost enqueues into something it already runs and returns, which is
 * a Project owning its own reliability. This is the smallest honest version of that: the queue
 * is in memory and **bounded** — see {@link NOTICES_KEPT} — because nothing here drains it, and
 * what drains it belongs to a deployment that has something to drain it with.
 *
 * **It is handed the payload and nothing else** — no transaction, no database handle, no
 * Workflow context — which is what makes it unable to change or undo the dispatch it hears
 * about. Anything else it needs is something this Project is holding at the moment it wires, so
 * a closure has it; that is why {@link confirmationOutbox} is a factory and why
 * `kobai.config.ts` exports the object it makes, exactly as it exports `bank`.
 */

/** One notice this deployment owes a Shopper, as its outbox holds it. */
export type DispatchNotice = {
  /** Which Fulfilment moved, and the Order it is part of — both, because both are in the payload. */
  readonly fulfilmentId: string;
  readonly orderId: string;
  /** What the Merchant recorded, or `null`. Opaque here exactly as it is opaque to kobai. */
  readonly trackingReference: string | null;
  /**
   * When kobai said it happened, as the payload said it — an ISO 8601 string, kept as one.
   *
   * Not the moment this ran. A Subscriber may run late, and the payload carrying `occurredAt`
   * at all is what lets a notice say when the parcel actually left rather than when this
   * deployment got round to noticing.
   */
  readonly occurredAt: string;
};

/**
 * The notices this deployment has queued, and the Subscriber that queues them.
 *
 * **It keeps books, and asking them is the point** — the same judgement `src/payments/fake-bank.ts`
 * makes about refunds, and the rule kobai's own tests hold everywhere: *the callback ran* and
 * *the Shopper is owed an email saying this parcel left* are two different facts, and a counter
 * only ever knows the first.
 */
export type ConfirmationOutbox = {
  /**
   * What this deployment wires against `fulfilment-dispatched`.
   *
   * A property holding a function rather than a method, so that a mistake about what kobai
   * sends is a compile error here rather than an `undefined` in a Shopper's confirmation.
   */
  readonly tellTheShopper: Subscriber<"fulfilment-dispatched">;
  /**
   * The notices queued for one Order, oldest first.
   *
   * By Order rather than *everything queued*, because one process may serve many and an
   * unqualified read would be a question with no stable answer.
   */
  readonly noticesFor: (orderId: string) => readonly DispatchNotice[];
};

/**
 * How many notices this outbox keeps before the oldest is dropped.
 *
 * **It is bounded on purpose, and the bound is the honest half of the sentence above.** Nothing
 * in this Project drains the queue, so an unbounded one is a process that grows by a row per
 * dispatch for as long as it runs — and this file is generated into every Project
 * `create-kobai` scaffolds, so an unbounded one would be a leak a Developer inherited rather
 * than wrote. The moment you give this something that drains — a table, a mail queue, a job —
 * the bound is what you delete.
 *
 * Large enough that nothing a person would look at has fallen off it, small enough to be
 * nothing at all in memory.
 */
const NOTICES_KEPT = 100;

export function confirmationOutbox(): ConfirmationOutbox {
  const queued: DispatchNotice[] = [];

  return {
    tellTheShopper: (dispatched: FulfilmentDispatched) => {
      queued.push({
        fulfilmentId: dispatched.fulfilmentId,
        orderId: dispatched.orderId,
        trackingReference: dispatched.trackingReference,
        occurredAt: dispatched.occurredAt,
      });
      // Oldest first out, so what is kept is what somebody is most likely to still be asking
      // about. A Subscriber must return quickly (ADR-0085) and this is the whole of the work.
      if (queued.length > NOTICES_KEPT) queued.splice(0, queued.length - NOTICES_KEPT);
    },
    noticesFor: (orderId) => queued.filter((notice) => notice.orderId === orderId),
  };
}
