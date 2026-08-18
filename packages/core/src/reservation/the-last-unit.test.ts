import { describe, expect, it } from "vitest";
import type { PaymentProvider, RefundRequest } from "../payment/provider.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **The last unit, wanted by everybody at once** — the assertion ADR-0018 exists for.
 *
 * ADR-0018 says check-and-consume must be a row lock or a unique constraint and **never a
 * `select` followed by an `update`**, because otherwise the Store oversells anyway and has
 * merely implemented the appearance of safety, which is worse than none. Nothing about a
 * sequential test can tell the two apart: a read-then-write implementation passes every
 * assertion in `reservation.test.ts`, and the difference shows up only when two requests are
 * inside the gap between the read and the write at the same moment.
 *
 * So this file dispatches many placements at one unit of stock and asks three questions, all
 * of which have to hold together:
 *
 * - exactly one Order exists,
 * - every other request was refused with `insufficient-inventory` rather than failing some
 *   other way,
 * - and the Store is left at zero rather than at minus something.
 *
 * The third is not implied by the first two. A Store that answered two Shoppers and then
 * discovered it could only ship one has already made the promise it cannot keep, and the number
 * left behind is where that becomes visible.
 *
 * **It was watched failing before it was made to pass**, because an assertion nobody has seen
 * fail is not yet known to be able to. Against a deliberately non-atomic hold — the `select` and
 * then the `update` the ADR forbids — all six requests read the same free unit, all six claimed
 * it, all six were charged, and the run answered **one 201 and five 500s**: the losers were
 * stopped by the guard on `consume` inside Capture, which is a database error rather than a
 * decision, so each of them was told the server was broken for a purchase that was merely
 * simultaneous, and each had to be given their money back by a compensation that should never
 * have run. The Store did not oversell, and that is the point — safety by accident, at the very
 * last line that could still catch it, is exactly the appearance of safety ADR-0018 describes.
 */

/**
 * How many Shoppers reach for it at once.
 *
 * Enough that the gap between a read and a write is hit by more than one of them on any
 * scheduling, and small enough to stay well inside the connection pool — a test that queued
 * behind connections would serialise the very thing it is trying to overlap.
 */
const SHOPPERS = 6;

/**
 * A Payment Provider that keeps its books — what it took, and what it has given back.
 *
 * The harness's own provider remembers nothing, and what this test needs to know is *how many
 * Shoppers were charged at all*. `payment.test.ts` keeps a fuller one for the same reason: a
 * counter says a callback ran, and only the books say whose money moved.
 */
function ledger() {
  const taken: { readonly reference: string }[] = [];
  const givenBack: { readonly reference: string }[] = [];

  return {
    provider: {
      name: "ledger",
      charge: async () => {
        const reference = `ledger-${taken.length + 1}`;
        taken.push({ reference });
        return { ok: true as const, reference };
      },
      refund: async (payment: RefundRequest) => {
        givenBack.push({ reference: payment.reference });
      },
    } satisfies PaymentProvider,
    charges: () => [...taken],
    refunds: () => [...givenBack],
  };
}

describe("many Shoppers, one unit", () => {
  it("sells it exactly once, refuses everybody else, and is left at zero", async () => {
    const books = ledger();
    await using kobai = await createTestKobai({ payments: { provider: books.provider } });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 1);
    // One Cart each, because a Cart becomes exactly one Order — six requests against one Cart
    // would be a test about the idempotency of a Cart rather than about the scarcity of stock.
    const carts = await Promise.all(
      Array.from({ length: SHOPPERS }, () => seedTestCart(kobai, { catalog })),
    );

    const responses = await Promise.all(
      carts.map((cart) =>
        kobai.request("/store/orders", {
          method: "POST",
          headers: { ...cart.apiKey.headers, "content-type": "application/json" },
          body: JSON.stringify({ cartId: cart.id }),
        }),
      ),
    );
    const answers = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: (await response.json()) as { reason?: string },
      })),
    );

    // One winner, and every loser told the one thing that is true: the Store has not got it.
    // Anything else here — a 500 from a constraint the implementation was relying on, a 409
    // about the Cart — would be the race being survived by accident rather than decided.
    expect(answers.filter((answer) => answer.status === 201)).toHaveLength(1);
    expect(
      answers
        .filter((answer) => answer.status !== 201)
        .map((answer) => `${answer.status} ${answer.body.reason}`),
    ).toEqual(Array(SHOPPERS - 1).fill("409 insufficient-inventory"));

    // And the database agrees, from both sides: one Order, and a shelf that is empty rather
    // than owing anybody anything.
    await expect(orderCount(kobai)).resolves.toBe(1);
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 0,
      reserved: 0,
      available: 0,
    });

    // **One card was charged, and five were never touched.** This is the assertion that tells
    // atomicity from a backstop: a hold that let all six through is caught later — by the guard
    // in `consume`, or by the `reserved <= on_hand` check — and the shelf still ends at zero,
    // but by then five Shoppers have been charged and refunded for a purchase that never
    // happened. `hold-reservations` sits in front of `take-payment` precisely so that losing the
    // race costs nobody any money, and the provider's books are where that is visible.
    expect(books.charges()).toHaveLength(1);
    expect(books.refunds()).toEqual([]);
  });

  it("sells all of a small stock and no more, when everybody wants two", async () => {
    // The same race with the arithmetic made non-trivial: five on the shelf, six Shoppers
    // wanting two each. Two of them can be served and four cannot, so an implementation that
    // merely serialised the *first* claim would still oversell here.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const carts = await Promise.all(
      Array.from({ length: SHOPPERS }, () =>
        seedTestCart(kobai, { catalog, quantity: 2 }),
      ),
    );

    const responses = await Promise.all(
      carts.map((cart) =>
        kobai.request("/store/orders", {
          method: "POST",
          headers: { ...cart.apiKey.headers, "content-type": "application/json" },
          body: JSON.stringify({ cartId: cart.id }),
        }),
      ),
    );

    const placed = responses.filter((response) => response.status === 201);
    expect(placed).toHaveLength(2);
    // Four units sold out of five, and the odd one left on the shelf: nobody wanted one on its
    // own, and the Store did not invent a sixth to round the number off.
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 1,
      reserved: 0,
      available: 1,
    });
  });
});

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

async function orderCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ id: string }>("select id from core_order");
  return rows.length;
}
