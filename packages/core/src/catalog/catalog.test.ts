import { afterEach, describe, expect, it } from "vitest";
import { PERMISSIONS } from "../auth/permissions.ts";
import {
  createTestKobai,
  inspectSchema,
  sessionOf,
  signInTestMerchant,
  type TestKobai,
} from "../testing/index.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/** A Merchant signed in and holding the seeded `owner` Role, which holds every permission. */
async function merchantHeaders(harness: TestKobai): Promise<Record<string, string>> {
  const merchant = await signInTestMerchant(harness);
  return { ...merchant.headers, "content-type": "application/json" };
}

type CreatedProduct = {
  id: string;
  title: string;
  description: string | null;
  handle: string;
  metadata: Record<string, unknown>;
  variants: {
    id: string;
    sku: string;
    metadata: Record<string, unknown>;
    prices: unknown[];
  }[];
};

/** Creates a Product through the public API, and hands back what it answered with. */
async function createProduct(
  harness: TestKobai,
  headers: Record<string, string>,
  body: Record<string, unknown> = {
    title: "A2 poster",
    variants: [{ sku: "POSTER-A2" }],
  },
): Promise<CreatedProduct> {
  const response = await harness.request("/admin/products", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const created = (await response.json()) as CreatedProduct;
  if (response.status !== 201) {
    throw new Error(
      `creating a Product answered ${response.status}: ${JSON.stringify(created)}`,
    );
  }
  return created;
}

describe("POST /admin/products", () => {
  it("creates a Product with a title and the Variant that makes it sellable", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "A2 poster", variants: [{ sku: "POSTER-A2" }] }),
    });

    expect(response.status).toBe(201);
    const created = (await response.json()) as CreatedProduct;
    expect(created).toMatchObject({
      title: "A2 poster",
      variants: [{ sku: "POSTER-A2", prices: [] }],
    });

    // Created without metadata, so both bags are empty — and `toEqual` on each of them
    // rather than `metadata: {}` inside the match above, which asserted nothing at all: `{}`
    // is a subset of every object, so that version passed against a Product that had stored
    // whatever a bug left there (#186, docs/agents/writing-tests.md).
    expect(created.metadata).toEqual({});
    expect(created.variants[0]?.metadata).toEqual({});
  });

  it("keeps the description a Merchant wrote, and answers `null` where they wrote none", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const described = await createProduct(kobai, headers, {
      title: "A2 poster",
      description: "Printed on 200gsm uncoated stock.",
      variants: [{ sku: "POSTER-A2" }],
    });
    const bare = await createProduct(kobai, headers, {
      title: "A3 poster",
      variants: [{ sku: "POSTER-A3" }],
    });

    expect(described.description).toBe("Printed on 200gsm uncoated stock.");
    // `null` and not `""`: a Product nobody has written copy for has no description, and a
    // storefront told it has an empty one renders an empty paragraph under every title.
    expect(bare.description).toBeNull();

    // Read back through the route a Merchant opens a Product with, because a create that
    // assembled the answer itself would report a field the reader had never learned to select.
    const opened = await kobai.request(`/admin/products/${described.id}`, { headers });
    await expect(opened.json()).resolves.toMatchObject({
      description: "Printed on 200gsm uncoated stock.",
    });

    // And on the list shape too, which is a different projection of the same column: a
    // Merchant scanning the catalog reads the copy they wrote without opening each entry.
    const listed = await kobai.request("/admin/products", { headers });
    const page = (await listed.json()) as { products: CreatedProduct[] };
    expect(page.products.map((one) => one.description)).toEqual([
      null,
      "Printed on 200gsm uncoated stock.",
    ]);
  });

  it("refuses an empty description rather than creating a Product with a blank one", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A2 poster",
        description: "   ",
        variants: [{ sku: "POSTER-A2" }],
      }),
    });

    // The same answer `PATCH /admin/products/{id}` gives the same mistake, because both read
    // the field through `text`: leaving a Product without a description is what leaving it out
    // does, and a blank one would be a second spelling of that.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
    await expect(kobai.database.query("select id from core_product")).resolves.toEqual(
      [],
    );
  });

  it("proposes a handle from the title, and takes one that is given", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const proposed = await createProduct(kobai, headers, {
      title: "Blue Poster (A2)",
      variants: [{ sku: "POSTER-A2" }],
    });
    const chosen = await createProduct(kobai, headers, {
      title: "Blue Poster (A3)",
      handle: "the-big-one",
      variants: [{ sku: "POSTER-A3" }],
    });

    // Story 3: a Merchant does not invent an address for every Product. Story 2: one who wants
    // their own says so and gets exactly it, with no normalising in between.
    expect(proposed.handle).toBe("blue-poster-a2");
    expect(chosen.handle).toBe("the-big-one");

    // Read back through the route a Merchant opens a Product with, and through the list, for
    // the reason the description is: a create that assembled its own answer would report a
    // field the readers had never learned to select.
    const opened = await kobai.request(`/admin/products/${chosen.id}`, { headers });
    await expect(opened.json()).resolves.toMatchObject({ handle: "the-big-one" });

    const listed = await kobai.request("/admin/products", { headers });
    const page = (await listed.json()) as { products: CreatedProduct[] };
    expect(page.products.map((one) => one.handle)).toEqual([
      "the-big-one",
      "blue-poster-a2",
    ]);
  });

  it("refuses a handle another Product already answers to, and stores nothing", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    await createProduct(kobai, headers, {
      title: "Blue poster",
      variants: [{ sku: "POSTER-A2" }],
    });

    // The second Product's title proposes the address the first one already holds, which is
    // the collision a Merchant meets without asking for anything unusual.
    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Blue poster", variants: [{ sku: "POSTER-A3" }] }),
    });

    // Refused rather than silently suffixed: two Products must not fight over one address, and
    // a Merchant who asked for one should be told they cannot have it (story 4).
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "handle-taken" });
    // The whole request goes back, Variants included — the same property a refused SKU has,
    // because a half-created Product is the zero-Variant state creation exists to prevent.
    await expect(
      kobai.database.query("select sku from core_variant order by sku"),
    ).resolves.toEqual([{ sku: "POSTER-A2" }]);
  });

  it("refuses a handle that reads as an identifier", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A2 poster",
        handle: "9f8a1c0e-3b6d-4a2f-9c11-5d7e2b8a4f36",
        variants: [{ sku: "POSTER-A2" }],
      }),
    });

    // What makes `GET /store/products/{idOrHandle}` statable: a UUID is read as an id there, so
    // a Product whose handle were one could never be reached by its own address.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
    await expect(kobai.database.query("select id from core_product")).resolves.toEqual(
      [],
    );
  });

  it("refuses a handle that is not the shape of an address", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A2 poster",
        // A slash is the case with teeth: the route resolving it would never see the second
        // half, so the Product would be unreachable exactly as a UUID-shaped one is.
        handle: "posters/blue",
        variants: [{ sku: "POSTER-A2" }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses a title that proposes no handle rather than inventing one", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      // Nothing addressable survives it, so kobai has nothing to propose — and a Merchant is
      // right here to be asked, which is the difference from the backfill in `0037`, where
      // there is nobody to ask and a fallback is the only honest answer.
      body: JSON.stringify({ title: "★", variants: [{ sku: "POSTER-A2" }] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });

    // And the remedy the refusal names really works: the same title, with an address.
    const named = await createProduct(kobai, headers, {
      title: "★",
      handle: "the-star",
      variants: [{ sku: "POSTER-A2" }],
    });
    expect(named.handle).toBe("the-star");
  });

  it("refuses a Product with no Variant, and stores nothing", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "A2 poster", variants: [] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
    // A Product that exists with no Variant is the special case ADR-0008 spends a row to
    // avoid, so the refusal has to leave nothing behind — not even the Product.
    await expect(kobai.database.query("select id from core_product")).resolves.toEqual(
      [],
    );
  });
});

describe("metadata, the cheap extension case", () => {
  it("round-trips on the Product, the Variant and the Price", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const product = await createProduct(kobai, headers, {
      title: "A2 poster",
      metadata: { printer: "riso" },
      variants: [{ sku: "POSTER-A2", metadata: { paper: "gmund" } }],
    });
    await kobai.request(`/admin/variants/${product.variants[0]?.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount: 1250, metadata: { source: "the 2026 list" } }),
    });

    // ADR-0004's bargain: Core's tables are closed to a Plugin, and stashing a field is free
    // anyway. A column nobody can write would be only half of that.
    await expect(
      (await kobai.request(`/admin/products/${product.id}`, { headers })).json(),
    ).resolves.toMatchObject({
      metadata: { printer: "riso" },
      variants: [
        {
          metadata: { paper: "gmund" },
          prices: [{ metadata: { source: "the 2026 list" } }],
        },
      ],
    });
  });

  it("refuses anything that is not a JSON object", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A2 poster",
        metadata: "riso",
        variants: [{ sku: "POSTER-A2" }],
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});

describe("the SKU identifies the Variant", () => {
  it("refuses a SKU another Variant already carries", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    await createProduct(kobai, headers);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "A3 poster", variants: [{ sku: "POSTER-A2" }] }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "sku-taken" });
    // And the second Product is not left behind Variant-less by the refusal.
    await expect(kobai.database.query("select title from core_product")).resolves.toEqual(
      [{ title: "A2 poster" }],
    );
  });

  it("carries a SKU on the Variant and never on the Product", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    const productColumns = (await schema.columnsOf("core_product")).map((c) => c.name);
    const variantColumns = (await schema.columnsOf("core_variant")).map((c) => c.name);

    // "A Product is not a SKU; that belongs to a Variant" is a line in CONTEXT.md and a
    // property of the schema, so it is checked against the schema.
    expect(productColumns).not.toContain("sku");
    expect(variantColumns).toContain("sku");
  });
});

describe("the catalog is behind the Merchant session", () => {
  /** Every catalog route, and the permission each one names. */
  const ROUTES = [
    { method: "POST", path: "/admin/products", permission: PERMISSIONS.catalogWrite },
    { method: "GET", path: "/admin/products", permission: PERMISSIONS.catalogRead },
    {
      method: "GET",
      path: "/admin/fulfilment-strategies",
      permission: PERMISSIONS.catalogRead,
    },
    {
      method: "GET",
      path: "/admin/products/2f1b8a5e-0000-4000-8000-000000000000",
      permission: PERMISSIONS.catalogRead,
    },
    {
      method: "PATCH",
      path: "/admin/products/2f1b8a5e-0000-4000-8000-000000000000",
      permission: PERMISSIONS.catalogWrite,
    },
    {
      method: "POST",
      path: "/admin/products/2f1b8a5e-0000-4000-8000-000000000000/variants",
      permission: PERMISSIONS.catalogWrite,
    },
    {
      method: "POST",
      path: "/admin/variants/2f1b8a5e-0000-4000-8000-000000000000/prices",
      permission: PERMISSIONS.catalogWrite,
    },
    {
      method: "DELETE",
      path: "/admin/products/2f1b8a5e-0000-4000-8000-000000000000",
      permission: PERMISSIONS.catalogWrite,
    },
    {
      method: "DELETE",
      path: "/admin/variants/2f1b8a5e-0000-4000-8000-000000000000",
      permission: PERMISSIONS.catalogWrite,
    },
    {
      method: "DELETE",
      path: "/admin/variants/2f1b8a5e-0000-4000-8000-000000000000/prices/3c2c9b6f-0000-4000-8000-000000000000",
      permission: PERMISSIONS.catalogWrite,
    },
  ] as const;

  it.each(ROUTES)("refuses $method $path with no session", async ({ method, path }) => {
    kobai = await createTestKobai();

    const response = await kobai.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it.each(ROUTES)(
    "refuses $method $path when the Role does not hold $permission",
    async ({ method, path, permission }) => {
      kobai = await createTestKobai();
      const owner = await merchantHeaders(kobai);
      // A Role holding nothing at all, made the way a Merchant makes one (#173).
      const role = await kobai.request("/admin/roles", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({ name: "bookkeeper", permissions: [] }),
      });
      expect(role.status, "creating the bookkeeper Role").toBe(201);
      await kobai.request("/admin/merchants", {
        method: "POST",
        headers: owner,
        body: JSON.stringify({
          email: "books@example.test",
          password: "a bookkeeper's very long password",
          role: "bookkeeper",
        }),
      });
      const bookkeeper = sessionOf(
        await kobai.request("/admin/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "books@example.test",
            password: "a bookkeeper's very long password",
          }),
        }),
      );

      const response = await kobai.request(path, {
        method,
        headers: {
          ...bookkeeper.headers,
          "content-type": "application/json",
        },
        body: method === "GET" || method === "DELETE" ? undefined : "{}",
      });

      // 403 and not 404: the gate answers before the handler, so it never leaks whether the
      // row in the path exists. One permission, checked once, never per resource (ADR-0027).
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        reason: "permission-denied",
        required: permission,
      });
    },
  );
});

describe("GET /admin/products", () => {
  it("lists the Products a Merchant has created, most recent first", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    await createProduct(kobai, headers, {
      title: "A2 poster",
      variants: [{ sku: "POSTER-A2" }],
    });
    await createProduct(kobai, headers, {
      title: "A3 poster",
      variants: [{ sku: "POSTER-A3" }],
    });

    const response = await kobai.request("/admin/products", { headers });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { products: { title: string }[] };
    expect(body.products.map((product) => product.title)).toEqual([
      "A3 poster",
      "A2 poster",
    ]);
  });

  it("is empty on a Store nothing has been created in", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", { headers });

    await expect(response.json()).resolves.toEqual({ products: [] });
  });
});

describe("GET /admin/products/:id", () => {
  it("opens a Product on its Variant and that Variant's Price", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);
    await kobai.request(`/admin/variants/${product.variants[0]?.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount: 1250 }),
    });

    const response = await kobai.request(`/admin/products/${product.id}`, { headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: product.id,
      title: "A2 poster",
      variants: [
        {
          id: product.variants[0]?.id,
          sku: "POSTER-A2",
          prices: [{ amount: 1250, currency: "USD" }],
        },
      ],
    });
  });

  it("shows a Variant that has not been priced yet, rather than dropping it", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    const detail = (await (
      await kobai.request(`/admin/products/${product.id}`, { headers })
    ).json()) as { variants: unknown[] };

    // A Product always has at least one Variant, priced or not — a read that dropped the
    // unpriced ones would produce exactly the zero-Variant Product ADR-0008 forbids.
    // `inventory: null` for the same reason `prices: []` is here: a Variant nobody has counted
    // is not one with none left, and the two are told apart by the absence rather than by a zero
    // (ADR-0018).
    expect(detail.variants).toEqual([
      {
        id: product.variants[0]?.id,
        sku: "POSTER-A2",
        // `physical` because nothing said otherwise, which is what a Variant with no opinion
        // about how it is delivered is (ADR-0014).
        fulfilment: { strategy: "physical" },
        metadata: {},
        prices: [],
        inventory: null,
      },
    ]);
  });

  it("answers 404 for a Product that does not exist", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request(
      "/admin/products/2f1b8a5e-0000-4000-8000-000000000000",
      { headers },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "product-not-found",
    });
  });

  it("answers 404, not 500, for an id that is not an identifier at all", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    // Postgres refuses to cast this, and an unhandled refusal would report a broken server
    // for what is only a request for something that does not exist.
    const response = await kobai.request("/admin/products/not-a-uuid", { headers });

    expect(response.status).toBe(404);
  });
});

describe("POST /admin/products/:id/variants", () => {
  it("adds a Variant to a Product that already exists", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}/variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sku: "POSTER-A3", metadata: { size: "A3" } }),
    });

    // A second size is one more row on the Product a Merchant already has, so nothing that
    // Product carries — its Variants' Prices, their stock counts — has to be discarded to
    // reach one. Recreating it was the only way until this route existed, which is the same
    // loss #144 removed for a SKU.
    expect(response.status).toBe(201);
    const added = await response.json();
    expect(added).toMatchObject({
      sku: "POSTER-A3",
      // The defaults a Variant created inside `POST /admin/products` gets, because it is the
      // same request shape read by the same code: `physical` unless it said otherwise, no
      // Price, and untracked until somebody counts it.
      fulfilment: { strategy: "physical" },
      metadata: { size: "A3" },
      prices: [],
      inventory: null,
    });

    // Read back rather than assembled from what went in, so what this answers is what the
    // Product reports — `createProduct`'s property, asserted the way correcting one is.
    const read = (await (
      await kobai.request(`/admin/products/${product.id}`, { headers })
    ).json()) as { variants: unknown[] };
    expect(read.variants).toEqual([product.variants[0], added]);
  });

  it("refuses a SKU another Variant already carries, and adds nothing", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}/variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sku: "POSTER-A2" }),
    });

    // Creation's refusal, made by creation's check: the unique index answers it, so two
    // Merchants adding the same SKU at one instant cannot both be told there was no such SKU
    // (ADR-0018).
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "sku-taken" });
    const read = (await (
      await kobai.request(`/admin/products/${product.id}`, { headers })
    ).json()) as { variants: unknown[] };
    expect(read.variants).toEqual(product.variants);
  });

  it("refuses a Fulfilment Strategy this deployment has not wired", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}/variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sku: "MADE", fulfilment: { strategy: "made-to-order" } }),
    });

    // 422 and the word creating one answers with: the body is well formed, and it is *this*
    // deployment that has not wired that Strategy — a fact fixed in `kobai.config.ts`.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unknown-fulfilment-strategy",
    });
  });

  it("answers 404 for a Product that does not exist, and for an id that is not one", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    for (const id of ["2f1b8a5e-0000-4000-8000-000000000000", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/products/${id}/variants`, {
        method: "POST",
        headers,
        body: JSON.stringify({ sku: "ANYTHING" }),
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "product-not-found",
      });
    }
  });

  it("refuses a Variant with no SKU, which is a Variant nobody could identify", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}/variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ metadata: { size: "A3" } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});

describe("POST /admin/variants/:id/prices", () => {
  it("prices the Variant, in an amount and a currency", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);
    const [variant] = product.variants;

    const response = await kobai.request(`/admin/variants/${variant?.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount: 1250, currency: "USD" }),
    });

    expect(response.status).toBe(201);
    const price = (await response.json()) as {
      amount: number;
      currency: string;
      metadata: Record<string, unknown>;
    };
    expect(price).toMatchObject({
      // Minor units, so USD 12.50 is 1250 and nothing here is a float.
      amount: 1250,
      currency: "USD",
    });
    // `toEqual` on the bag, so "a Price created without metadata stores none" can fail (#186).
    expect(price.metadata).toEqual({});
  });

  it("stores the Price as a row referencing the Variant, not as a column on it", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);
    const [variant] = product.variants;

    await kobai.request(`/admin/variants/${variant?.id}/prices`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount: 1250 }),
    });

    // The row exists and points at the Variant …
    await expect(
      kobai.database.query("select variant_id, amount, currency from core_price"),
    ).resolves.toEqual([{ variant_id: variant?.id, amount: "1250", currency: "USD" }]);
    // … and the Variant carries no amount of its own. A column here is the migration
    // ADR-0008 exists to never have to write.
    const columns = await inspectSchema(kobai.database).columnsOf("core_variant");
    expect(columns.map((column) => column.name)).not.toContain("amount");
    expect(columns.map((column) => column.name)).not.toContain("price");
  });

  it("holds more than one Price per Variant, even though this slice sets one", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);
    const [variant] = product.variants;

    // Pricing is an insert, never an update: a sale price, a second currency and a quantity
    // break are all this same call plus a constraint column that does not exist yet.
    for (const amount of [1250, 999]) {
      const response = await kobai.request(`/admin/variants/${variant?.id}/prices`, {
        method: "POST",
        headers,
        body: JSON.stringify({ amount }),
      });
      expect(response.status).toBe(201);
    }

    const detail = (await (
      await kobai.request(`/admin/products/${product.id}`, { headers })
    ).json()) as { variants: { prices: { amount: number }[] }[] };
    expect(detail.variants[0]?.prices.map((price) => price.amount)).toEqual([1250, 999]);
  });

  it("refuses an amount that is not a whole number of minor units", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    // 12.50 is what a caller means by "twelve fifty" and is exactly the value this column
    // must never hold: money in binary floating point is wrong by construction.
    const response = await kobai.request(
      `/admin/variants/${product.variants[0]?.id}/prices`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: 12.5 }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses a currency this Store does not price in", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers);

    const response = await kobai.request(
      `/admin/variants/${product.variants[0]?.id}/prices`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: 1250, currency: "EUR" }),
      },
    );

    // The column holds any currency — that is the shape. What refuses this is that a second
    // currency belongs to a Region, and there is no rule yet for choosing between two Prices
    // in different ones. Writing the row anyway would invent that rule by accident.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unsupported-currency",
    });
    await expect(kobai.database.query("select id from core_price")).resolves.toEqual([]);
  });

  it("answers 404 for a Variant that does not exist", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request(
      "/admin/variants/2f1b8a5e-0000-4000-8000-000000000000/prices",
      { method: "POST", headers, body: JSON.stringify({ amount: 1250 }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "variant-not-found",
    });
  });
});

describe("GET /admin/fulfilment-strategies", () => {
  /** A Strategy of the shape a Plugin offers — five lines, no `name` inside it (ADR-0052). */
  const rental = {
    answersFor: () => ({
      requiresShipping: true,
      tracksInventory: false,
      hasLeadTime: true,
    }),
  };

  it("answers Core's own two on a deployment that wired nothing", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/fulfilment-strategies", { headers });

    expect(response.status).toBe(200);
    // Both of them, in name order, and a name is the whole of what a Strategy can say here:
    // the three answers are asked *of a Variant* and there is none (ADR-0014, ADR-0067).
    await expect(response.json()).resolves.toEqual({
      strategies: [{ name: "digital" }, { name: "physical" }],
    });
  });

  it("answers a Plugin's Strategy beside them, under the name the Project wired it as", async () => {
    kobai = await createTestKobai({ fulfilment: { strategies: { rental } } });
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/fulfilment-strategies", { headers });

    // The name is the key `kobai.config.ts` used and not anything inside the object, which is
    // why two Plugins that both call theirs `rental` can be wired side by side (ADR-0052).
    await expect(response.json()).resolves.toEqual({
      strategies: [{ name: "digital" }, { name: "physical" }, { name: "rental" }],
    });
  });

  it("reports a replaced Strategy once, not twice", async () => {
    // A Project naming one of Core's *replaces* it rather than adding beside it, so the set is
    // still two — the case a `[...core, ...wired]` would have got wrong.
    kobai = await createTestKobai({ fulfilment: { strategies: { physical: rental } } });
    const headers = await merchantHeaders(kobai);

    await expect(
      (await kobai.request("/admin/fulfilment-strategies", { headers })).json(),
    ).resolves.toEqual({ strategies: [{ name: "digital" }, { name: "physical" }] });
  });

  it("lists exactly the Strategies a Variant is allowed to point at", async () => {
    kobai = await createTestKobai({ fulfilment: { strategies: { rental } } });
    const headers = await merchantHeaders(kobai);
    const { strategies } = (await (
      await kobai.request("/admin/fulfilment-strategies", { headers })
    ).json()) as { strategies: { name: string }[] };

    // The point of the route, and the only assertion that ties it to anything: every name it
    // answers is accepted by the route that refuses `unknown-fulfilment-strategy`, and a name
    // it does not answer is refused. Two readings of one configuration, held together.
    for (const [index, { name }] of strategies.entries()) {
      const accepted = await kobai.request("/admin/products", {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: `Something ${name}`,
          variants: [{ sku: `SKU-${index}`, fulfilment: { strategy: name } }],
        }),
      });
      expect(accepted.status, `creating a Variant fulfilled by ${name}`).toBe(201);
    }

    const refused = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Something nobody wired",
        variants: [{ sku: "SKU-UNWIRED", fulfilment: { strategy: "subscription" } }],
      }),
    });
    expect(refused.status).toBe(422);
    expect(strategies.map(({ name }) => name)).not.toContain("subscription");
  });

  it("takes no page query, and answers the whole set (ADR-0067)", async () => {
    kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    // `limit` and `after` are refused by every list that pages — this one does not page, so
    // they are simply not its parameters and are ignored rather than honoured. The assertion
    // is that the answer is the whole set either way: a reader who sends them out of habit
    // gets everything rather than a page they would then try to follow a cursor off.
    const response = await kobai.request(
      "/admin/fulfilment-strategies?limit=1&after=nonsense",
      { headers },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      strategies: [{ name: "digital" }, { name: "physical" }],
    });
  });
});
