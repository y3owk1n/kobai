import { describe, expect, it } from "vitest";
import { createTestKobai, seedTestOrder, type TestKobai } from "../testing/index.ts";

/**
 * **One Fulfilment, dispatched by two Merchants at once** — the assertion nothing sequential can
 * make (#320, ADR-0018).
 *
 * A transition reads *where the Fulfilment is* and writes *where it should be*, which is the
 * shape ADR-0018 exists to rule out wherever the two are two statements: a `select` for the state
 * followed by an `update` lets both Merchants past, both answer 200, and the tracking reference
 * the first one wrote is silently replaced by the second's. So `transitionFulfilment` puts the
 * condition inside the `where` of the update — `state in (<the states this move is legal
 * from>)`, derived from the transition table — and Postgres takes the row lock before it
 * evaluates it, so the loser re-evaluates against the row the winner left.
 *
 * **No sequential test can tell those two implementations apart**, because the forbidden shape
 * passes every case in `a-fulfilment-moves.test.ts`. So this one dispatches *at once*, the way
 * `reservation/the-last-unit.test.ts` and the two beside it do. Three things about how it is
 * written carry to the next such test:
 *
 * - **Assert on what the losers were told, and on what the row holds — not only on the winner.**
 *   Exactly one 201-equivalent (200 here), every other request refused with *the reason that is
 *   true* rather than failing some other way, and the reference the Fulfilment ends up carrying
 *   belonging to the request that was answered 200. That last one is what tells a lock from a
 *   backstop: an implementation that let everybody through still ends `dispatched`, and the
 *   Merchant who was told "yes" is not the one whose consignment number is on the parcel.
 * - **How many is a named constant with its reason beside it.**
 * - **It was watched failing**, and what the run did is recorded below, because a race nobody has
 *   seen lost is not yet known to be losable — and because once the fix is in, this test can no
 *   longer show that the window was reached at all.
 *
 * **The recorded run.** Against a `transitionFulfilment` that read the state in one statement and
 * wrote in another — `select state …` then `update … where id = … and order_id = …`, with the
 * legality decided in TypeScript between them — **twenty of the twenty-four requests were
 * answered 200**, and the Fulfilment came out carrying the reference of a Merchant who was never
 * the winner. Changing how these requests are dispatched obliges you to watch it fail again
 * rather than to trust that it still would.
 */

/**
 * How many Merchants press Dispatch at the same instant.
 *
 * **Comfortably more than the connection pool, and that is the opposite of the reservation
 * tests' rule** — theirs says to stay well inside it, because queueing behind connections
 * serialises the thing they exist to overlap. Here queueing is exactly what makes the window
 * *visible*: the pool is `pg`'s default ten, so the first ten selects all read `pending` and the
 * requests behind them are still arriving while the first update lands. **This was measured
 * rather than reasoned about** — at eight, the broken implementation answered one 200 and passed,
 * which is a green run over the very shape it was written to forbid.
 */
const AT_ONCE = 24;

/** What each of them writes down, so the row can say which request actually won. */
const referenceOf = (attempt: number) => `RR${attempt}`;

/** Every Fulfilment of an Order, as this file reads one. */
async function fulfilmentsOf(
  kobai: TestKobai,
  orderId: string,
  headers: Record<string, string>,
): Promise<
  readonly {
    readonly id: string;
    readonly state: string;
    readonly trackingReference: string | null;
  }[]
> {
  const response = await kobai.request(`/admin/orders/${orderId}`, { headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly fulfilments: readonly {
      readonly id: string;
      readonly state: string;
      readonly trackingReference: string | null;
    }[];
  };
  return body.fulfilments;
}

describe("two Merchants dispatch one Fulfilment at the same instant", () => {
  it("answers one of them, refuses the rest, and keeps the winner's tracking reference", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const headers = {
      ...order.catalog.merchant.headers,
      "content-type": "application/json",
    };
    const [one] = await fulfilmentsOf(kobai, order.id, order.catalog.merchant.headers);
    if (!one) throw new Error("this Order has no Fulfilment to dispatch");

    const attempts = await Promise.all(
      Array.from({ length: AT_ONCE }, (_unused, attempt) =>
        kobai.request(`/admin/orders/${order.id}/fulfilments/${one.id}/dispatch`, {
          method: "POST",
          headers,
          body: JSON.stringify({ trackingReference: referenceOf(attempt) }),
        }),
      ),
    );

    const answered = attempts.filter((response) => response.status === 200);
    expect(answered).toHaveLength(1);

    // Every loser refused with the reason that is **true** — the Fulfilment is dispatched — and
    // not merely failing some other way. A 500 from a lost update would satisfy "not 200".
    const refused = attempts.filter((response) => response.status !== 200);
    expect(refused.map((response) => response.status)).toEqual(
      Array.from({ length: AT_ONCE - 1 }, () => 409),
    );
    for (const response of refused) {
      await expect(response.json()).resolves.toMatchObject({
        reason: "fulfilment-dispatched",
      });
    }

    // And the row carries the winner's reference rather than whichever request wrote last. This
    // is the assertion the status codes cannot make: a lost update leaves the Fulfilment
    // `dispatched` either way, and only the reference says whose dispatch it actually was.
    const winner = (await answered[0]?.json()) as { readonly trackingReference: string };
    const [after] = await fulfilmentsOf(kobai, order.id, order.catalog.merchant.headers);
    expect(after?.state).toBe("dispatched");
    expect(after?.trackingReference).toBe(winner.trackingReference);
  });
});
