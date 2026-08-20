import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { fulfilment, order } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { type Fulfilment, readFulfilmentsOf } from "./fulfilment.ts";
import {
  FULFILMENT_REFUSALS,
  type FulfilmentState,
  type FulfilmentTransitionRefusal,
  statesThatMayBecome,
} from "./lifecycle.ts";

/**
 * **Moving one Fulfilment of an Order** — dispatched, delivered, cancelled (#320, ADR-0014).
 *
 * One function, because the three routes differ in exactly one value: the state they ask for.
 * Which moves are legal is `./lifecycle.ts`'s table and never a branch here, so a fourth action
 * is a fourth caller of this rather than a fourth copy of the rule.
 *
 * Four things about it are decisions rather than implementation.
 *
 * **The Order is addressed as well as the Fulfilment, and both are checked.** A Fulfilment's
 * identifier is unique on its own, so the join is not what finds the row — it is what makes the
 * address mean something: `POST /admin/orders/{a}/fulfilments/{b}/dispatch` where `b` belongs to
 * another Order is a mistake, and answering it 200 would move a Fulfilment the Merchant was not
 * looking at.
 *
 * **The check and the write are one statement**, which is ADR-0018's shape reached from an
 * ordinary direction rather than a claim on anything scarce. The `where` names the states this
 * move is legal from — {@link statesThatMayBecome}, derived from the same table the refusals
 * are — so Postgres takes the row lock before it evaluates the condition, and two Merchants
 * dispatching one Fulfilment at the same instant produce one 200 and one refusal rather than two
 * 200s and a lost tracking reference. A `select` for the state followed by an `update` lets both
 * through.
 *
 * **The refusal is read after the write, not before it.** Nothing moved means either the address
 * is wrong or the state refused it, and only the row can say which — so it is asked once, and
 * the answer names *where the Fulfilment actually is* rather than where a read a moment earlier
 * found it.
 *
 * **Nothing is emitted.** ADR-0085 decided the events surface and #322 builds it, with a
 * dispatch as its first consumer; wiring one here ahead of that record would be exactly the
 * implicit registration ADR-0017 exists to prevent.
 */

export type FulfilmentTransition =
  | { readonly ok: true; readonly fulfilment: Fulfilment }
  | {
      readonly ok: false;
      readonly reason:
        | FulfilmentTransitionRefusal
        | "order-not-found"
        | "fulfilment-not-found";
      readonly detail: string;
    };

/** What a dispatch records beside the state, and the whole of what any transition takes. */
export type FulfilmentTransitionInput = {
  /**
   * Written onto the row, opaque, and only ever by a dispatch.
   *
   * Absent is a dispatch that recorded none — a download has nothing to track — which is why it
   * is optional rather than required, and why delivering and cancelling pass nothing here at
   * all: they leave whatever the dispatch wrote exactly where it was.
   */
  readonly trackingReference?: string;
};

export async function transitionFulfilment(
  db: Database,
  orderId: string,
  fulfilmentId: string,
  to: FulfilmentState,
  input: FulfilmentTransitionInput = {},
): Promise<FulfilmentTransition> {
  // A string that could never be an identifier and one nothing carries are the same answer to
  // the caller, exactly as `IdParam`'s own description says.
  if (!isUuid(orderId) || !isUuid(fulfilmentId)) {
    return isUuid(orderId) ? noSuchFulfilment() : noSuchOrder();
  }

  const [moved] = await db
    .update(fulfilment)
    .set({
      state: to,
      ...(input.trackingReference === undefined
        ? {}
        : { trackingReference: input.trackingReference }),
    })
    .where(
      and(
        eq(fulfilment.id, fulfilmentId),
        eq(fulfilment.orderId, orderId),
        inArray(fulfilment.state, [...statesThatMayBecome(to)]),
      ),
    )
    .returning({ id: fulfilment.id });

  if (moved) {
    // Read back through the one reader an Order's Fulfilments have, so what this answers with is
    // byte for byte what `GET /admin/orders/{id}` will report a moment later.
    const read = (await readFulfilmentsOf(db, orderId)).find(
      (one) => one.id === fulfilmentId,
    );
    // Unreachable: the row was just updated inside this Order. Answered rather than thrown,
    // because a 500 is a worse account of a Fulfilment somebody deleted in between than a 404.
    return read ? { ok: true, fulfilment: read } : noSuchFulfilment();
  }

  const [current] = await db
    .select({ state: fulfilment.state })
    .from(fulfilment)
    .where(and(eq(fulfilment.id, fulfilmentId), eq(fulfilment.orderId, orderId)))
    .limit(1);

  if (!current) {
    // Two addresses, so two answers: an Order that is not there, and an Order that is but has no
    // such Fulfilment. Asked in that order, because naming the outer one first is what tells a
    // Merchant which half of the address to fix.
    const [exists] = await db
      .select({ id: order.id })
      .from(order)
      .where(eq(order.id, orderId))
      .limit(1);
    return exists ? noSuchFulfilment() : noSuchOrder();
  }

  // The state refused it, and it is the state that names the reason — every one of the four is a
  // word, so there is no move this can fail to have an answer for.
  return {
    ok: false,
    reason: FULFILMENT_REFUSALS[current.state],
    detail: `This Fulfilment is ${current.state}, and a ${current.state} Fulfilment cannot become ${to}.`,
  };
}

function noSuchOrder(): FulfilmentTransition {
  return {
    ok: false,
    reason: "order-not-found",
    detail: "This Store has taken no Order at that address.",
  };
}

function noSuchFulfilment(): FulfilmentTransition {
  return {
    ok: false,
    reason: "fulfilment-not-found",
    detail: "That Order has no Fulfilment at that address.",
  };
}
