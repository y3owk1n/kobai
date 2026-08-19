import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * A Product declares its options and a Variant names its value for each (#253).
 *
 * The whole of it is asserted **through HTTP**, because the whole of it is a promise about what
 * a request may say and what a response carries: what a Merchant declares, what a Variant is
 * refused for, and — the reason any of this exists — that a storefront reading one Product has
 * everything it needs to draw a picker and to map a chosen combination to a SKU without asking
 * kobai a second question.
 *
 * **There is deliberately no test of a route that resolves a combination**, because there is
 * deliberately no such route: the Product detail payload settles it, and a route would be a
 * second answer to a question already answered. What stands in for it here is
 * {@link chooseVariant}, which is the mapping a storefront writes, written once in this file and
 * run against what `/store` actually answered — so "a combination that does not exist is
 * unavailable rather than an error" is asserted as the storefront experiences it rather than as
 * a shape.
 *
 * Two cases were watched failing before they were made to pass, and each is noted where it sits.
 */

/** A Merchant signed in and holding `owner`, with the header a JSON body needs. */
async function merchantHeaders(kobai: TestKobai): Promise<Record<string, string>> {
  const merchant = await signInTestMerchant(kobai);
  return { ...merchant.headers, "content-type": "application/json" };
}

type Product = {
  readonly id: string;
  readonly title: string;
  readonly handle: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly variants: readonly {
    readonly id: string;
    readonly sku: string;
    readonly options: readonly { readonly name: string; readonly value: string }[];
  }[];
};

type Refusal = { readonly reason?: string; readonly error?: string };

/** A Variant's values, as any of the three routes that answer one reports them. */
type Answered = {
  readonly options: readonly { readonly name: string; readonly value: string }[];
};

/** Creates a Product through the public API, and hands back what it answered with. */
async function createProduct(
  kobai: TestKobai,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Product> {
  const response = await kobai.request("/admin/products", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const created = (await response.json()) as Product;
  if (response.status !== 201) {
    throw new Error(
      `creating a Product answered ${response.status}: ${JSON.stringify(created)}`,
    );
  }
  return created;
}

/**
 * A poster in three sizes and two colours, with **four** of the six combinations.
 *
 * The gap is the arrangement rather than an accident: story 21 is that a Shopper who picks
 * `L`/`Red` is told it is unavailable, and a catalog that covered the grid could not show it.
 */
async function aPosterInSizesAndColours(
  kobai: TestKobai,
  headers: Record<string, string>,
): Promise<Product> {
  return createProduct(kobai, headers, {
    title: "A poster",
    options: [{ name: "Size" }, { name: "Colour" }],
    variants: [
      {
        sku: "POSTER-S-RED",
        options: [
          { name: "Size", value: "S" },
          { name: "Colour", value: "Red" },
        ],
      },
      {
        sku: "POSTER-S-BLUE",
        options: [
          { name: "Size", value: "S" },
          { name: "Colour", value: "Blue" },
        ],
      },
      {
        sku: "POSTER-M-RED",
        options: [
          { name: "Size", value: "M" },
          { name: "Colour", value: "Red" },
        ],
      },
      {
        sku: "POSTER-L-BLUE",
        options: [
          { name: "Size", value: "L" },
          { name: "Colour", value: "Blue" },
        ],
      },
    ],
  });
}

/**
 * The mapping a storefront writes, against what the store surface actually answered.
 *
 * This is the whole of "there is no route that takes a combination and answers a Variant": the
 * payload carries the options in order and each Variant's value for each, so choosing is a
 * lookup a browser does, and a combination nothing answers is `undefined` rather than an error
 * to interpret.
 */
function chooseVariant(
  product: {
    readonly variants: readonly {
      readonly sku: string;
      readonly options: readonly { readonly name: string; readonly value: string }[];
    }[];
  },
  chosen: Record<string, string>,
): string | undefined {
  return product.variants.find((one) =>
    Object.entries(chosen).every(([name, value]) =>
      one.options.some((held) => held.name === name && held.value === value),
    ),
  )?.sku;
}

/** Every Product this Store holds, as the database has it — for the cases that store nothing. */
async function productCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ count: string }>(
    "select count(*)::text as count from core_product",
  );
  return Number(rows[0]?.count ?? "-1");
}

describe("POST /admin/products declares the options", () => {
  it("keeps them in the order the Merchant sent, and answers each Variant's value for each", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    // Colour first, which is not alphabetical and not the order the Variants answer them in —
    // so what comes back can only be the order the Merchant asked for.
    const created = await createProduct(kobai, headers, {
      title: "A poster",
      options: [{ name: "Colour" }, { name: "Size" }],
      variants: [
        {
          sku: "POSTER-A2-RED",
          options: [
            { name: "Size", value: "A2" },
            { name: "Colour", value: "Red" },
          ],
        },
      ],
    });

    expect(created.options.map((one) => one.name)).toEqual(["Colour", "Size"]);
    // Each Variant answers in its Product's order too, so a storefront zips the two lists
    // rather than looking each one up.
    expect(created.variants[0]?.options).toEqual([
      { name: "Colour", value: "Red" },
      { name: "Size", value: "A2" },
    ]);
  });

  it("gives a Product that declares none an empty list rather than leaving the field out", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const created = await createProduct(kobai, headers, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2" }],
    });

    // A Product sold as one thing is the ordinary Product, not a special case — so the fields
    // are there and empty, and a storefront draws no picker without asking whether it may.
    expect(created.options).toEqual([]);
    expect(created.variants[0]?.options).toEqual([]);
  });

  it("refuses a Variant naming an option this Product never declared, and stores nothing", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        options: [{ name: "Size" }],
        variants: [
          {
            sku: "POSTER-A2",
            options: [
              { name: "Size", value: "A2" },
              { name: "Finish", value: "Matte" },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(422);
    const refusal = (await response.json()) as Refusal;
    expect(refusal.reason).toBe("variant-options-mismatch");
    // The word alone would not tell a Merchant which of the two mistakes they made, so the
    // prose names the option and says what this Product does declare.
    expect(refusal.error).toContain('"Finish"');
    expect(refusal.error).toContain('"Size"');

    // The Product and its options go back with the Variant that was refused, which is the same
    // guarantee `sku-taken` already makes: a create is one transaction.
    await expect(productCount(kobai)).resolves.toBe(0);
  });

  it("refuses a Variant that leaves a declared option unanswered, and stores nothing", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        options: [{ name: "Size" }, { name: "Colour" }],
        variants: [{ sku: "POSTER-A2", options: [{ name: "Size", value: "A2" }] }],
      }),
    });

    expect(response.status).toBe(422);
    const refusal = (await response.json()) as Refusal;
    expect(refusal.reason).toBe("variant-options-mismatch");
    expect(refusal.error).toContain('"Colour"');
    await expect(productCount(kobai)).resolves.toBe(0);
  });

  it("refuses a Variant carrying values for a Product that declares no options at all", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        variants: [{ sku: "POSTER-A2", options: [{ name: "Size", value: "A2" }] }],
      }),
    });

    // The `options` key absent is not "anything goes": it is a Product sold as one thing, and a
    // Variant saying what size it is would be a value nothing could interpret.
    expect(response.status).toBe(422);
    expect(((await response.json()) as Refusal).reason).toBe("variant-options-mismatch");
  });

  it("refuses an option named twice, because a Variant could not answer it once", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        options: [{ name: "Size" }, { name: "Size" }],
        variants: [{ sku: "POSTER-A2", options: [{ name: "Size", value: "A2" }] }],
      }),
    });

    // A body wrong in itself, which is `invalid` at 400 — the same distinction `variants`
    // naming one SKU twice already draws against `sku-taken`.
    expect(response.status).toBe(400);
    expect(((await response.json()) as Refusal).reason).toBe("invalid");
  });

  it("refuses an option value that is empty, which is a Variant with no answer", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "A poster",
        options: [{ name: "Size" }],
        variants: [{ sku: "POSTER-A2", options: [{ name: "Size", value: "  " }] }],
      }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as Refusal).reason).toBe("invalid");
  });
});

describe("POST /admin/products/:id/variants", () => {
  it("adds a Variant carrying its value for each option the Product declares", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}/variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sku: "POSTER-M-BLUE",
        options: [
          { name: "Colour", value: "Blue" },
          { name: "Size", value: "M" },
        ],
      }),
    });

    expect(response.status).toBe(201);
    // Answered in the Product's declared order, not the body's — the same list every read
    // reports, because it is the same reader.
    expect(((await response.json()) as Answered).options).toEqual([
      { name: "Size", value: "M" },
      { name: "Colour", value: "Blue" },
    ]);
  });

  it("refuses one whose values are not this Product's options, and adds nothing", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}/variants`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sku: "POSTER-XL",
        options: [{ name: "Size", value: "XL" }],
      }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as Refusal).reason).toBe("variant-options-mismatch");

    const read = await kobai.request(`/admin/products/${product.id}`, { headers });
    expect(((await read.json()) as Product).variants).toHaveLength(4);
  });
});

describe("PATCH /admin/products/:id corrects the options", () => {
  it("renames one, and every Variant's value for it stays attached", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const colour = product.options.find((one) => one.name === "Colour");

    const response = await kobai.request(`/admin/products/${product.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        options: [
          { id: product.options[0]?.id, name: "Size" },
          { id: colour?.id, name: "Color" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const corrected = (await response.json()) as Product;
    expect(corrected.options.map((one) => one.name)).toEqual(["Size", "Color"]);
    // **Watched failing** against a correction that reconciled by *name* rather than by `id`:
    // the rename read as a removal and an addition, the cascade took every Red and Blue with
    // it, and each Variant came back answering `Size` alone. That is the whole reason an
    // option's identifier is on the wire.
    expect(corrected.variants.find((one) => one.sku === "POSTER-S-RED")?.options).toEqual(
      [
        { name: "Size", value: "S" },
        { name: "Color", value: "Red" },
      ],
    );
  });

  it("reorders them, and every Variant's values follow the new order", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);

    const response = await kobai.request(`/admin/products/${product.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        options: [...product.options]
          .reverse()
          .map((one) => ({ id: one.id, name: one.name })),
      }),
    });

    expect(response.status).toBe(200);
    const corrected = (await response.json()) as Product;
    expect(corrected.options.map((one) => one.name)).toEqual(["Colour", "Size"]);
    // The order is one fact, so a Variant reporting the old one would be a storefront drawing
    // its picker one way and labelling it the other.
    expect(corrected.variants.find((one) => one.sku === "POSTER-S-RED")?.options).toEqual(
      [
        { name: "Colour", value: "Red" },
        { name: "Size", value: "S" },
      ],
    );
  });

  it("removes one, taking every Variant's value for it with it", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const size = product.options.find((one) => one.name === "Size");

    const response = await kobai.request(`/admin/products/${product.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ options: [{ id: size?.id, name: "Size" }] }),
    });

    expect(response.status).toBe(200);
    const corrected = (await response.json()) as Product;
    expect(corrected.options.map((one) => one.name)).toEqual(["Size"]);
    // An answer to a question this Product no longer asks is not a fact about anything, so it
    // goes — which is what makes removing an option an ordinary correction rather than a
    // cleanup somebody has to remember.
    expect(corrected.variants.find((one) => one.sku === "POSTER-S-RED")?.options).toEqual(
      [{ name: "Size", value: "S" }],
    );
  });

  it("adds one, which leaves the Variants unanswered until each is corrected", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);

    const added = await kobai.request(`/admin/products/${product.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        options: [
          ...product.options.map((one) => ({ id: one.id, name: one.name })),
          { name: "Finish" },
        ],
      }),
    });

    expect(added.status).toBe(200);
    const corrected = (await added.json()) as Product;
    expect(corrected.options.map((one) => one.name)).toEqual([
      "Size",
      "Colour",
      "Finish",
    ]);
    // Truthfully short rather than refused. Judging the Variants here would refuse the
    // correction for all four at once, and the only remedy would be to rebuild the Product —
    // a refusal whose advice names no reachable control.
    const one = corrected.variants.find((row) => row.sku === "POSTER-S-RED");
    expect(one?.options.map((value) => value.name)).toEqual(["Size", "Colour"]);

    // And this is the reachable control: the Variant is corrected, and answering every option
    // is what the route requires of it.
    const answered = await kobai.request(`/admin/variants/${one?.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        options: [
          { name: "Size", value: "S" },
          { name: "Colour", value: "Red" },
          { name: "Finish", value: "Matte" },
        ],
      }),
    });
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as Answered).options).toEqual([
      { name: "Size", value: "S" },
      { name: "Colour", value: "Red" },
      { name: "Finish", value: "Matte" },
    ]);
  });

  it("refuses an `id` naming no option of this Product", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const other = await createProduct(kobai, headers, {
      title: "A mug",
      options: [{ name: "Size" }],
      variants: [{ sku: "MUG", options: [{ name: "Size", value: "Large" }] }],
    });

    const response = await kobai.request(`/admin/products/${product.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ options: [{ id: other.options[0]?.id, name: "Size" }] }),
    });

    // A body that is wrong about the record it addresses, which is `invalid` — and the Product
    // it names really does have an option with that identifier, so nothing here rests on the
    // identifier being unknown to the Store.
    expect(response.status).toBe(400);
    expect(((await response.json()) as Refusal).reason).toBe("invalid");

    const read = await kobai.request(`/admin/products/${product.id}`, { headers });
    expect(((await read.json()) as Product).options).toHaveLength(2);
  });

  it("takes a body naming only `options` as a body that changes something", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await createProduct(kobai, headers, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2" }],
    });

    const response = await kobai.request(`/admin/products/${product.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ options: [] }),
    });

    // Not `changesNothing`: `options` is rows rather than a column, so a body naming it alone
    // leaves the column changes empty and would have been read as an empty body.
    expect(response.status).toBe(200);
    expect(((await response.json()) as Product).title).toBe("A poster");
  });
});

describe("PATCH /admin/variants/:id corrects the values", () => {
  it("replaces them wholesale, as a named `metadata` replaces", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const one = product.variants.find((row) => row.sku === "POSTER-S-RED");

    const response = await kobai.request(`/admin/variants/${one?.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        options: [
          { name: "Size", value: "XS" },
          { name: "Colour", value: "Green" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Answered).options).toEqual([
      { name: "Size", value: "XS" },
      { name: "Colour", value: "Green" },
    ]);
  });

  it("refuses values that are not exactly its Product's options, and changes nothing", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const one = product.variants.find((row) => row.sku === "POSTER-S-RED");

    const response = await kobai.request(`/admin/variants/${one?.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        sku: "POSTER-XS-RED",
        options: [{ name: "Size", value: "XS" }],
      }),
    });

    expect(response.status).toBe(422);
    expect(((await response.json()) as Refusal).reason).toBe("variant-options-mismatch");

    // **Watched failing** against a version that updated the columns before it judged the
    // values: the SKU moved and the refusal was answered from a transaction that had already
    // committed it, so a Merchant was told nothing had happened while their SKU had changed.
    const read = await kobai.request(`/admin/products/${product.id}`, { headers });
    const after = (await read.json()) as Product;
    expect(after.variants.map((row) => row.sku)).toContain("POSTER-S-RED");
  });

  it("leaves the values alone when the body does not name them", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const one = product.variants.find((row) => row.sku === "POSTER-S-RED");

    const response = await kobai.request(`/admin/variants/${one?.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sku: "POSTER-SMALL-RED" }),
    });

    // An absent field means "leave it" (ADR-0062) — and it has to, or a Variant left unanswered
    // by an option added since could not even have its SKU corrected.
    expect(response.status).toBe(200);
    const corrected = (await response.json()) as Product["variants"][number];
    expect(corrected.sku).toBe("POSTER-SMALL-RED");
    expect(corrected.options).toEqual([
      { name: "Size", value: "S" },
      { name: "Colour", value: "Red" },
    ]);
  });
});

describe("the storefront's half", () => {
  it("carries the options in order and each Variant's values, and no option identifier", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };
    const product = await aPosterInSizesAndColours(kobai, headers);
    await published(kobai, product.id, merchant);
    const key = await createTestApiKey(kobai, merchant);

    const response = await kobai.request(`/store/products/${product.handle}`, {
      headers: key.headers,
    });

    expect(response.status).toBe(200);
    const seen = (await response.json()) as {
      readonly options: readonly Record<string, unknown>[];
      readonly variants: readonly {
        readonly sku: string;
        readonly options: readonly { readonly name: string; readonly value: string }[];
      }[];
    };

    // The identifier is a Merchant's, and dropping it is a decision taken in
    // `catalog/store-read.ts` rather than a field that happened not to be selected — so it is
    // asserted directly, beside `inventory` and `prices` in `http/store.test.ts`.
    expect(seen.options).toEqual([{ name: "Size" }, { name: "Colour" }]);
    expect(seen.variants.find((one) => one.sku === "POSTER-M-RED")?.options).toEqual([
      { name: "Size", value: "M" },
      { name: "Colour", value: "Red" },
    ]);
  });

  it("makes a combination nothing answers unavailable rather than an error", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };
    const product = await aPosterInSizesAndColours(kobai, headers);
    await published(kobai, product.id, merchant);
    const key = await createTestApiKey(kobai, merchant);

    const response = await kobai.request(`/store/products/${product.handle}`, {
      headers: key.headers,
    });
    expect(response.status).toBe(200);
    const seen = (await response.json()) as Parameters<typeof chooseVariant>[0];

    // Story 20: the Shopper picks a size and a colour and gets the one they meant.
    expect(chooseVariant(seen, { Size: "M", Colour: "Red" })).toBe("POSTER-M-RED");
    // Story 21, and the reason there is no route for this: `L` in `Red` is one of the two
    // combinations this Product does not have, and the page can say so from what it is already
    // holding. Nothing was requested, so nothing could have been refused.
    expect(chooseVariant(seen, { Size: "L", Colour: "Red" })).toBeUndefined();
  });

  it("carries a Variant's values when the Variant is read on its own", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };
    const product = await aPosterInSizesAndColours(kobai, headers);
    await published(kobai, product.id, merchant);
    const key = await createTestApiKey(kobai, merchant);
    const one = product.variants.find((row) => row.sku === "POSTER-M-RED");

    // What a storefront rebuilding a Cart line asks: a line carries a `variantId` and nothing
    // else, and "Poster, M, Red" is what the row has to say.
    const response = await kobai.request(`/store/variants/${one?.id}`, {
      headers: key.headers,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Answered).options).toEqual([
      { name: "Size", value: "M" },
      { name: "Colour", value: "Red" },
    ]);
  });
});

describe("deleting", () => {
  it("takes a Product's options and its Variants' values with it", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);

    const deleted = await kobai.request(`/admin/products/${product.id}`, {
      method: "DELETE",
      headers,
    });

    // A 204 rather than a 500 is the whole assertion: without the cascades, the options and
    // the values are rows referencing what this statement removes.
    expect(deleted.status).toBe(204);
    const rows = await kobai.database.query<{ count: string }>(
      "select count(*)::text as count from core_variant_option_value",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("takes one Variant's values when only that Variant goes", async () => {
    await using kobai = await createTestKobai();
    const headers = await merchantHeaders(kobai);
    const product = await aPosterInSizesAndColours(kobai, headers);
    const one = product.variants.find((row) => row.sku === "POSTER-L-BLUE");

    const deleted = await kobai.request(`/admin/variants/${one?.id}`, {
      method: "DELETE",
      headers,
    });

    expect(deleted.status).toBe(204);
    const rows = await kobai.database.query<{ count: string }>(
      "select count(*)::text as count from core_variant_option_value where variant_id = $1",
      [one?.id],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

/** Publishes a Product, because the store surface answers no draft (#252). */
async function published(
  kobai: TestKobai,
  productId: string,
  merchant: TestSession,
): Promise<void> {
  const response = await kobai.request(`/admin/products/${productId}`, {
    method: "PATCH",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "published" }),
  });
  if (response.status !== 200) {
    throw new Error(`publishing answered ${response.status}`);
  }
}
