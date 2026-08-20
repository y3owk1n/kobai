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

  it("serves what a Shopper buys and nothing a Merchant administers", async () => {
    // What a key reaches is a Shopper's path through the Store — the catalog, a price, a
    // Cart, an Order. Anything a Merchant *does* — minting a key, editing the Store record —
    // is not reachable with a key at all. The paths below are the ones a caller would most
    // plausibly guess, and each is a 404.
    //
    // `/store/products` used to be on this list, and it moving off is this spec: the reason
    // it was here was never that a Shopper may not browse, it was that nothing served it.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const path of ["/store/api-keys", "/store/store", "/store/merchants"]) {
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

describe("browsing the catalog", () => {
  /**
   * A Product a Shopper can be shown something about: a title, the description a Merchant
   * wrote, a `metadata` bag carrying whatever else a Project attached through ADR-0004's
   * escape hatch, and a counted, priced Variant.
   *
   * The count and the Price are the arrangement rather than the subject. They are here so that
   * the negative assertions below are about a response *omitting* something the Store actually
   * holds — a Variant nobody counted would satisfy `not.toHaveProperty("inventory")` while
   * proving nothing at all.
   */
  async function seedSomethingToBrowse(instance: TestKobai) {
    const catalog = await seedTestCatalog(instance, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });

    const described = await instance.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        description: "Printed on 200gsm uncoated stock.",
        metadata: { blurb: "Printed on heavy stock." },
      }),
    });
    expect(described.status).toBe(200);

    const counted = await instance.request(
      `/admin/variants/${catalog.variantId}/inventory`,
      {
        method: "PUT",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ onHand: 7 }),
      },
    );
    expect(counted.status).toBe(200);

    return catalog;
  }

  it("lists the Products the Store sells", async () => {
    kobai = await createTestKobai();
    const catalog = await seedSomethingToBrowse(kobai);

    const response = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    // The whole body, so every field in the answer comes from this test — a list is where an
    // extra field would be published to every browser most quietly.
    await expect(response.json()).resolves.toEqual({
      products: [
        {
          id: catalog.productId,
          title: "A poster",
          // Published on purpose: it is copy a Merchant wrote *for a Shopper*, so a
          // storefront that could not read it would be missing the thing it was written for.
          description: "Printed on 200gsm uncoated stock.",
          // Published on purpose too, and it is the field this list exists to make useful: a
          // storefront builds `/products/a-poster` out of it, which is what the whole column
          // was added for.
          handle: "a-poster",
          // Published on purpose as well, and empty here because nothing has been attached: a
          // catalog grid is nothing but leading images, so the list is on this shape and not
          // only on the detail (#255). `catalog/media.test.ts` follows one all the way through.
          media: [],
          metadata: { blurb: "Printed on heavy stock." },
        },
      ],
    });
  });

  it("opens a Product onto the Variants a Shopper chooses between", async () => {
    kobai = await createTestKobai();
    const catalog = await seedSomethingToBrowse(kobai);

    const response = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: catalog.productId,
      title: "A poster",
      description: "Printed on 200gsm uncoated stock.",
      handle: "a-poster",
      media: [],
      metadata: { blurb: "Printed on heavy stock." },
      // The options a Shopper chooses by, in the Merchant's order — empty for a Product sold
      // as one thing, and carrying **no identifier** when it is not, which is the one field
      // this shape drops from the Merchant's `ProductOption` (#253).
      options: [],
      variants: [
        {
          id: catalog.variantId,
          sku: "POSTER-A2",
          // Kept, and the one thing about delivery a storefront needs: it is what says a
          // download is a download. ADR-0014 makes the set open, so it is a name rather than
          // an enum.
          fulfilment: { strategy: "physical" },
          // Kept, and it is what makes a picker possible at all — empty here because this
          // Product declares no options. `catalog/options.test.ts` is where a Product that
          // does is followed all the way to a Shopper choosing a combination (#253).
          options: [],
          // This Variant's **own** images, which deliberately do not fall back to its Product's
          // — a storefront has both lists and decides (#255).
          media: [],
          metadata: {},
        },
      ],
    });
  });

  it("reads one Variant, for a Cart line that carries nothing else", async () => {
    kobai = await createTestKobai();
    const catalog = await seedSomethingToBrowse(kobai);

    const response = await kobai.request(`/store/variants/${catalog.variantId}`, {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: catalog.variantId,
      sku: "POSTER-A2",
      fulfilment: { strategy: "physical" },
      options: [],
      media: [],
      metadata: {},
    });
  });

  /**
   * The two promises about what a store response does **not** carry, asserted directly.
   *
   * `toEqual` above already fails if either appears, but only for as long as somebody keeps
   * writing whole-body assertions there — and the failure would read as an unexpected key
   * rather than as a leak. This says what the promise is, so a later refactor reaching for the
   * admin schema because it is already there fails on a test that names the reason.
   *
   * Both are arranged to exist: the Variant has seven on the shelf and a Price of 1250, and
   * `GET /admin/variants/{id}` is asked in the same test to prove the Store really is holding
   * them. An assertion that something is absent is worth nothing until the thing is present
   * somewhere.
   */
  it("publishes neither the stock count nor the Price rows", async () => {
    kobai = await createTestKobai();
    const catalog = await seedSomethingToBrowse(kobai);

    const merchant = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    const shown = (await merchant.json()) as {
      variants: { inventory: { onHand: number } | null; prices: unknown[] }[];
    };
    // The arrangement, asserted: the Store is holding both of the things the store surface is
    // about to be held to omitting.
    expect(shown.variants[0]?.inventory?.onHand).toBe(7);
    expect(shown.variants[0]?.prices).toHaveLength(1);

    const detail = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });
    const variant = await kobai.request(`/store/variants/${catalog.variantId}`, {
      headers: catalog.apiKey.headers,
    });

    const [inProduct] = ((await detail.json()) as { variants: object[] }).variants;
    const onItsOwn = (await variant.json()) as object;

    for (const [where, shape] of [
      ["inside its Product", inProduct],
      ["read on its own", onItsOwn],
    ] as const) {
      // Exact stock levels are the Store's business, and ADR-0018 makes availability a
      // conditional write rather than a readable fact — an `available` rendered by a
      // storefront is stale before it is painted.
      expect(shape, `${where}: stock`).not.toHaveProperty("inventory");
      // `resolve-price` decides what a Variant costs, and a Project may have replaced the Step
      // that chooses. A storefront reading the rows would pick one itself and bypass it.
      expect(shape, `${where}: prices`).not.toHaveProperty("prices");
    }
  });

  /**
   * The third promise about what a store response does **not** carry, asserted directly.
   *
   * `status` is a Merchant's field and is on `Product` and `ProductDetail`; it is on neither
   * shape here, and #207's whole argument for keeping the two apart is this one: `/store` is
   * opened by a **publishable** key, so a `status` here would tell every browser which Products
   * a Merchant has not finished writing — and under ADR-0060 taking a field back out again is a
   * major.
   *
   * Arranged to exist, exactly as `inventory` and `prices` are: the Product really is
   * `published`, and `GET /admin/products/{id}` is asked in the same test to say so. An
   * assertion that something is absent is worth nothing until the thing is present somewhere.
   */
  it("publishes no status, on either shape a Product is answered in", async () => {
    kobai = await createTestKobai();
    const catalog = await seedSomethingToBrowse(kobai);

    const merchant = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    // The arrangement, asserted: the Store really is holding the thing the store surface is
    // about to be held to omitting.
    await expect(merchant.json()).resolves.toMatchObject({ status: "published" });

    const listed = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });
    const detail = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });

    const [inList] = ((await listed.json()) as { products: object[] }).products;
    const opened = (await detail.json()) as object;

    for (const [where, shape] of [
      ["in the list", inList],
      ["opened", opened],
    ] as const) {
      expect(shape, `${where}: status`).not.toHaveProperty("status");
    }
  });

  /**
   * Story 22 and story 24, on the list: a Shopper never sees something they cannot buy, and a
   * Developer building a storefront does not have to filter drafts out and cannot forget to.
   *
   * **Enforced in the route rather than left to a filter**, which is why there is no
   * `?status=` here to assert against: a client that could ask for drafts is a client that
   * will. The published Product beside them is the arrangement rather than decoration — a list
   * that answered nothing at all would satisfy the first half of this and be a broken
   * storefront.
   */
  it("answers neither a draft nor an archived Product", async () => {
    kobai = await createTestKobai();
    const onSale = await seedTestCatalog(kobai, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2" }],
    });
    await seedTestCatalog(kobai, {
      merchant: onSale.merchant,
      title: "A draft mug",
      status: "draft",
      variants: [{ sku: "MUG-DRAFT" }],
    });
    await seedTestCatalog(kobai, {
      merchant: onSale.merchant,
      title: "An old tote",
      status: "archived",
      variants: [{ sku: "TOTE-OLD" }],
    });

    const response = await kobai.request("/store/products", {
      headers: onSale.apiKey.headers,
    });

    expect(response.status).toBe(200);
    const { products } = (await response.json()) as { products: { title: string }[] };
    // The whole list rather than "does not contain": a storefront reading three Products where
    // one is for sale and a storefront reading one are different pages, and only one of them is
    // this promise.
    expect(products.map((product) => product.title)).toEqual(["A poster"]);
  });

  /**
   * The same two stories on the read, and the reason the refusal is the ordinary one.
   *
   * A draft answers **`product-not-found`**, the same 404 an unknown handle gets — so a draft is
   * *invisible* rather than forbidden. A 403 would be a different sentence: it would tell an
   * anonymous browser holding a publishable key that a handle is taken and that something exists
   * behind it, which is exactly what a Merchant preparing a Product has not published.
   */
  it("answers a draft and an archived Product not-found, by id and by handle", async () => {
    kobai = await createTestKobai();
    const draft = await seedTestCatalog(kobai, {
      title: "A draft mug",
      status: "draft",
      variants: [{ sku: "MUG-DRAFT" }],
    });
    const archived = await seedTestCatalog(kobai, {
      merchant: draft.merchant,
      title: "An old tote",
      status: "archived",
      variants: [{ sku: "TOTE-OLD" }],
    });

    for (const [what, address] of [
      ["a draft by id", draft.productId],
      ["a draft by handle", "a-draft-mug"],
      ["an archived Product by id", archived.productId],
      ["an archived Product by handle", "an-old-tote"],
    ] as const) {
      const response = await kobai.request(`/store/products/${address}`, {
        headers: draft.apiKey.headers,
      });

      expect(response.status, what).toBe(404);
      await expect(response.json(), what).resolves.toMatchObject({
        reason: "product-not-found",
      });
    }
  });

  it("carries every Variant of a Product, in SKU order", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      // Asked for out of order, so what comes back is the route's ordering rather than the
      // order they were created in.
      variants: [{ sku: "POSTER-A3" }, { sku: "MUG" }, { sku: "POSTER-A2" }],
    });

    const response = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });

    const body = (await response.json()) as { variants: { sku: string }[] };
    expect(body.variants.map((one) => one.sku)).toEqual([
      "MUG",
      "POSTER-A2",
      "POSTER-A3",
    ]);
  });

  it("opens the same Product by its handle as by its identifier", async () => {
    kobai = await createTestKobai();
    const catalog = await seedSomethingToBrowse(kobai);

    // The handle is taken off the response rather than written down here, because that is what
    // a storefront actually has: it lists, reads a handle, and builds `/products/<handle>` out
    // of it. A literal would be this test agreeing with itself about the derivation.
    const listed = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });
    const page = (await listed.json()) as { products: { handle: string }[] };
    const handle = page.products[0]?.handle;
    expect(handle).toBe("a-poster");

    const byHandle = await kobai.request(`/store/products/${handle}`, {
      headers: catalog.apiKey.headers,
    });
    const byId = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });

    // Byte for byte, because the point is that this is one route and one reader answering one
    // question two ways — story 23, and the reason the path parameter is `{idOrHandle}`.
    expect(byHandle.status).toBe(200);
    await expect(byHandle.json()).resolves.toEqual(await byId.json());
  });

  it("answers the same not-found for a handle nothing answers to", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    // A handle that resolves to nothing is the same question a bad identifier asks — "is there
    // such a Product" — so it is deliberately not a `reason` of its own (ADR-0060).
    const response = await kobai.request("/store/products/no-such-poster", {
      headers: catalog.apiKey.headers,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "product-not-found",
    });
  });

  it("accepts a publishable key, which is the key a browser holds", async () => {
    // Browsing is what a publishable key is for: ADR-0055's secret-key requirement is about
    // placing an Order and reading one back, not about what the Store sells.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    for (const path of [
      "/store/products",
      `/store/products/${catalog.productId}`,
      `/store/variants/${catalog.variantId}`,
    ]) {
      const response = await kobai.request(path, { headers: publishable.headers });
      expect(response.status, path).toBe(200);
    }
  });

  it("refuses a request carrying no key before saying whether the thing exists", async () => {
    // The gate is mounted on the sub-app, so it answers first: an anonymous caller learns
    // nothing about the catalog, including whether a given identifier names anything.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const path of [
      "/store/products",
      `/store/products/${catalog.productId}`,
      `/store/variants/${catalog.variantId}`,
    ]) {
      const response = await kobai.request(path);

      expect(response.status, path).toBe(401);
      await expect(response.json(), path).resolves.toMatchObject({
        reason: "api-key-missing",
      });
    }
  });

  it("names the Product it could not find, and says so as a reason", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    // An identifier nobody issued, and a value that is not an identifier at all — the same
    // answer for a caller, and the second one never reaches a cast Postgres would refuse.
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/products/${id}`, {
        headers: catalog.apiKey.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "product-not-found",
      });
    }
  });

  it("names the Variant it could not find, so a stale link renders a page", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/variants/${id}`, {
        headers: catalog.apiKey.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "variant-not-found",
      });
    }
  });

  it("stops listing a Product the Merchant deleted", async () => {
    // The catalog a Shopper browses is the catalog as it is, not a copy of it — which is worth
    // one assertion because these are the first store routes that read the Merchant's tables
    // rather than resolving something through a Workflow.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const deleted = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    expect(deleted.status).toBe(204);

    const listed = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });
    const opened = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });

    await expect(listed.json()).resolves.toEqual({ products: [] });
    expect(opened.status).toBe(404);
  });
});
