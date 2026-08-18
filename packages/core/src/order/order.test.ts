import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  type TestKobai,
} from "../testing/index.ts";

/**
 * Placing an Order, on the store surface a storefront actually calls.
 *
 * One request turns a Cart into an Order and the whole Order comes back, because a
 * confirmation page should render without a second round trip. Everything here is dispatched
 * at the public API against a real Postgres: an API key, a Cart identifier, and no Shopper of
 * any kind (ADR-0020).
 */

/** What a storefront sends: the Cart, and nothing else it has to orchestrate. */
async function placeOrder(
  kobai: TestKobai,
  headers: Record<string, string>,
  cartId: string,
): Promise<Response> {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

describe("a Cart becomes an Order", () => {
  it("answers with the whole Order, its snapshot Line Items included", async () => {
    await using kobai = await createTestKobai();
    // The title, the SKU and the amount are all named here rather than defaulted, because
    // the whole response is asserted below and every field in it should come from this test.
    const catalog = await seedTestCatalog(kobai, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await placeOrder(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      // Distinct from `id`, and what a Shopper reads over the phone.
      number: expect.any(Number),
      shopper: null,
      currency: "USD",
      total: 2500,
      lineItems: [
        {
          id: expect.any(String),
          // Navigation only. Everything a person reads is snapshotted beside it (ADR-0009).
          variantId: catalog.variantId,
          title: "A poster",
          sku: "POSTER-A2",
          unitAmount: 1250,
          quantity: 2,
          // Zero until the tax spec replaces `calculate-tax`. The field is here now so that
          // adding tax later is not a change to what an Order means.
          tax: 0,
          // Core attaches no Adjustment of its own, and says so with an empty list rather than
          // an absent field — a discount or a surcharge is a line here (ADR-0022).
          adjustments: [],
          total: 2500,
          metadata: {},
        },
      ],
      adjustments: [],
      metadata: {},
      // The money, recorded against the Order — for the total, and by whatever this deployment
      // was wired to take it with. A placed Order is a paid Order (ADR-0053).
      payment: {
        id: expect.any(String),
        provider: "test",
        reference: expect.any(String),
        amount: 2500,
        currency: "USD",
        // The money arrived, because this provider took it. A provider that arranges payment
        // out of band says so and this reads `false` — see `payment/payment.test.ts`.
        received: true,
        createdAt: expect.any(String),
      },
      createdAt: expect.any(String),
      // Not a debugging nicety: this is what lets a Developer who replaced a Step see that
      // theirs ran, so it is part of the response contract.
      workflow: {
        name: "place-order",
        steps: [
          { step: "load-cart", implementation: "load-cart" },
          { step: "price-lines", implementation: "price-lines" },
          { step: "apply-adjustments", implementation: "apply-adjustments" },
          { step: "calculate-tax", implementation: "calculate-tax" },
          { step: "hold-reservations", implementation: "hold-reservations" },
          { step: "take-payment", implementation: "take-payment" },
          { step: "capture-order", implementation: "capture-order" },
        ],
      },
    });
  });

  it("reports several lines in SKU order, whatever order they were selected in", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "POSTER-A2", prices: [1250] },
        { sku: "MUG", prices: [400] },
      ],
    });
    // Added the other way round on purpose. Capture writes every line in one transaction, so
    // there is no moment that distinguishes them and nothing to recover selection order from —
    // an Order reports its lines the way a Product reports its Variants, and a storefront reads
    // one by its SKU rather than by position.
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
    });

    const response = await placeOrder(kobai, cart.apiKey.headers, cart.id);
    const order = (await response.json()) as {
      total: number;
      lineItems: readonly { sku: string; total: number }[];
    };

    expect(order.lineItems.map((line) => line.sku)).toEqual(["MUG", "POSTER-A2"]);
    expect(order.total).toBe(2050);
  });

  it("reads back the same lines in the same order a second time", async () => {
    // Stable across reads as well as within one, which is the half a single response cannot
    // show: a `GET` that reordered the lines would make a confirmation page and a receipt
    // disagree about an Order that never changed.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "POSTER-A2", prices: [1250] },
        { sku: "MUG", prices: [400] },
      ],
    });
    const placed = await seedTestOrder(kobai, {
      catalog,
      lines: [{ sku: "MUG" }, { sku: "POSTER-A2" }],
    });

    const read = (await (
      await kobai.request(`/store/orders/${placed.id}`, {
        headers: placed.apiKey.headers,
      })
    ).json()) as { lineItems: readonly { sku: string }[] };

    expect(read.lineItems.map((line) => line.sku)).toEqual(
      placed.lineItems.map((line) => line.sku),
    );
  });

  it("reads back over a secret key, so reloading a confirmation needs no cache", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const placed = await placeOrder(kobai, cart.apiKey.headers, cart.id);
    const order = (await placed.json()) as { id: string; workflow: unknown };

    const read = await kobai.request(`/store/orders/${order.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(read.status).toBe(200);
    // The same Order, minus the account of the run that produced it: which Steps ran is a
    // fact about one request, not about the record.
    const { workflow: _ran, ...record } = order;
    await expect(read.json()).resolves.toEqual(record);
  });

  it("carries the Shopper a storefront asserted, and the Cart's own data", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, {
      shopper: { email: "shopper@example.com", externalId: "shopper-1" },
    });
    await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { giftMessage: "Happy birthday" } }),
    });

    const response = await placeOrder(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      shopper: { email: "shopper@example.com", externalId: "shopper-1" },
      metadata: { giftMessage: "Happy birthday" },
    });
  });

  it("gives each Order a number that increases and is not its identifier", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const one = await seedTestOrder(kobai, { catalog });
    const two = await seedTestOrder(kobai, { catalog });

    expect(two.number).toBeGreaterThan(one.number);
    // Two identifiers, on purpose: one is the row's and one is the Shopper's. Gapless is
    // deliberately not promised — that is an invoicing requirement, and invoicing is not
    // Core's.
    expect(String(one.number)).not.toBe(one.id);
  });
});

/**
 * What becomes of a Cart once it has been placed — **it is spent** (#102).
 *
 * A Cart is mutable, disposable and unauthoritative (ADR-0009), and the Order it becomes is
 * none of those things. So the moment it produces one it stops being a Cart anybody can act
 * on: it still reads, the way an expired one does, and every further request against it is
 * refused. The alternative — leaving it placeable — is a second Order from one selection, which
 * is a second charge and a second claim on stock for a Shopper who pressed the button twice.
 */
describe("a Cart is spent by the Order it became", () => {
  it("refuses to place the same Cart a second time", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const first = await placeOrder(kobai, cart.apiKey.headers, cart.id);
    const second = await placeOrder(kobai, cart.apiKey.headers, cart.id);

    expect(first.status).toBe(201);
    // 409 like an expired Cart, and for the same kind of reason: the request is well formed
    // and this Cart is no longer in a state that can produce an Order.
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      reason: "cart-placed",
      workflow: { name: "place-order", failed: "load-cart" },
    });
    // Asserted against the database rather than the response: what matters is that a second
    // Order was never written, not that a second request was answered tidily.
    await expect(kobai.database.query("select id from core_order")).resolves.toHaveLength(
      1,
    );
  });

  /**
   * The half a sequential test cannot reach: two requests that both find no Order.
   *
   * The check in `load-cart` is a courtesy — it stops a doomed run before anything is priced —
   * and it is not what makes the rule true. What makes it true is the unique index the Order is
   * written against, so this is dispatched concurrently on purpose: every one of these requests
   * gets past the check, and the database is the only thing standing between them and four
   * Orders for one selection.
   */
  it("writes one Order when several requests place the same Cart at once", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () => placeOrder(kobai, cart.apiKey.headers, cart.id)),
    );

    // Exactly one placed it, and the others were refused rather than met with a 500 — a
    // constraint violation reaching a storefront as a broken server would be this rule holding
    // by accident.
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409, 409, 409,
    ]);
    for (const refused of responses.filter((response) => response.status === 409)) {
      await expect(refused.json()).resolves.toMatchObject({ reason: "cart-placed" });
    }
    await expect(kobai.database.query("select id from core_order")).resolves.toHaveLength(
      1,
    );
  });
});

describe("an Order does not depend on the catalog it was placed from", () => {
  it("survives the Variant being deleted, with its snapshot intact", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });
    const order = await seedTestOrder(kobai, { catalog });

    // In SQL, because there is no route that deletes a Product yet — and because a Merchant
    // deleting a row directly is the writer ADR-0004 says is the normal case rather than the
    // exception. ADR-0009 keeps catalog data freely deletable *because* an Order depends on
    // none of it; the foreign key is what has to give way, not the Order.
    await kobai.database.query("delete from core_product where id = $1", [
      catalog.productId,
    ]);

    const read = await kobai.request(`/store/orders/${order.id}`, {
      headers: catalog.apiKey.headers,
    });

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      total: 1250,
      lineItems: [
        {
          // The reference is gone, because the Variant is. Everything a person reads is not.
          variantId: null,
          title: "A poster",
          sku: "POSTER-A2",
          unitAmount: 1250,
          quantity: 1,
        },
      ],
    });
  });
});

describe("placing an Order needs a secret key", () => {
  it("refuses a publishable key, which is the one a browser holds", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });
    // Built over the browser's key, because that is the storefront pattern ADR-0020 keeps
    // working: a publishable key builds and reads a Cart and cannot place it.
    const cart = await seedTestCart(kobai, { catalog, apiKey: publishable });

    const response = await placeOrder(kobai, publishable.headers, cart.id);

    // 403 rather than 401: the credential is valid and insufficient.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "secret-key-required",
    });
  });

  it("refuses a publishable key reading an Order back, too", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });
    const order = await seedTestOrder(kobai, { catalog });

    const response = await kobai.request(`/store/orders/${order.id}`, {
      headers: publishable.headers,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "secret-key-required",
    });
  });

  it("refuses before saying whether the Order is there", async () => {
    // The gate answers first, so a publishable key cannot be used to find out which Order
    // identifiers exist.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    const response = await kobai.request("/store/orders/not-an-order", {
      headers: publishable.headers,
    });

    expect(response.status).toBe(403);
  });
});

describe("what placing an Order refuses", () => {
  it("refuses a Cart that does not exist, and one that is not an identifier", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const cartId of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await placeOrder(kobai, catalog.apiKey.headers, cartId);

      expect(response.status, cartId).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "cart-not-found",
        workflow: { name: "place-order", failed: "load-cart" },
      });
    }
  });

  it("refuses an expired Cart", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    // Time passed, by winding the row back rather than by waiting: a Cart's lifetime is
    // measured in days, so this is the only honest way to reach the far side of one.
    await kobai.database.query(
      "update core_cart set expires_at = now() - interval '1 second' where id = $1",
      [cart.id],
    );

    const response = await placeOrder(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-expired" });
  });

  it("refuses an empty Cart, so no Order exists with nothing in it", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { lines: [] });

    const response = await placeOrder(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-empty" });
  });

  it("refuses a line whose Variant lost its Price after it was selected", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });
    // A Cart refuses an unpriced Variant when the line is added, so the only way to reach
    // this is for the Merchant to remove the Price afterwards — which is exactly why the
    // price is resolved at Capture rather than trusted from the Cart.
    const price = catalog.variants[0]?.prices[0];
    if (price === undefined) throw new Error("the seeded Variant should carry a Price");
    await kobai.database.query("delete from core_price where id = $1", [price.id]);

    const response = await placeOrder(kobai, catalog.apiKey.headers, cart.id);

    // Well formed, and still refused — a 404 here would say the *Cart* is not there.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "price-not-set",
      workflow: { name: "place-order", failed: "price-lines" },
    });
  });

  it("writes no Order when a Step refuses", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { lines: [] });

    await placeOrder(kobai, cart.apiKey.headers, cart.id);

    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("refuses a request that names no Cart", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...catalog.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("answers 404 for an Order that does not exist", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/orders/${id}`, {
        headers: catalog.apiKey.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "order-not-found",
      });
    }
  });
});
