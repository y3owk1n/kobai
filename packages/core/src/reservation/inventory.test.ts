import { describe, expect, it } from "vitest";
import { createTestKobai, seedTestCatalog } from "../testing/index.ts";

/**
 * **Inventory** — the countable stock of a physical Variant, as a Merchant sets it and sees it
 * (`CONTEXT.md`, ADR-0018).
 *
 * Everything here is asserted at the public HTTP seam, because everything here is something a
 * Merchant actually does: set the stock of a Variant, and read back what the Store believes it
 * has. What a Reservation does *to* those numbers is the subject of `reservation.test.ts`; this
 * file is about the numbers themselves.
 */

describe("a Merchant's stock", () => {
  it("is untracked until a Merchant says otherwise", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });

    expect(response.status).toBe(200);
    // `null` rather than a zero: a Variant nobody has counted is not a Variant with none
    // left, and selling it is refused by neither. Stock arrives when a Merchant says it does.
    await expect(response.json()).resolves.toMatchObject({
      variants: [{ sku: "POSTER-A2", inventory: null }],
    });
  });

  it("is set on a Variant and read back with the Product", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const set = await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
      method: "PUT",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand: 7 }),
    });

    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toEqual({
      variantId: catalog.variantId,
      onHand: 7,
      reserved: 0,
      // Derived rather than stored, and reported because it is the number a Merchant is
      // actually asking about: what is left to sell.
      available: 7,
    });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      variants: [
        { sku: "POSTER-A2", inventory: { onHand: 7, reserved: 0, available: 7 } },
      ],
    });
  });

  it("is set again rather than added to, so a stock count is a statement of fact", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    await setStock(kobai, catalog.merchant.headers, catalog.variantId, 7);
    const corrected = await setStock(
      kobai,
      catalog.merchant.headers,
      catalog.variantId,
      3,
    );

    expect(corrected.status).toBe(200);
    await expect(corrected.json()).resolves.toMatchObject({ onHand: 3, available: 3 });
  });

  it("refuses a Variant that does not exist", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await setStock(
      kobai,
      catalog.merchant.headers,
      "00000000-0000-4000-8000-000000000000",
      1,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "variant-not-found",
    });
  });

  it("refuses a negative count, because there is no such stock", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await setStock(
      kobai,
      catalog.merchant.headers,
      catalog.variantId,
      -1,
    );

    expect(response.status).toBe(400);
  });
});

/** Setting stock, which every test above does and only the first one is about. */
async function setStock(
  kobai: { request: (path: string, init: RequestInit) => Promise<Response> },
  headers: Record<string, string>,
  variantId: string,
  onHand: number,
) {
  return kobai.request(`/admin/variants/${variantId}/inventory`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
}
