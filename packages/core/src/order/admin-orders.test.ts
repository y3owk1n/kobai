import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../auth/permissions.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import {
  createTestKobai,
  seedTestCatalog,
  seedTestOrder,
  sessionOf,
  signInTestMerchant,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";
import type { AdjustedLines, PricedLines } from "./place-order.ts";

/**
 * The Admin's view of the Orders a Store has taken.
 *
 * The same records the store surface writes, read back by a Merchant instead of by a
 * storefront — so everything here is arranged the way a Shopper would arrange it, over
 * `/store`, and then asked for over `/admin`. Nothing is inserted behind the API.
 *
 * Reading them is gated on `order:read`, because not every Merchant should see the books
 * (ADR-0027 — a named Permission on a Role, never a rule about which Orders).
 */

describe("a Merchant sees the Orders the Store has taken", () => {
  it("lists them, with the number a Shopper quotes and what each came to", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai, { quantity: 2 });

    const response = await kobai.request("/admin/orders", {
      headers: order.catalog.merchant.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      orders: [
        {
          id: order.id,
          // What a Shopper reads over the phone, and not the identifier — the whole reason
          // a list is worth looking at while somebody is on the line.
          number: order.number,
          shopper: null,
          currency: "USD",
          total: 2500,
          payment: {
            id: expect.any(String),
            provider: "test",
            reference: expect.any(String),
            amount: 2500,
            currency: "USD",
            // What a Merchant is looking down this column for: this one is money in hand, and
            // an Order whose provider only arranged payment reads `false` here.
            received: true,
            createdAt: expect.any(String),
          },
          createdAt: expect.any(String),
        },
      ],
    });
  });

  it("lists them newest first, so the one just taken is at the top", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const first = await seedTestOrder(kobai, { catalog });
    const second = await seedTestOrder(kobai, { catalog });

    const response = await kobai.request("/admin/orders", {
      headers: catalog.merchant.headers,
    });

    const { orders } = (await response.json()) as { orders: { id: string }[] };
    expect(orders.map((one) => one.id)).toEqual([second.id, first.id]);
  });

  it("says so plainly when the Store has sold nothing", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/orders", { headers: merchant.headers });

    expect(response.status).toBe(200);
    // An envelope rather than a bare array, which is what lets pagination arrive beside the
    // list later rather than by breaking this response.
    await expect(response.json()).resolves.toEqual({ orders: [] });
  });

  it("tells an Order nobody has paid for from one that is money in hand", async () => {
    // The Store this matters to is the one the reference Project ships: a provider that arranges
    // payment out of band rather than taking it. Without `received` every Order it takes reads
    // as a completed sale, which is the mistake this criterion is about.
    const invoiced: PaymentProvider = {
      name: "invoiced",
      charge: async () => ({ ok: true, reference: "INV-1", received: false }),
      refund: async () => {},
    };
    await using kobai = await createTestKobai({ payments: { provider: invoiced } });
    const order = await seedTestOrder(kobai);

    const response = await kobai.request("/admin/orders", {
      headers: order.catalog.merchant.headers,
    });

    const { orders } = (await response.json()) as {
      orders: { id: string; payment: { received: boolean } }[];
    };
    expect(orders).toEqual([
      expect.objectContaining({
        id: order.id,
        payment: expect.objectContaining({ received: false }),
      }),
    ]);
  });
});

describe("a Merchant opens one Order", () => {
  it("sees its Line Items, its totals and the number the Shopper quotes", async () => {
    await using kobai = await createTestKobai();
    // Named here rather than defaulted, because the whole response is asserted below and every
    // field in it should have come from this test.
    const catalog = await seedTestCatalog(kobai, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });
    const order = await seedTestOrder(kobai, { catalog, quantity: 2 });

    const response = await kobai.request(`/admin/orders/${order.id}`, {
      headers: catalog.merchant.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: order.id,
      number: order.number,
      shopper: null,
      currency: "USD",
      total: 2500,
      lineItems: [
        {
          id: expect.any(String),
          variantId: catalog.variantId,
          // The snapshot, not a join: this is what a Merchant reads to a Shopper on the phone,
          // and it says what it said at Capture whatever the catalog says now (ADR-0009).
          title: "A poster",
          sku: "POSTER-A2",
          unitAmount: 1250,
          quantity: 2,
          tax: 0,
          adjustments: [],
          total: 2500,
          metadata: {},
        },
      ],
      adjustments: [],
      // One, because one poster gets to the Shopper one way — and it says what `physical`
      // answered at Capture rather than asking the Strategy again (ADR-0014).
      fulfilments: [
        {
          id: expect.any(String),
          strategy: "physical",
          requiresShipping: true,
          tracksInventory: true,
          hasLeadTime: false,
          // Nothing has moved it, which is where Capture leaves one (#320).
          state: "pending",
          trackingReference: null,
          lineItemIds: [expect.any(String)],
        },
      ],
      // Where it went, and `null` because this Cart carried no Address — the ordinary Cart.
      // What a Merchant sees when there is one is `an-order-remembers-where-it-went.test.ts`.
      address: null,
      metadata: {},
      payment: {
        id: expect.any(String),
        provider: "test",
        reference: expect.any(String),
        amount: 2500,
        currency: "USD",
        received: true,
        createdAt: expect.any(String),
      },
      createdAt: expect.any(String),
    });
  });

  it("shows each Adjustment as its own line, on the line and on the Order", async () => {
    // Core attaches no Adjustment of its own, so a test about seeing one has to wire the Step
    // that adds it — which is exactly what a Plugin or a Project does (ADR-0022).
    const handling = defineStep(
      "handling-and-a-voucher",
      (input: PricedLines): AdjustedLines => ({
        cart: input.cart,
        lines: input.lines.map((line) => ({
          ...line,
          adjustments: [{ code: "handling", description: "Handling", amount: 200 }],
        })),
        adjustments: [{ code: "voucher", description: "Welcome voucher", amount: -500 }],
      }),
    );
    await using kobai = await createTestKobai({
      workflows: { "place-order": { steps: { "apply-adjustments": handling } } },
    });
    const order = await seedTestOrder(kobai, { quantity: 2 });

    const response = await kobai.request(`/admin/orders/${order.id}`, {
      headers: order.catalog.merchant.headers,
    });

    const opened = (await response.json()) as {
      total: number;
      adjustments: { code: string; amount: number }[];
      lineItems: {
        unitAmount: number;
        total: number;
        adjustments: { code: string; amount: number }[];
      }[];
    };
    // A line rather than a number folded into an amount: the unit amount still says what one of
    // it cost, and the totals account for both Adjustments — 1250 × 2, plus 200, less 500.
    expect(opened.lineItems[0]?.unitAmount).toBe(1250);
    expect(opened.lineItems[0]?.adjustments).toEqual([
      expect.objectContaining({ code: "handling", amount: 200 }),
    ]);
    expect(opened.lineItems[0]?.total).toBe(2700);
    expect(opened.adjustments).toEqual([
      expect.objectContaining({ code: "voucher", amount: -500 }),
    ]);
    expect(opened.total).toBe(2200);
  });

  it("reads back exactly what the storefront that placed it reads", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);

    const admin = await kobai.request(`/admin/orders/${order.id}`, {
      headers: order.catalog.merchant.headers,
    });
    const storefront = await kobai.request(`/store/orders/${order.id}`, {
      headers: order.apiKey.headers,
    });

    // One record, and two credentials for reading it. A Merchant answering a question about an
    // Order should be looking at what the Shopper is looking at.
    await expect(admin.json()).resolves.toEqual(await storefront.json());
  });

  it("answers 404 for an Order that does not exist, and for an id that is not one", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "the-order-number"]) {
      const response = await kobai.request(`/admin/orders/${id}`, {
        headers: merchant.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "order-not-found",
      });
    }
  });
});

describe("reading the books is its own Permission", () => {
  it("refuses a Role that maintains the catalog and does not hold order:read", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const owner = order.catalog.merchant;

    // The colleague this Permission exists for: they keep the catalog, and what every Shopper
    // paid is none of their business. A Role is a row and a narrower one is a narrower row
    // (ADR-0027) — no rule about *which* Orders, anywhere. Made the way a Merchant makes one
    // since #173, rather than with `insert into core_role`.
    await kobai.request("/admin/roles", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "merchandiser",
        permissions: [PERMISSIONS.catalogRead, PERMISSIONS.catalogWrite],
      }),
    });
    await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        email: "merch@example.test",
        password: "a-long-enough-password",
        role: "merchandiser",
      }),
    });
    const { headers } = sessionOf(
      await kobai.request("/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "merch@example.test",
          password: "a-long-enough-password",
        }),
      }),
    );

    const list = await kobai.request("/admin/orders", { headers });
    const one = await kobai.request(`/admin/orders/${order.id}`, { headers });

    // 403 and not 404: they are signed in, and the answer names the Permission they lack
    // rather than pretending the Order is not there.
    for (const response of [list, one]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        reason: "permission-denied",
        required: PERMISSIONS.orderRead,
      });
    }
    // …and the catalog they *do* hold a Permission for still answers, so what was refused is
    // the one power rather than the whole surface.
    const products = await kobai.request("/admin/products", { headers });
    expect(products.status).toBe(200);
  });
});
