import { afterEach, describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * The store surface — what a storefront calls, gated by an API key rather than by a Merchant
 * session (ADR-0020).
 *
 * It is a second surface with a second gate, not the admin surface with a second credential.
 * The tests below say so from both directions: a key opens nothing under `/admin`, and a
 * session opens nothing under `/store`.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

describe("the store surface is not open by default", () => {
  it("refuses a request carrying no key", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-missing" });
  });

  it("refuses a key that is not a kobai key at all", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: { authorization: "Bearer not-a-kobai-key" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-malformed" });
  });

  it("refuses a well-formed key nobody issued", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: { authorization: `Bearer kobai_sk_${"a".repeat(43)}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-unknown" });
  });

  it("refuses a revoked key on the very next request", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const before = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    await kobai.request(`/admin/api-keys/${catalog.apiKey.id}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    const after = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(before.status).toBe(200);
    expect(after.status).toBe(401);
    await expect(after.json()).resolves.toMatchObject({ reason: "api-key-revoked" });
  });

  it("refuses a Merchant session, which is the other surface's credential", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const path = `/store/variants/${catalog.variantId}/price`;

    const asCookie = await kobai.request(path, { headers: catalog.merchant.headers });
    // And the value inside the cookie, handed over the way a key is. A browser would never
    // do this — the cookie is scoped to the admin surface — but the gate must refuse it,
    // because "neither credential is worth anything on the other surface" (ADR-0020) is a
    // property of the gate rather than of the browser that usually calls it.
    const asBearer = await kobai.request(path, {
      headers: { authorization: `Bearer ${catalog.merchant.token}` },
    });

    expect(asCookie.status).toBe(401);
    expect(asBearer.status).toBe(401);
    // `missing` for the cookie: a Merchant session is a cookie now (ADR-0032) and this gate
    // reads `Authorization`, so a session presented that way is not a badly-shaped key — it
    // is no key at all. The bare token still reads `malformed`, because a key carries a
    // prefix and a session token carries none.
    await expect(asCookie.json()).resolves.toMatchObject({ reason: "api-key-missing" });
    await expect(asBearer.json()).resolves.toMatchObject({ reason: "api-key-malformed" });
  });

  it("answers an unrouted store path in the same shape as every other refusal", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request("/store/nothing-here", {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-found" });
  });

  it("refuses an unrouted store path before saying whether it is there", async () => {
    // The gate is on the sub-app, so it runs first: an anonymous caller cannot map the
    // surface by watching which paths 404 and which 401.
    kobai = await createTestKobai();

    const response = await kobai.request("/store/nothing-here");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-missing" });
  });
});

describe("the store surface exposes no Merchant-only capability", () => {
  it("opens nothing under /admin", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const path of ["/admin/store", "/admin/products", "/admin/session"]) {
      const response = await kobai.request(path, { headers: catalog.apiKey.headers });
      expect(response.status, path).toBe(401);
    }
  });

  it("serves the price and nothing else about the catalog", async () => {
    // The whole surface, enumerated: one route. Anything a Merchant does — creating a
    // Product, listing the catalog, minting a key — is not reachable with a key at all.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const path of ["/store/products", "/store/api-keys", "/store/store"]) {
      const response = await kobai.request(path, { headers: catalog.apiKey.headers });
      expect(response.status, path).toBe(404);
    }
  });
});

describe("resolving a price", () => {
  it("answers with the Variant's price, and with the Steps that ran", async () => {
    kobai = await createTestKobai();
    // Both the SKU and the amount are named here rather than defaulted, because the whole
    // response is asserted below and every field in it should come from this test.
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      variant: { id: catalog.variantId, sku: "POSTER-A2" },
      price: { id: expect.any(String), amount: 1250, currency: "USD" },
      // Not a debugging nicety: this is what makes replacing a Step demonstrable rather
      // than asserted, so it is part of the response contract.
      workflow: {
        name: "resolve-price",
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "select-price" },
        ],
      },
    });
  });

  it("accepts a publishable key as readily as a secret one", async () => {
    // A price is what a browser is allowed to know, which is what a publishable key is for.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: publishable.headers,
    });

    expect(response.status).toBe(200);
  });

  it("takes the newest Price when a Variant has several", async () => {
    // The placeholder rule, and it is visible as one: nothing yet distinguishes two Prices
    // in the same currency, because Region, Channel, quantity and customer group do not
    // exist. `select-price` is where that rule lives, and where a Project replaces it.
    kobai = await createTestKobai();
    // Both amounts stay in the test, because which one is served is what it is about; 900
    // is the newer, being the second set.
    const catalog = await seedTestCatalog(kobai, { prices: [1250, 900] });

    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    const body = (await response.json()) as { price: { amount: number } };
    expect(body.price.amount).toBe(900);
  });

  it("says which Step refused when the Variant has no Price", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    // A second Product, priced by nobody, in a Store where the first one *is* priced — so
    // what the refusal is about is this Variant carrying no Price rather than an empty
    // catalog. The Merchant is handed over because a deployment has only ever one first one.
    const unpriced = await seedTestCatalog(kobai, {
      merchant: catalog.merchant,
      title: "Unpriced",
      variants: [{ sku: "UNPRICED", prices: [] }],
    });

    const response = await kobai.request(`/store/variants/${unpriced.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "price-not-set",
      workflow: { name: "resolve-price", failed: "select-price" },
    });
  });

  it("accepts inputs Core does not model, and resolves the price regardless", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?leadTimeDays=10`,
      { headers: catalog.apiKey.headers },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { price: { amount: number } };
    expect(body.price.amount).toBe(1250);
  });

  it("refuses a Variant that does not exist, and one that is not an identifier", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/variants/${id}/price`, {
        headers: catalog.apiKey.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "variant-not-found",
      });
    }
  });
});
