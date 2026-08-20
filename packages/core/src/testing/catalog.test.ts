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

  it("points every Variant it seeds at `physical` unless told otherwise", async () => {
    // The default a test that is not about fulfilment should inherit — and the one every other
    // test in this repository is quietly relying on (ADR-0014).
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai);

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      variants: [{ sku: "POSTER-A2", fulfilment: { strategy: "physical" } }],
    });
  });

  it("points one at the Strategy a test names", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }],
    });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      variants: [{ sku: "PDF", fulfilment: { strategy: "digital" } }],
    });
  });

  it("fails saying so when the deployment has not wired that Strategy", async () => {
    // The same answer a Merchant gets, rather than a helper quietly seeding something else:
    // a Plugin's Strategy is only reachable once the Project wired it (ADR-0017).
    await using kobai = await createTestKobai();

    await expect(
      seedTestCatalog(kobai, {
        variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
      }),
    ).rejects.toThrow(/unknown-fulfilment-strategy/);
  });

  it("writes the copy a Merchant wrote when a test names one", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, {
      description: "A2 or A3, matte or glossy.",
    });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      description: "A2 or A3, matte or glossy.",
    });
  });

  it("declares the options its Variants answer, in the first one's order", async () => {
    // The whole point of reading the declaration off the Variants: there is no second half to
    // disagree with, so the Product ends up declaring exactly what its Variants are.
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "POSTER-A2-MATTE", options: { Size: "A2", Finish: "Matte" } },
        { sku: "POSTER-A3-MATTE", options: { Size: "A3", Finish: "Matte" } },
      ],
    });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    const body = (await product.json()) as {
      options: readonly { name: string }[];
      variants: readonly {
        sku: string;
        options: readonly { name: string; value: string }[];
      }[];
    };
    // The order is the Merchant's, and here the first Variant's — a storefront offers them in it.
    expect(body.options.map((one) => one.name)).toEqual(["Size", "Finish"]);
    expect(
      body.variants.map((one) => [one.sku, one.options.map((held) => held.value)]),
    ).toEqual([
      ["POSTER-A2-MATTE", ["A2", "Matte"]],
      ["POSTER-A3-MATTE", ["A3", "Matte"]],
    ]);
  });

  it("declares nothing at all where no Variant answers anything", async () => {
    // A Product with no options is the ordinary case rather than the exception (ADR-0008), and
    // every other test in this file is quietly relying on this being what it gets. Several
    // Variants of one, too: a Product declaring nothing has no combinations, so there is none
    // for two of them to share — which is the same reading #277's refusal takes.
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "ONE" }, { sku: "TWO" }],
    });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      options: [],
      variants: [{ sku: "ONE" }, { sku: "TWO" }],
    });
  });

  it("refuses two Variants that answer different options, naming both", async () => {
    // `variant-options-mismatch` read from the other end: the Product declares what the first
    // Variant answers, so the second one is short. Refused before anything is sent, because a
    // 422 out of an arrangement names this helper rather than the test that called it.
    await using kobai = await createTestKobai();

    await expect(
      seedTestCatalog(kobai, {
        variants: [
          { sku: "POSTER-A2-MATTE", options: { Size: "A2", Finish: "Matte" } },
          { sku: "POSTER-A3", options: { Size: "A3" } },
        ],
      }),
    ).rejects.toThrow(/POSTER-A2-MATTE.*POSTER-A3.*variant-options-mismatch/s);
  });

  it("refuses two Variants that answer the options the same way", async () => {
    // #277's refusal, arranged rather than met: a storefront resolves a combination to one
    // Variant, so two of them answering one combination is not a catalog to seed.
    await using kobai = await createTestKobai();

    await expect(
      seedTestCatalog(kobai, {
        variants: [
          { sku: "POSTER-A2-MATTE", options: { Size: "A2", Finish: "Matte" } },
          { sku: "POSTER-A2-AGAIN", options: { Size: "A2", Finish: "Matte" } },
        ],
      }),
    ).rejects.toThrow(/POSTER-A2-MATTE.*POSTER-A2-AGAIN.*answer it \(#277\)/s);
  });

  it("groups the Product into a Collection it makes on the way", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai, { collections: ["Wall art"] });

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({
      collections: [{ id: catalog.collection("Wall art").id, title: "Wall art" }],
    });
  });

  it("puts a second catalog into the Collection the first one made", async () => {
    // Collection titles are deliberately not unique, so naming the title again would make a
    // second Collection — handing the first one back is how a test says "that one".
    await using kobai = await createTestKobai();
    const posters = await seedTestCatalog(kobai, { collections: ["Wall art"] });

    const mugs = await seedTestCatalog(kobai, {
      merchant: posters.merchant,
      title: "A mug",
      variants: [{ sku: "MUG" }],
      collections: [posters.collection("Wall art")],
    });

    const listed = await kobai.request(
      `/admin/products?collection=${posters.collection("Wall art").id}`,
      { headers: posters.merchant.headers },
    );
    const body = (await listed.json()) as { products: readonly { id: string }[] };
    expect(body.products.map((one) => one.id).toSorted()).toEqual(
      [posters.productId, mugs.productId].toSorted(),
    );
  });

  it("refuses to be asked for one Collection twice, named or handed over", async () => {
    // Two titles would be two Collections of the name, which the route takes and which leaves
    // `catalog.collection` able to answer either; the same Collection twice is `collections`
    // naming one identifier twice, which the route refuses 400.
    await using kobai = await createTestKobai();
    const posters = await seedTestCatalog(kobai, { collections: ["Wall art"] });
    const wallArt = posters.collection("Wall art");

    await expect(
      seedTestCatalog(kobai, {
        merchant: posters.merchant,
        title: "A mug",
        variants: [{ sku: "MUG" }],
        collections: ["Wall art", "Wall art"],
      }),
    ).rejects.toThrow(/"Wall art" twice/);
    await expect(
      seedTestCatalog(kobai, {
        merchant: posters.merchant,
        title: "A tote",
        variants: [{ sku: "TOTE" }],
        collections: [wallArt, wallArt],
      }),
    ).rejects.toThrow(/"Wall art" twice/);
  });

  it("is in no Collection unless a test asked, and says so when asked for one", async () => {
    await using kobai = await createTestKobai();

    const catalog = await seedTestCatalog(kobai);

    const product = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(product.json()).resolves.toMatchObject({ collections: [] });
    expect(() => catalog.collection("Wall art")).toThrow(/seeded into none/);
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
