import type { Queryable, Transaction } from "../db/client.ts";
import type { FulfilmentAnswers } from "../fulfilment/strategy.ts";

/**
 * **Reservation** — one interface, and the providers that own the scarce things (ADR-0018).
 *
 * Inventory and Capacity are the same problem: something finite is checked, claimed while an
 * order is being placed, taken at Capture and given back when the attempt fails. ADR-0018 says
 * they go through one interface with two providers, and this file is that interface. Only one
 * provider exists today — {@link inventoryProvider} — and the shape is what stops the second
 * one from being a second mechanism: a Capacity provider is another value in
 * {@link RESERVATION_PROVIDERS}, answering the same four questions about its own subject, and
 * nothing about `hold-reservations`, `capture-order`, the sweeper or the schema changes to
 * admit it.
 *
 * What a provider does **not** own is the record. `core_reservation` says who claimed what,
 * until when, and how it ended, and Core writes it for every provider alike; a provider owns
 * only the arithmetic of its own resource. That is the split that keeps one table honest for
 * two kinds of scarcity — Capacity needs no column added to it.
 */

/**
 * A line something might be claimed for — what a Cart selected, as a provider sees it.
 *
 * The Variant is what a provider decides *from*: Inventory claims for one it is counting, and a
 * Capacity provider would claim for one whose Fulfilment Strategy consumes production time. It
 * is deliberately not an order line — nothing here needs a price, a title or a tax figure, and a
 * provider that could see them could price things.
 *
 * **`metadata` is here for the provider that does not exist yet**, and it is the difference
 * between an interface that admits Capacity and one that would have to be widened for it. What a
 * Capacity claim is *on* is a period rather than a Variant — the delivery date a Shopper asked
 * for — and Core models no such field and never will (ADR-0013): it arrives on the Cart's Line
 * Item as open data, verbatim, which is exactly where a lead-time rule already reads it from.
 * Core reads no key out of it here either.
 */
export type ReservableLine = {
  readonly variantId: string;
  readonly quantity: number;
  /** The Line Item's own open data (ADR-0013), carried through untouched. */
  readonly metadata: Record<string, unknown>;
  /**
   * What this Variant's Fulfilment Strategy answered about it (ADR-0014, ADR-0052).
   *
   * **This is what a provider decides from**, and it is why the interface takes it rather than
   * leaving `hold-reservations` to filter: Inventory claims for a line whose Strategy says it
   * consumes stock, and a Capacity provider will claim for one whose Strategy says it has a Lead
   * Time — two questions, one per provider, and neither is the Step's to ask on the other's
   * behalf. A filter above this line could only ever express the first.
   *
   * A line that no provider claims for produces no claim at all, which is not the same as a
   * claim of zero: a Store selling downloads takes no row lock and writes no Reservation.
   */
  readonly fulfilment: FulfilmentAnswers;
};

/**
 * A claim on something scarce: which provider owns it, what it is on, and how much.
 *
 * `subject` is opaque to everything but the provider that named it — a Variant's identifier for
 * Inventory, and whatever a Capacity provider keys a period by. Core stores it, sweeps it and
 * hands it back; it never reads it.
 */
export type ReservationClaim = {
  readonly provider: string;
  readonly subject: string;
  readonly quantity: number;
};

/**
 * Every way a provider can refuse to hold what was asked for.
 *
 * A closed union, so that the store surface's status map is exhaustive against it and Capacity's
 * own refusal cannot arrive as an unmapped reason answered 422 by accident — adding
 * `insufficient-capacity` here turns `http/store.ts` red naming it. It is the same bargain
 * {@link PlaceOrderRefusal} makes, one level down.
 */
export type ReservationRefusal = "insufficient-inventory";

/** A provider's answer to being asked for a claim: it holds, or it says why it cannot. */
export type HoldOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ReservationRefusal; readonly detail: string };

/**
 * A provider of scarce things — the interface ADR-0018 asks for, in four questions.
 *
 * **Everything but `claimsFor` takes a transaction**, and that is the ADR's atomicity
 * requirement made structural rather than remembered: a hold is claimed and recorded together,
 * a consumption joins the transaction the Order is written in, and a release and the row that
 * authorises it move together. A provider handed a pool could not have been part of any of
 * them.
 *
 * **Every operation is a property holding a function rather than a method** (#127), which is the
 * spelling every interface kobai asks somebody else to implement uses — `Logger`,
 * `PaymentProvider`, `FulfilmentStrategy`, `Step.run`, `Codemod.apply` — and for the identical
 * reason: TypeScript checks method parameters *bivariantly* and function-property
 * parameters *contravariantly*, so only this spelling makes a provider that demands **more** than
 * Core sends a compile error rather than a runtime surprise. The mistake it catches is a
 * plausible one here — `claimsFor: (db, lines: readonly (ReservableLine & { period: string })[])
 * => …`, from the Capacity provider that does not exist yet — and the honest answer to it is
 * {@link ReservableLine.metadata}, which is ADR-0013's open data and is on this interface for
 * exactly that provider.
 *
 * **This one was free to change and `Logger` was not.** Nothing on the promised surface hands a
 * Project a way to supply a Reservation provider: this type is not exported from `@kobai/core`,
 * {@link RESERVATION_PROVIDERS} is Core's own list, and there is no config key and no ADR for
 * supplying one. So the tightening is invisible outside this package — it is `Logger`'s, taken
 * under ADR-0058's licence to break a promised surface before the first release, that needed an
 * argument. Changing it here anyway is what keeps the set reading alike, so the next interface is
 * copied from one that agrees rather than from whichever file was opened first; the day a Project
 * may supply one, the shape is already the safe one.
 */
export type ReservationProvider = {
  /** What a Reservation of this provider's records as its `provider`. */
  readonly name: string;
  /**
   * What this provider claims for these lines, if anything.
   *
   * Asked once for the whole Cart rather than once per line, because the answer is a query: the
   * Inventory provider asks which of these Variants it is counting, and a Variant it is not
   * counting produces no claim at all. Two lines for one subject are the provider's to combine
   * or to leave apart — Inventory combines, because two claims on one row would take two
   * conditional updates where one will do.
   */
  readonly claimsFor: (
    db: Queryable,
    lines: readonly ReservableLine[],
  ) => Promise<readonly ReservationClaim[]>;
  /**
   * Claims them, **atomically**, or says which one it could not (ADR-0018).
   *
   * The check and the claim must be one operation — a row lock or a conditional write, never a
   * `select` followed by an `update`. Two requests reading the same last unit both see it, and
   * a Store that answered both has implemented the appearance of safety, which is worse than
   * none.
   */
  readonly hold: (
    tx: Transaction,
    claims: readonly ReservationClaim[],
  ) => Promise<HoldOutcome>;
  /**
   * Takes them for good, inside the transaction the Order is written in.
   *
   * It needs no compensation for the same reason nothing else in that transaction does: the
   * database unwinds it. What it must do is refuse rather than oversell — a claim that is no
   * longer there because the sweeper released it is a failure, not a licence to sell what the
   * Store does not have.
   */
  readonly consume: (
    tx: Transaction,
    claims: readonly ReservationClaim[],
  ) => Promise<void>;
  /** Gives them back — from a compensation, or from the sweeper, which cannot tell them apart. */
  readonly release: (
    tx: Transaction,
    claims: readonly ReservationClaim[],
  ) => Promise<void>;
};
