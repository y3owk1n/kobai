import { describe, expect, it } from "vitest";
import type { PaidOrder, ReservedLines } from "../order/place-order.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";

/**
 * A **Reservation** through the Workflow that makes one: held while an Order is being placed,
 * consumed inside the Capture transaction, released when anything after the hold fails
 * (ADR-0018, ADR-0027).
 *
 * Everything is asserted at the public HTTP seam and against what the database is holding
 * afterwards, because both halves matter and neither implies the other: a 201 with the stock
 * still on the shelf is an oversell waiting to happen, and a 409 with the stock gone is a Store
 * that has lost track of what it owns. The race that decides which of two Shoppers gets the last
 * one has a file of its own — `the-last-unit.test.ts` — because it is the ticket's whole point.
 */

describe("stock, while an Order is being placed", () => {
  it("is consumed at Capture, in the transaction the Order is written in", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // Three on the shelf, two sold, one left — and nothing still claimed, because the claim
    // became the Order rather than outliving it.
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 1,
      reserved: 0,
      available: 1,
    });
  });

  it("is recorded as a Reservation against the Order that consumed it", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placed = (await (await place(kobai, cart.apiKey.headers, cart.id)).json()) as {
      id: string;
    };

    // The record says who claimed what and how it ended, and it is one row whichever provider
    // made the claim — which is what lets Capacity arrive without a table of its own.
    const rows = await kobai.database.query<{
      provider: string;
      subject: string;
      quantity: string;
      order_id: string;
      consumed: boolean;
      released: boolean;
    }>(
      `select provider, subject, quantity::text as quantity, order_id,
              consumed_at is not null as consumed, released_at is not null as released
       from core_reservation`,
    );
    expect(rows).toEqual([
      {
        provider: "inventory",
        subject: catalog.variantId,
        quantity: "2",
        order_id: placed.id,
        consumed: true,
        released: false,
      },
    ]);
  });

  it("is not claimed at all for a Variant nobody is counting", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { quantity: 4 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // An untracked Variant is not one with none left: it sells freely, and there is nothing to
    // hold, nothing to release and no row to sweep.
    await expect(reservationCount(kobai)).resolves.toBe(0);
  });

  it("refuses the Order when the Store does not have enough, and leaves the stock alone", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 1);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "insufficient-inventory",
      workflow: { name: "place-order", failed: "hold-reservations" },
    });
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 1,
      reserved: 0,
      available: 1,
    });
    await expect(orderCount(kobai)).resolves.toBe(0);
  });

  it("holds nothing when one line of a Cart cannot be held", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [900] }],
    });
    await countStock(kobai, catalog, catalog.variant("POSTER-A2").id, 5);
    await countStock(kobai, catalog, catalog.variant("MUG").id, 0);
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG" }],
    });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    // The poster is not left claimed for a Shopper who was told no. All of it or none of it,
    // because the alternative makes stock unsellable until the sweeper notices.
    await expect(
      stockOf(kobai, catalog, catalog.variant("POSTER-A2").id),
    ).resolves.toEqual({
      onHand: 5,
      reserved: 0,
      available: 5,
    });
  });

  it("is released by the Step's compensation when the Payment is declined", async () => {
    await using kobai = await createTestKobai({ payments: { provider: declining } });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(402);
    // Held, then given back — the whole reason `hold-reservations` carries a compensation. A
    // Store that leaked two units on every declined card would be unsellable by lunchtime.
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 0,
      available: 3,
    });
    const [row] = await kobai.database.query<{ released: boolean; consumed: boolean }>(
      `select released_at is not null as released, consumed_at is not null as consumed
       from core_reservation`,
    );
    expect(row).toEqual({ released: true, consumed: false });
  });

  it("is released when a Step of nobody's refuses after the hold", async () => {
    await using kobai = await createTestKobai({
      workflows: { "place-order": { after: { "take-payment": [refuses] } } },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    // A Plugin's or a Project's own rule declining a purchase is the ordinary case the
    // compensation exists for, and it is not Core's refusal — so the stock has to come back
    // for a reason Core has never heard of.
    expect(response.status).toBe(422);
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 0,
      available: 3,
    });
  });

  it("is held while the Order is in flight, so a Merchant cannot count it away", async () => {
    // The one place the intermediate state is observable through the public API: a hold is
    // `reserved`, and a Merchant setting a count below it is refused rather than quietly
    // overwriting a claim somebody is about to buy.
    await using kobai = await createTestKobai({
      workflows: { "place-order": { after: { "hold-reservations": [pause.step] } } },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placing = place(kobai, cart.apiKey.headers, cart.id);
    await pause.reached;

    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 2,
      available: 1,
    });
    const refused = await countStock(kobai, catalog, catalog.variantId, 1);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ reason: "stock-is-reserved" });

    pause.release();
    expect((await placing).status).toBe(201);
  });
});

/** The Payment Provider that says no, so the Step after the hold is the one that fails. */
const declining: PaymentProvider = {
  name: "declining",
  charge: async () => ({ ok: false, detail: "This card was declined." }),
  refund: async () => {},
};

/** A Step of nobody's, refusing with a reason Core has never heard of. */
const refuses = defineStep("refuses-after-payment", (_paid: PaidOrder): PaidOrder => {
  throw new StepFailure("not-today", "This Store is not taking Orders today.");
});

/** A Step that stops the run where a test wants to look at what the hold did. */
const pause = (() => {
  let reached = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    step: defineStep("pause", async (input: ReservedLines): Promise<ReservedLines> => {
      reached();
      await held;
      return input;
    }),
    reached: arrived,
    release: () => {
      release();
    },
  };
})();

async function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

/** What a Merchant says the Store has — through the API, like everything else here. */
async function countStock(
  kobai: TestKobai,
  catalog: TestCatalog,
  variantId: string,
  onHand: number,
) {
  return kobai.request(`/admin/variants/${variantId}/inventory`, {
    method: "PUT",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
}

/** What the Store believes it has, read the way a Merchant reads it. */
async function stockOf(kobai: TestKobai, catalog: TestCatalog, variantId: string) {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  const product = (await response.json()) as {
    variants: readonly {
      id: string;
      inventory: { onHand: number; reserved: number; available: number } | null;
    }[];
  };
  const found = product.variants.find((variant) => variant.id === variantId)?.inventory;
  // The three numbers, without the identifier the test already named — so a failure reads as
  // what the Store has rather than as a uuid nobody was asking about.
  return found === null || found === undefined
    ? found
    : { onHand: found.onHand, reserved: found.reserved, available: found.available };
}

async function reservationCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ id: string }>(
    "select id from core_reservation",
  );
  return rows.length;
}

async function orderCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ id: string }>("select id from core_order");
  return rows.length;
}
