/**
 * **What a Fulfilment may do next** — the states, the legal transitions between them, and the
 * word a Merchant is refused an illegal one with (ADR-0014, ADR-0060).
 *
 * This module is the *decision* rather than the implementation of it. ADR-0014 makes a
 * Fulfilment the one part of an Order that moves while the Order around it never does, and #211
 * says the legal transitions "are a decision the spec must write down rather than leave to the
 * implementation" — so they are a table here that every route, every refusal and every test is
 * read from, and no handler decides one for itself. A transition kobai will not make is
 * therefore a line of this file rather than an `if` somebody has to go looking for.
 *
 * ## The states
 *
 * Four, and the set is Core's own. Nothing outside Core invents one: a Fulfilment **Strategy**
 * is an open set because a Store may sell anything (ADR-0014), and how a Fulfilment *moves* is
 * not — a Plugin that wanted a fifth would be asking Core to model a lifecycle it has no word
 * for, which is a decision rather than a configuration key. So the column carries a `check` and
 * the wire carries an enum.
 *
 * ## The transitions, and why these
 *
 * ```
 *   pending ──dispatch──▶ dispatched ──deliver──▶ delivered
 *      │                       │
 *      └────────cancel─────────┴──────cancel────▶ cancelled
 * ```
 *
 * - **`pending` is where Capture leaves every Fulfilment.** It says nothing has been recorded
 *   about this part of the Order moving, which is exactly what is true of one the moment it is
 *   written — and of every Fulfilment written before this column existed, which is why the
 *   backfill is a `DEFAULT` rather than a guess (ADR-0038).
 * - **Delivering takes a dispatch first**, and that is the one arguable edge. A Fulfilment
 *   handed over the counter was still dispatched, so recording the dispatch is one extra
 *   request rather than a lost fact — where allowing `pending → delivered` would leave an Order
 *   whose record cannot say when it left, and no later request could put that back.
 * - **Cancelling is allowed from `dispatched` as well as from `pending`**, because story 11 is
 *   *a part that cannot be delivered says so* and a parcel lost in transit is exactly that.
 *   Whether the Shopper gets their money back is a **Return** and its own spec — a cancelled
 *   Fulfilment is not a refund (ADR-0009 makes the Order immutable either way).
 * - **`delivered` and `cancelled` are terminal.** Both are statements about the world rather
 *   than about kobai's intentions, and neither becomes untrue. `cancelled → dispatched` is the
 *   one #211 names by hand, and it is refused here for the reason every other terminal
 *   transition is: an Order's history is a record, and a record that can be walked backwards is
 *   a record of nothing.
 *
 * **There is no route that corrects a state**, deliberately. A `PATCH` accepting
 * `state: "dispatched"` would let any state be set from any other, which is precisely these
 * refusals made unreachable (ADR-0062: a `PATCH` is a *correction*, and a dispatch is a
 * transition with consequences). Correcting a mistaken transition is not a capability kobai has
 * and adding one is additive under ADR-0060 the day somebody argues for it.
 *
 * ## The refusals, and why there are exactly four
 *
 * **A refusal is named after the state that refuses it**, and that is what makes the set
 * exhaustive by construction rather than by care: {@link FULFILMENT_REFUSALS} is a `Record` over
 * the state union, so every state *has* a word and there is nowhere for a `default` branch to
 * live. A fifth state arrives with a fifth word, and every `satisfies` and `switch` over the set
 * goes red until somebody writes it.
 *
 * The alternative — a word per (action, blocking state) pair — is nine words for four facts,
 * and every one of them would be promised for ever under ADR-0060.
 */

/** Where Capture leaves a Fulfilment: nothing has been recorded about it moving. */
export const FULFILMENT_PENDING = "pending";

/**
 * Every state a Fulfilment can be in, in the order it moves through them.
 *
 * The one list — the column's `check`, the wire's enum, the transition table below and the
 * refusal words are all built from it, so a fifth state is one edit here and a migration.
 */
export const FULFILMENT_STATES = [
  FULFILMENT_PENDING,
  "dispatched",
  "delivered",
  "cancelled",
] as const;

export type FulfilmentState = (typeof FULFILMENT_STATES)[number];

/**
 * **The legal transitions**, and the whole of them.
 *
 * Keyed by the state a Fulfilment is in, holding the states it may move to from there. A
 * `Record` over the union rather than a list of pairs, so a state added without an answer to
 * "what may it become" does not compile — and the two terminal states say so with an empty list
 * rather than by being absent, because absent and *nothing* read alike and only one of them is
 * a decision.
 */
export const FULFILMENT_TRANSITIONS = {
  pending: ["dispatched", "cancelled"],
  dispatched: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
} as const satisfies Record<FulfilmentState, readonly FulfilmentState[]>;

/**
 * Why a Fulfilment would not move — the state it is in, said as a `reason` a caller branches on.
 *
 * One word per state, which is what makes the set closed and exhaustive: the question a caller
 * asks is *why did that not work*, and the honest answer is always *because of where it already
 * is*. Prefixed, because `cancelled` on its own would be a word about no particular noun on a
 * surface that also has Carts, Orders and Payments.
 */
export const FULFILMENT_REFUSALS = {
  pending: "fulfilment-pending",
  dispatched: "fulfilment-dispatched",
  delivered: "fulfilment-delivered",
  cancelled: "fulfilment-cancelled",
} as const satisfies Record<FulfilmentState, `fulfilment-${FulfilmentState}`>;

export type FulfilmentTransitionRefusal =
  (typeof FULFILMENT_REFUSALS)[keyof typeof FULFILMENT_REFUSALS];

/**
 * The states a Fulfilment may be in for this move to be legal — the table above, read backwards.
 *
 * **Derived rather than written down a second time.** This is what the `where` clause of the one
 * statement that moves a Fulfilment is built from, so *what kobai will do* is the same table as
 * *what kobai says about what it will not*: an edit to the transitions above moves both ends at
 * once, and there is no second list to forget.
 */
export function statesThatMayBecome(to: FulfilmentState): readonly FulfilmentState[] {
  return FULFILMENT_STATES.filter((from) =>
    (FULFILMENT_TRANSITIONS[from] as readonly FulfilmentState[]).includes(to),
  );
}
