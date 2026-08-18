import { sql } from "drizzle-orm";
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
  metadata: Record<string, unknown>;
  variants: { id: string; sku: string; prices: unknown[] }[];
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
    await expect(response.json()).resolves.toMatchObject({
      title: "A2 poster",
      metadata: {},
      variants: [{ sku: "POSTER-A2", metadata: {}, prices: [] }],
    });
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
      path: "/admin/products/2f1b8a5e-0000-4000-8000-000000000000",
      permission: PERMISSIONS.catalogRead,
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
      body: method === "POST" ? "{}" : undefined,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it.each(ROUTES)(
    "refuses $method $path when the Role does not hold $permission",
    async ({ method, path, permission }) => {
      kobai = await createTestKobai();
      const owner = await merchantHeaders(kobai);
      // A Role holding nothing at all. Roles are rows, so a narrower one is a row.
      await kobai.db.execute(
        sql`insert into core_role (name, permissions) values ('bookkeeper', array[]::text[])`,
      );
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
        body: method === "POST" ? "{}" : undefined,
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
    await expect(response.json()).resolves.toMatchObject({
      // Minor units, so USD 12.50 is 1250 and nothing here is a float.
      amount: 1250,
      currency: "USD",
      metadata: {},
    });
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
