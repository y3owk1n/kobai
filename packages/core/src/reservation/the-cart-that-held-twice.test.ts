import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **One Cart, held by everybody at once** — the assertion claim-or-adopt exists for (ADR-0070).
 *
 * A storefront holds a Cart's stock before sending a Shopper to their bank, and a retry after a
 * timeout is the ordinary case rather than the exception — so `POST /store/carts/{id}/reservations`
 * has to **adopt** the hold a Cart already has rather than take a second one. Deciding that means
 * asking whether this Cart is holding anything, which is a question about *other rows* than the
 * one being written: ADR-0018's conditional update cannot express it, so the answer is its other
 * mechanism, a lock — `pg_advisory_xact_lock` on the Cart, taken before the read, exactly as
 * `the-last-administrator.test.ts`'s guard is.
 *
 * Nothing sequential can tell that apart from a plain read: two holds one after the other adopt
 * correctly with or without the lock. The difference shows up only when both are inside the gap
 * between the read and the claim at the same instant, so this file dispatches them together, and
 * asks for both halves of the race:
 *
 * - **many holds at one Cart** — every one answered, one hold made, and the Store holding one
 *   unit rather than eight;
 * - **many holds at one unit of stock** — one Cart served, the rest refused with the reason that
 *   is true, and the shelf left with nothing loose.
 *
 * **It was watched failing before it was made to pass**, because a race nobody has seen lost is
 * not yet known to be losable. Against the read-then-write version — the same claim-or-adopt with
 * the `pg_advisory_xact_lock` line taken out of `holdReservations` — it lost **five runs out of
 * eleven**, and on the worst of them every one of the eight simultaneous holds answered **200**
 * and every one of them claimed: eight distinct answers, **eight live rows against the one Cart**
 * in `core_reservation`, and `core_inventory.reserved` at **8** where one unit had been asked for
 * — a Store with eight posters on the shelf and none of them sellable. The other losing runs were
 * the same failure with two, five and seven of the eight inside the window. Nothing refused and
 * nothing raised: the Shopper's own placement would have adopted whichever hold it read, and the
 * rest would have sat there until the sweeper gave them back a quarter of an hour later.
 *
 * **It loses about half the time and that is worth knowing rather than tidying away.** Whether
 * two of these eight are inside the gap at once depends on what else the machine is doing, so a
 * single green run against a broken implementation is an ordinary outcome — which is the argument
 * for writing the count down rather than the verdict, and for re-running a handful of times
 * before believing this file about anything.
 *
 * That run is the whole of the proof the window is reached, and it has to be: with the lock in, a
 * hold that landed in the gap and one that arrived after the other transaction committed answer
 * identically — which is what the fix is *for* — so a green run below can no longer tell a
 * contended race from an arrangement that quietly stopped overlapping. **Changing how these
 * requests are dispatched means watching it fail again rather than trusting that it still
 * would.**
 */

/**
 * How many storefront retries land on one Cart at once.
 *
 * Enough that the gap between the read and the claim is hit by more than one of them on any
 * scheduling — eight reached it on every run the failure above was measured over — and small
 * enough to stay well inside the connection pool, because queueing behind connections would
 * serialise the very thing this exists to overlap.
 */
const HOLDS = 8;

describe("many holds, one Cart", () => {
  it("holds it once, tells every caller the same thing, and claims one unit", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    // More on the shelf than anybody asked for, deliberately: a Store with one poster would
    // refuse the second claim on stock alone and the double-hold would be invisible. Eight
    // available and one wanted means every extra claim is one the Store could have made and
    // should not have.
    await countStock(kobai, catalog, HOLDS);
    const cart = await seedTestCart(kobai, { catalog, quantity: 1 });

    const answers = await Promise.all(
      Array.from({ length: HOLDS }, async () => {
        const response = await hold(kobai, cart.apiKey.headers, cart.id);
        return { status: response.status, body: await response.json() };
      }),
    );

    // Every caller was answered, and answered the same thing — one claim of one, standing until
    // one moment. A storefront retrying cannot tell which of its requests was the one that
    // claimed, which is what makes the retry safe.
    expect(answers.map((answer) => answer.status)).toEqual(Array(HOLDS).fill(200));
    expect(new Set(answers.map((answer) => JSON.stringify(answer.body))).size).toBe(1);
    expect(answers[0]?.body).toEqual({
      cartId: cart.id,
      expiresAt: expect.any(String),
      reservations: [{ provider: "inventory", subject: catalog.variantId, quantity: 1 }],
    });

    // And the books agree from both sides: one Reservation, and one unit off the shelf rather
    // than eight. This is the assertion the failing run above breaks — the answers were all
    // 200 there too.
    await expect(liveHoldsOn(kobai, cart.id)).resolves.toEqual([
      { subject: catalog.variantId, quantity: "1" },
    ]);
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: HOLDS,
      reserved: 1,
      available: HOLDS - 1,
    });
  });

  it("leaves the placement that follows holding what was held for it", async () => {
    // The other half of adopting: the hold is taken once by many callers, and the Order then
    // consumes that hold rather than claiming a second one. A placement that claimed again
    // would need two units for a Cart that wants one, and there is only one to be had.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 1);
    const cart = await seedTestCart(kobai, { catalog, quantity: 1 });

    await Promise.all(
      Array.from({ length: HOLDS }, () => hold(kobai, cart.apiKey.headers, cart.id)),
    );
    const placed = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    expect(placed.status).toBe(201);
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 0,
      reserved: 0,
      available: 0,
    });
  });
});

describe("many holds, one unit", () => {
  it("gives it to one Cart, refuses the rest, and leaves nothing loose", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 1);
    // A Cart each, because a Cart holds its stock exactly once — eight requests against one
    // Cart is the test above, about adopting, and would pass here whatever the claim did.
    const carts = await Promise.all(
      Array.from({ length: HOLDS }, () => seedTestCart(kobai, { catalog })),
    );

    const answers = await Promise.all(
      carts.map(async (cart) => {
        const response = await hold(kobai, cart.apiKey.headers, cart.id);
        return {
          status: response.status,
          body: (await response.json()) as { reason?: string },
        };
      }),
    );

    // One winner, and every loser told the one thing that is true: the Store has not got it.
    // Anything else — a 500 from a constraint the implementation was leaning on, a 409 about
    // the Cart — would be the race being survived by accident rather than decided.
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(
      answers
        .filter((answer) => answer.status !== 200)
        .map((answer) => `${answer.status} ${answer.body.reason}`),
    ).toEqual(Array(HOLDS - 1).fill("409 insufficient-inventory"));

    // One unit claimed, none oversold, and nothing left claimed by a request that was refused:
    // holding is all of it or none of it, so a loser holds nothing at all.
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 1,
      reserved: 1,
      available: 0,
    });
    const holdsPerCart = await Promise.all(
      carts.map((cart) => liveHoldsOn(kobai, cart.id)),
    );
    expect(holdsPerCart.filter((held) => held.length > 0)).toHaveLength(1);
  });
});

/** Holding a Cart's stock, over the surface a storefront actually calls. */
function hold(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request(`/store/carts/${cartId}/reservations`, {
    method: "POST",
    headers,
  });
}

/**
 * What this Cart is holding, as the record says — asked of the database because there is no
 * route that lists a Cart's Reservations and the count is the whole question here.
 */
async function liveHoldsOn(kobai: TestKobai, cartId: string) {
  return kobai.database.query<{ subject: string; quantity: string }>(
    `select subject, quantity::text as quantity
     from core_reservation
     where cart_id = $1 and consumed_at is null and released_at is null
     order by subject`,
    [cartId],
  );
}

/** What a Merchant says the Store has — through the API, like everything else here. */
async function countStock(kobai: TestKobai, catalog: TestCatalog, onHand: number) {
  const response = await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
    method: "PUT",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
  expect(response.status).toBe(200);
}

/** What the Store believes it has, read the way a Merchant reads it. */
async function stockOf(kobai: TestKobai, catalog: TestCatalog) {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  const product = (await response.json()) as {
    variants: readonly {
      id: string;
      inventory: { onHand: number; reserved: number; available: number } | null;
    }[];
  };
  const found = product.variants.find(
    (variant) => variant.id === catalog.variantId,
  )?.inventory;
  return (
    found && {
      onHand: found.onHand,
      reserved: found.reserved,
      available: found.available,
    }
  );
}
