import { describe, expect, it } from "vitest";
import { createTestKobai } from "./kobai.ts";
import { signInTestMerchant } from "./merchant.ts";
import {
  MIXED_ORDER_DIGITAL_SKU,
  MIXED_ORDER_PHYSICAL_SKU,
  seedTestMixedOrder,
} from "./mixed-order.ts";

/**
 * The mixed-Order seam of `@kobai/core/testing`, asserted at the surface it promises.
 *
 * This helper is promised surface under ADR-0019 and ADR-0047, so what it arranges is asked of
 * the **running application** rather than of the object it hands back — an assertion against its
 * own return value would agree with itself however wrong the arrangement was. That matters more
 * here than for most of these: the whole value of the helper is that the Order it places has
 * **two** Fulfilments, and nothing about the shape it returns says so.
 */

/** As much of an Order as this file reads. */
type OrderBody = {
  readonly lineItems: readonly { readonly id: string; readonly sku: string }[];
  readonly fulfilments: readonly {
    readonly strategy: string;
    readonly requiresShipping: boolean;
    readonly state: string;
    readonly lineItemIds: readonly string[];
  }[];
};

describe("seedTestMixedOrder", () => {
  it("places one Order carrying both a physical line and a digital one", async () => {
    await using kobai = await createTestKobai();

    const order = await seedTestMixedOrder(kobai);

    const response = await kobai.request(`/store/orders/${order.id}`, {
      headers: order.apiKey.headers,
    });
    expect(response.status).toBe(200);
    const placed = (await response.json()) as OrderBody;

    expect(placed.lineItems.map((line) => line.sku).toSorted()).toEqual(
      [MIXED_ORDER_DIGITAL_SKU, MIXED_ORDER_PHYSICAL_SKU].toSorted(),
    );
    // **Two Fulfilments on one Order**, which is the whole reason this helper exists: the two
    // Strategies answer differently, so Capture writes a row each rather than grouping them.
    expect(placed.fulfilments).toHaveLength(2);
    expect(
      placed.fulfilments.map((one) => [one.strategy, one.requiresShipping]).toSorted(),
    ).toEqual(
      [
        ["digital", false],
        ["physical", true],
      ].toSorted(),
    );
    // And nothing has moved either of them, which is where Capture leaves one.
    expect(placed.fulfilments.every((one) => one.state === "pending")).toBe(true);
  });

  it("puts each line under the Fulfilment its own Strategy produced", async () => {
    // The half a count cannot see: two Fulfilments that both covered the poster would satisfy
    // every assertion above, and would make "each moves independently" a claim about nothing.
    await using kobai = await createTestKobai();

    const order = await seedTestMixedOrder(kobai);

    const response = await kobai.request(`/store/orders/${order.id}`, {
      headers: order.apiKey.headers,
    });
    const placed = (await response.json()) as OrderBody;
    const lineFor = (sku: string) => {
      const line = placed.lineItems.find((one) => one.sku === sku);
      if (!line) throw new Error(`this Order has no line for ${sku}`);
      return line.id;
    };
    const strategyCovering = (sku: string) =>
      placed.fulfilments.find((one) => one.lineItemIds.includes(lineFor(sku)))?.strategy;

    expect(strategyCovering(MIXED_ORDER_PHYSICAL_SKU)).toBe("physical");
    expect(strategyCovering(MIXED_ORDER_DIGITAL_SKU)).toBe("digital");
  });

  it("takes a Merchant that is already signed in", async () => {
    // A deployment has only ever one first Merchant (ADR-0041), so a test that signed one in
    // before reaching for this has to be able to hand them over.
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const order = await seedTestMixedOrder(kobai, { merchant });

    expect(order.catalog.merchant.token).toBe(merchant.token);
    const response = await kobai.request(`/admin/orders/${order.id}`, {
      headers: merchant.headers,
    });
    expect(response.status).toBe(200);
  });

  it("counts no stock, so neither line holds a Reservation", async () => {
    // A Variant nobody has counted sells freely and holds nothing (ADR-0018), which is what
    // every test that is not about stock wants — and a test that *is* about stock says so with
    // `PUT /admin/variants/{id}/inventory`, in the open.
    await using kobai = await createTestKobai();

    const order = await seedTestMixedOrder(kobai);

    const response = await kobai.request(`/admin/products/${order.catalog.productId}`, {
      headers: order.catalog.merchant.headers,
    });
    const product = (await response.json()) as {
      readonly variants: readonly { readonly inventory: unknown }[];
    };
    expect(product.variants.map((one) => one.inventory)).toEqual([null, null]);
  });
});
