import { afterEach, describe, expect, it } from "vitest";
import type { PaidOrder, ReservedLines } from "../order/place-order.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";

/**
 * Deleting a catalog entry, and the property the routes exist to make provable.
 *
 * ADR-0009 says an Order's Line Items snapshot everything precisely so that catalog data
 * stays freely deletable, and until these routes existed that claim could only be checked by
 * issuing SQL — which proves it about the schema rather than about the surface a Merchant
 * actually has. Everything here goes through the public HTTP API for that reason.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

describe("an Order does not depend on the catalog it was placed from", () => {
  it("stays intact, correct and readable when its Variant is deleted", async () => {
    kobai = await createTestKobai();
    // Two Variants, so that deleting the one the Order was placed for is a Variant deletion
    // rather than the last-Variant refusal below.
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const order = await seedTestOrder(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2", quantity: 2 }],
    });
    const merchant = order.catalog.merchant.headers;

    const before = await (
      await kobai.request(`/admin/orders/${order.id}`, { headers: merchant })
    ).json();

    const deleted = await kobai.request(`/admin/variants/${order.catalog.variantId}`, {
      method: "DELETE",
      headers: merchant,
    });
    expect(deleted.status).toBe(204);

    const response = await kobai.request(`/admin/orders/${order.id}`, {
      headers: merchant,
    });
    expect(response.status).toBe(200);
    const after = await response.json();

    // Everything the Order says about what was bought is its own snapshot, so the only field
    // that may move is the navigation reference — which is now `null`, because there is
    // nothing left to navigate to.
    expect(after).toEqual({
      ...(before as object),
      lineItems: (before as { lineItems: { variantId: string | null }[] }).lineItems.map(
        (line) => ({ ...line, variantId: null }),
      ),
    });
  });

  it("stays intact when the whole Product it was placed from is deleted", async () => {
    kobai = await createTestKobai();
    const order = await seedTestOrder(kobai, { quantity: 3 });
    const merchant = order.catalog.merchant.headers;

    const deleted = await kobai.request(`/admin/products/${order.catalog.productId}`, {
      method: "DELETE",
      headers: merchant,
    });
    expect(deleted.status).toBe(204);

    const response = await kobai.request(`/admin/orders/${order.id}`, {
      headers: merchant,
    });

    expect(response.status).toBe(200);
    // The figures are the Order's own, and the SKU and title are the words the catalog used
    // on the day it was bought. Nothing here is a join, so nothing here moved.
    await expect(response.json()).resolves.toMatchObject({
      number: order.number,
      total: order.total,
      lineItems: [
        {
          variantId: null,
          sku: "POSTER-A2",
          title: "A poster",
          unitAmount: 1250,
          quantity: 3,
          total: 3750,
        },
      ],
    });
  });
});

describe("DELETE /admin/variants/{id}/prices/{priceId}", () => {
  it("removes one Price and leaves the Variant's others", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250, 900] });
    const headers = catalog.merchant.headers;
    const [sale] = catalog.variant("POSTER-A2").prices;

    const deleted = await kobai.request(
      `/admin/variants/${catalog.variantId}/prices/${sale?.id}`,
      { method: "DELETE", headers },
    );

    expect(deleted.status).toBe(204);
    await expect(
      (await kobai.request(`/admin/products/${catalog.productId}`, { headers })).json(),
    ).resolves.toMatchObject({ variants: [{ prices: [{ amount: 900 }] }] });
  });

  it("leaves a Variant with no Price at all, which stops it being sold", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const [only] = catalog.variant("POSTER-A2").prices;

    const deleted = await kobai.request(
      `/admin/variants/${catalog.variantId}/prices/${only?.id}`,
      { method: "DELETE", headers: catalog.merchant.headers },
    );

    // A Variant with no Price is a state the API already produces at creation, so removing
    // the last one is not a refusal. It is also the immediate way to stop selling something:
    // an unpriced Variant cannot be quoted and cannot be put in a Cart.
    expect(deleted.status).toBe(204);
    const quoted = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    expect(quoted.status).toBe(404);
    await expect(quoted.json()).resolves.toMatchObject({ reason: "price-not-set" });
  });

  it("answers 404 for a Price of a different Variant", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const headers = catalog.merchant.headers;
    const [mugPrice] = catalog.variant("MUG").prices;

    const response = await kobai.request(
      `/admin/variants/${catalog.variantId}/prices/${mugPrice?.id}`,
      { method: "DELETE", headers },
    );

    // The Price is addressed through the Variant it prices, so one belonging to another
    // Variant is not found here — rather than deleted from under a Variant nobody named.
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "price-not-found" });
    await expect(
      (await kobai.request(`/admin/products/${catalog.productId}`, { headers })).json(),
    ).resolves.toMatchObject({
      variants: [{ sku: "MUG", prices: [{ amount: 400 }] }, { sku: "POSTER-A2" }],
    });
  });

  it("answers 404 for a Variant that does not exist", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const [only] = catalog.variant("POSTER-A2").prices;

    const response = await kobai.request(
      `/admin/variants/2f1b8a5e-0000-4000-8000-000000000000/prices/${only?.id}`,
      { method: "DELETE", headers: catalog.merchant.headers },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "variant-not-found",
    });
  });
});

describe("DELETE /admin/products/{id}", () => {
  it("takes every Variant of the Product with it, and leaves the others alone", async () => {
    kobai = await createTestKobai();
    const doomed = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const headers = doomed.merchant.headers;
    const kept = await seedTestCatalog(kobai, {
      title: "A mug",
      merchant: doomed.merchant,
      variants: [{ sku: "MUG-2" }],
    });

    const deleted = await kobai.request(`/admin/products/${doomed.productId}`, {
      method: "DELETE",
      headers,
    });

    expect(deleted.status).toBe(204);
    await expect(
      (await kobai.request(`/admin/products/${doomed.productId}`, { headers })).status,
    ).toBe(404);
    await expect(
      (await kobai.request("/admin/products", { headers })).json(),
    ).resolves.toEqual({
      products: [{ id: kept.productId, title: "A mug", metadata: {} }],
    });
  });

  it("answers 404 for a Product that does not exist, and for an id that is not one", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["2f1b8a5e-0000-4000-8000-000000000000", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/products/${id}`, {
        method: "DELETE",
        headers: catalog.merchant.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "product-not-found",
      });
    }
  });
});

describe("DELETE /admin/variants/{id}", () => {
  it("takes the Variant's Prices and its stock count with it", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250, 900] }, { sku: "MUG", prices: [400] }],
    });
    const headers = catalog.merchant.headers;
    await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand: 7 }),
    });

    const deleted = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "DELETE",
      headers,
    });

    expect(deleted.status).toBe(204);
    const product = await (
      await kobai.request(`/admin/products/${catalog.productId}`, { headers })
    ).json();
    // The Product is still there, and so is the Variant that was not asked about.
    expect(product).toMatchObject({
      variants: [{ sku: "MUG", prices: [{ amount: 400 }] }],
    });
  });

  it("takes the line a Cart was holding for it, and leaves the Cart readable", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
    });

    const deleted = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });

    expect(deleted.status).toBe(204);
    // A Cart is mutable, disposable and unauthoritative (ADR-0009), so the line goes with the
    // thing it selected rather than being kept as a line nobody can buy. What must not happen
    // is the Cart becoming unreadable, because a Shopper is looking at it.
    const response = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      lineItems: [{ variant: { sku: "MUG" }, quantity: 2 }],
    });
  });

  it("refuses to delete a Product's only Variant, and leaves it there", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = catalog.merchant.headers;

    const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "DELETE",
      headers,
    });

    // ADR-0008: every Product has at least one Variant, and creation makes the zero-Variant
    // state unreachable. A delete that quietly took the Product with it would be deleting a
    // resource the caller did not address, so this is a refusal rather than a cascade.
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "last-variant" });
    await expect(
      (await kobai.request(`/admin/products/${catalog.productId}`, { headers })).json(),
    ).resolves.toMatchObject({ variants: [{ sku: "POSTER-A2" }] });
  });

  it("answers 404 for a Variant that does not exist, and for an id that is not one", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["2f1b8a5e-0000-4000-8000-000000000000", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/variants/${id}`, {
        method: "DELETE",
        headers: catalog.merchant.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "variant-not-found",
      });
    }
  });
});

describe("a Variant whose stock is claimed while an Order is being placed", () => {
  it("is refused, through its Product as well as directly, until the claim ends", async () => {
    const paused = pause();
    kobai = await createTestKobai({
      workflows: { "place-order": { after: { "hold-reservations": [paused.step] } } },
    });
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const headers = catalog.merchant.headers;
    await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand: 3 }),
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placing = kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    await paused.reached;

    // The same refusal `PUT /admin/variants/{id}/inventory` already makes about the same
    // units: they are spoken for, and they either become an Order or lapse. Deleting the
    // Variant out from under a Shopper who is about to be charged for it is the one thing
    // here that could not be undone.
    const variantRefusal = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "DELETE",
      headers,
    });
    expect(variantRefusal.status).toBe(409);
    await expect(variantRefusal.json()).resolves.toMatchObject({
      reason: "stock-is-reserved",
    });

    // …and the Product route is not a way around it, or the refusal would be one call wide.
    const productRefusal = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "DELETE",
      headers,
    });
    expect(productRefusal.status).toBe(409);
    await expect(productRefusal.json()).resolves.toMatchObject({
      reason: "stock-is-reserved",
    });

    paused.release();
    expect((await placing).status).toBe(201);

    // The claim has become an Order, so nothing is holding the Variant here any more.
    const deleted = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "DELETE",
      headers,
    });
    expect(deleted.status).toBe(204);
  });
});

describe("a Variant deleted while an Order for it is being captured", () => {
  it("is placed anyway, with the line saying what was bought and pointing at nothing", async () => {
    const paused = pause<PaidOrder>();
    kobai = await createTestKobai({
      workflows: { "place-order": { after: { "take-payment": [paused.step] } } },
    });
    // Nobody has counted this Variant, so no Reservation was held for it and the delete is not
    // refused — which is exactly the Variant this race can still reach. A `digital` one is the
    // other, for the Strategy's reason rather than for want of a count.
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placing = kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    await paused.reached;

    const deleted = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    expect(deleted.status).toBe(204);

    paused.release();
    const placed = await placing;

    // The Shopper has paid, so the Order has to exist. It carries the snapshot Capture took
    // and no reference to a Variant that is no longer there — the state ADR-0009's nullable
    // `variant_id` is for, arrived at by the API rather than by a cascade nobody watched.
    expect(placed.status).toBe(201);
    await expect(placed.json()).resolves.toMatchObject({
      lineItems: [
        { variantId: null, sku: "POSTER-A2", unitAmount: 1250, quantity: 2, total: 2500 },
      ],
    });
  });
});

/**
 * A Step that stops a placement where a test wants to look at what the hold did.
 *
 * A factory rather than the single-use one in `reservation.test.ts`, because a test that
 * releases it and then goes on asserting needs one of its own.
 */
function pause<Carried = ReservedLines>() {
  let reached = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    step: defineStep("pause", async (input: Carried): Promise<Carried> => {
      reached();
      await held;
      return input;
    }),
    reached: arrived,
    release: () => {
      release();
    },
  };
}
