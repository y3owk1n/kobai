import { afterEach, describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  signInTestMerchant,
  type TestKobai,
} from "../testing/index.ts";
import { openInputs } from "./store.ts";

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

type Priced = {
  readonly variantId: string;
  /** A secret key's headers, ready to ask the store surface with. */
  readonly headers: Record<string, string>;
  readonly keyId: string;
  readonly merchant: Record<string, string>;
};

/**
 * A Store holding one Variant at one Price, and a secret key to ask about it with.
 *
 * Everything goes through the public API, so nothing here can prove a capability the API
 * does not actually have.
 */
async function priced(instance: TestKobai, amount = 1250): Promise<Priced> {
  const merchant = await signInTestMerchant(instance);
  const json = { ...merchant.headers, "content-type": "application/json" };

  const product = (await (
    await instance.request("/admin/products", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "A poster", variants: [{ sku: "POSTER-A2" }] }),
    })
  ).json()) as { variants: { id: string }[] };
  const variantId = product.variants[0]?.id ?? "";

  await instance.request(`/admin/variants/${variantId}/prices`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ amount }),
  });

  const key = await createTestApiKey(instance, merchant, { name: "storefront" });

  return {
    variantId,
    headers: key.headers,
    keyId: key.id,
    merchant: merchant.headers,
  };
}

describe("the store surface is not open by default", () => {
  it("refuses a request carrying no key", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-missing" });
  });

  it("refuses a key that is not a kobai key at all", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: { authorization: "Bearer not-a-kobai-key" },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-malformed" });
  });

  it("refuses a well-formed key nobody issued", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: { authorization: `Bearer kobai_sk_${"a".repeat(43)}` },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-unknown" });
  });

  it("refuses a revoked key on the very next request", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    const before = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });
    await kobai.request(`/admin/api-keys/${store.keyId}`, {
      method: "DELETE",
      headers: store.merchant,
    });
    const after = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    expect(before.status).toBe(200);
    expect(after.status).toBe(401);
    await expect(after.json()).resolves.toMatchObject({ reason: "api-key-revoked" });
  });

  it("refuses a Merchant session, which is the other surface's credential", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.merchant,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "api-key-malformed" });
  });

  it("answers an unrouted store path in the same shape as every other refusal", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    const response = await kobai.request("/store/nothing-here", {
      headers: store.headers,
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
    const store = await priced(kobai);

    for (const path of ["/admin/store", "/admin/products", "/admin/api-keys"]) {
      const response = await kobai.request(path, { headers: store.headers });
      expect(response.status, path).toBe(401);
    }
  });

  it("serves the price and nothing else about the catalog", async () => {
    // The whole surface, enumerated: one route. Anything a Merchant does — creating a
    // Product, listing the catalog, minting a key — is not reachable with a key at all.
    kobai = await createTestKobai();
    const store = await priced(kobai);

    for (const path of ["/store/products", "/store/api-keys", "/store/store"]) {
      const response = await kobai.request(path, { headers: store.headers });
      expect(response.status, path).toBe(404);
    }
  });
});

describe("resolving a price", () => {
  it("answers with the Variant's price, and with the Steps that ran", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      variant: { id: store.variantId, sku: "POSTER-A2" },
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
    const store = await priced(kobai);
    const publishable = await createTestApiKey(
      kobai,
      { headers: store.merchant },
      { name: "browser", kind: "publishable" },
    );

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: publishable.headers,
    });

    expect(response.status).toBe(200);
  });

  it("takes the newest Price when a Variant has several", async () => {
    // The placeholder rule, and it is visible as one: nothing yet distinguishes two Prices
    // in the same currency, because Region, Channel, quantity and customer group do not
    // exist. `select-price` is where that rule lives, and where a Project replaces it.
    kobai = await createTestKobai();
    const store = await priced(kobai, 1250);
    await kobai.request(`/admin/variants/${store.variantId}/prices`, {
      method: "POST",
      headers: { ...store.merchant, "content-type": "application/json" },
      body: JSON.stringify({ amount: 900 }),
    });

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    const body = (await response.json()) as { price: { amount: number } };
    expect(body.price.amount).toBe(900);
  });

  it("says which Step refused when the Variant has no Price", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);
    const unpriced = (await (
      await kobai.request("/admin/products", {
        method: "POST",
        headers: { ...store.merchant, "content-type": "application/json" },
        body: JSON.stringify({ title: "Unpriced", variants: [{ sku: "UNPRICED" }] }),
      })
    ).json()) as { variants: { id: string }[] };

    const response = await kobai.request(
      `/store/variants/${unpriced.variants[0]?.id}/price`,
      { headers: store.headers },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "price-not-set",
      workflow: { name: "resolve-price", failed: "select-price" },
    });
  });

  it("accepts inputs Core does not model, and resolves the price regardless", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai, 1250);

    const response = await kobai.request(
      `/store/variants/${store.variantId}/price?leadTimeDays=10`,
      { headers: store.headers },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { price: { amount: number } };
    expect(body.price.amount).toBe(1250);
  });

  it("refuses a Variant that does not exist, and one that is not an identifier", async () => {
    kobai = await createTestKobai();
    const store = await priced(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/variants/${id}/price`, {
        headers: store.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "variant-not-found",
      });
    }
  });
});

/**
 * What the store surface hands the Workflow that Core has never heard of.
 *
 * Tested here rather than through a response because there is nothing in Core that reads
 * it — by construction, since the whole point is that the *Project's* Step does (ADR-0013).
 * The alternative is to leave the one edge that makes lead-time pricing possible without
 * changing Core uncovered until the ticket that consumes it, which is the wrong ticket to
 * find out it was never wired.
 */
describe("the Workflow's context is open at the edge", () => {
  it("carries every query parameter through, unparsed", () => {
    const url = new URL(
      "http://kobai.test/store/variants/x/price?leadTimeDays=10&rush=yes",
    );

    // Strings, not numbers: parsing implies a shape, and Core has no business having an
    // opinion about the shape of an input it does not model.
    expect(openInputs(url)).toEqual({ leadTimeDays: "10", rush: "yes" });
  });

  it("is empty when the caller sent nothing extra", () => {
    expect(openInputs(new URL("http://kobai.test/store/variants/x/price"))).toEqual({});
  });
});
