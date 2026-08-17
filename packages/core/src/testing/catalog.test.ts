import { describe, expect, it } from "vitest";
import { seedTestCatalog } from "./catalog.ts";
import { createTestKobai } from "./kobai.ts";
import { signInTestMerchant } from "./merchant.ts";

/**
 * The catalog seam of `@kobai/core/testing`, asserted at the surface it promises.
 *
 * This helper is promised surface under ADR-0019, so what it seeds is asked of the running
 * application rather than of the object it hands back — an assertion against its own return
 * value would agree with itself however wrong the arrangement was.
 */

describe("seeding a catalog", () => {
  it("gives an untold test one Product, one Variant and one Price to sell", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai);

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      title: "A poster",
      variants: [
        {
          id: catalog.variantId,
          sku: "POSTER-A2",
          prices: [{ amount: 1250, currency: "USD" }],
        },
      ],
    });
  });

  it("hands back a key that opens the store surface on what it seeded", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai);

    const resolved = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      price: { amount: 1250, currency: "USD" },
    });
  });

  it("prices one Variant several times when a test names several amounts", async () => {
    // A Price is a row (ADR-0008), so this is the arrangement a test about *selection*
    // needs — and it must not have to abandon the helper to get it.
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, { prices: [1250, 900] });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    const body = (await product.json()) as {
      variants: { prices: { amount: number }[] }[];
    };
    expect(body.variants[0]?.prices.map((price) => price.amount)).toEqual([1250, 900]);
  });

  it("leaves a Variant unpriced when a test asks for no Prices at all", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, { prices: [] });

    const resolved = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    expect(resolved.status).toBe(404);
    await expect(resolved.json()).resolves.toMatchObject({ reason: "price-not-set" });
  });

  it("seeds several Variants under one Product, and finds each by its SKU", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [] }],
    });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    // A Product reports its Variants in SKU order rather than in the order they were asked
    // for, which is why the helper is asked for one by SKU and never by position.
    const body = (await product.json()) as {
      variants: { id: string; sku: string; prices: unknown[] }[];
    };
    expect(body.variants).toEqual([
      expect.objectContaining({ id: catalog.variant("MUG").id, sku: "MUG", prices: [] }),
      expect.objectContaining({
        id: catalog.variant("POSTER-A2").id,
        sku: "POSTER-A2",
        prices: [expect.objectContaining({ amount: 1250 })],
      }),
    ]);
    // The first one *asked for*, because a test with one Variant should not have to say
    // which — and that is not the first one the API answers with here.
    expect(catalog.variantId).toBe(catalog.variant("POSTER-A2").id);
  });

  it("seeds into a Store a test has already signed a Merchant into", async () => {
    // The first Merchant is seeded once and only once (#25), so a helper that always
    // signed one in would be unusable by any test that already had a session.
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const catalog = await seedTestCatalog(kobai, { merchant });

    expect(catalog.merchant.token).toBe(merchant.token);
    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: merchant.headers,
    });
    expect(product.status).toBe(200);
  });

  it("refuses to be told the same thing twice", () => {
    const seed = async () => {
      await using kobai = await createTestKobai();
      return seedTestCatalog(kobai, {
        prices: [1250],
        // @ts-expect-error `prices` is the one-Variant shorthand for `variants`.
        variants: [{ prices: [900] }],
      });
    };

    expect(seed).toBeDefined();
  });
});
