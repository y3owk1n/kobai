import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * Collections — the five routes that manage one, the field that puts a Product in one, and the
 * two lists that narrow by one (#256, stories 13, 14, 16, 17 and 18).
 *
 * **Through HTTP, because all of it is a promise about a request and a response.** The one thing
 * here that is a promise about the *database* is story 17 — that deleting a Collection leaves
 * every Product it held alive — and #256 asks for that asserted directly rather than left for
 * `on delete cascade` to imply. It is still asserted through the API: what makes it a promise is
 * that the Products are still readable and still sellable afterwards, which is a question about
 * routes rather than about rows.
 *
 * **Three cases were watched failing before they were made to pass**, and each says so where it
 * sits: story 17 against a `deleteCollection` that removed the Products it held first; the
 * store surface's filter against a route that dropped `published` when a Collection was named;
 * and the unknown-Collection refusal against a build with the guard taken out, where the filter
 * reached the reader and answered an ordinary empty page at 200. Each run reddened **only** the
 * case it was aimed at, which is the half that says the other thirteen are not standing in for
 * it.
 *
 * What is *not* here is the filtering convention itself. `http/filtering.test.ts` holds
 * `?collection=` to the same three promises `?status=` and `?state=` are held to, once, from a
 * table — this file asserts what the narrowing *means*, which is the division of labour that
 * file's own header sets out.
 */

type Collection = {
  readonly id: string;
  readonly title: string;
  readonly metadata: Record<string, unknown>;
};

type Product = {
  readonly id: string;
  readonly title: string;
  readonly collections: readonly Collection[];
};

type Refusal = { readonly reason?: string; readonly error?: string };

/** Creates a Collection through the route a Merchant uses, and answers what came back. */
async function createCollection(
  kobai: TestKobai,
  merchant: TestSession,
  title: string,
  metadata?: Record<string, unknown>,
): Promise<Collection> {
  const response = await kobai.request("/admin/collections", {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(metadata === undefined ? { title } : { title, metadata }),
  });
  const body = (await response.json()) as Collection;
  if (response.status !== 201) {
    throw new Error(`creating answered ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/** Puts a Product in exactly these Collections — the whole set, as the route reads it. */
async function group(
  kobai: TestKobai,
  catalog: TestCatalog,
  productId: string,
  collectionIds: readonly string[],
): Promise<{ readonly status: number; readonly body: Product & Refusal }> {
  const response = await kobai.request(`/admin/products/${productId}`, {
    method: "PATCH",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ collections: collectionIds.map((id) => ({ id })) }),
  });
  return { status: response.status, body: (await response.json()) as Product & Refusal };
}

/** A second Product in the same catalog, so a Collection can hold more than one thing. */
async function anotherProduct(
  kobai: TestKobai,
  catalog: TestCatalog,
  title: string,
  sku: string,
): Promise<string> {
  const response = await kobai.request("/admin/products", {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ title, variants: [{ sku }] }),
  });
  const body = (await response.json()) as { id: string };
  if (response.status !== 201) {
    throw new Error(`creating answered ${response.status}: ${JSON.stringify(body)}`);
  }
  // Published, because half the cases below read it back over the store surface and a create
  // makes a draft (#252).
  const published = await kobai.request(`/admin/products/${body.id}`, {
    method: "PATCH",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "published" }),
  });
  expect(published.status, `publishing ${title}`).toBe(200);
  return body.id;
}

/** The ids of one page of a Product list, whichever surface asked for it. */
async function productIdsIn(
  kobai: TestKobai,
  path: string,
  headers: Record<string, string>,
): Promise<readonly string[]> {
  const response = await kobai.request(path, { headers });
  expect(response.status, path).toBe(200);
  const body = (await response.json()) as { products: readonly { id: string }[] };
  return body.products.map((one) => one.id);
}

describe("a Collection groups Products", () => {
  it("is created, read back, renamed and listed", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const created = await createCollection(kobai, catalog.merchant, "Summer", {
      hero: "beach",
    });
    expect(created).toEqual({
      id: expect.any(String),
      title: "Summer",
      metadata: { hero: "beach" },
    });

    const read = await kobai.request(`/admin/collections/${created.id}`, {
      headers: catalog.merchant.headers,
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual(created);

    const renamed = await kobai.request(`/admin/collections/${created.id}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "High summer" }),
    });
    expect(renamed.status).toBe(200);
    // The whole body, so `metadata` being left alone by a `PATCH` that did not name it is
    // asserted rather than assumed — an absent field means "leave it" (ADR-0062).
    await expect(renamed.json()).resolves.toEqual({
      id: created.id,
      title: "High summer",
      metadata: { hero: "beach" },
    });

    const listed = await kobai.request("/admin/collections", {
      headers: catalog.merchant.headers,
    });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      collections: [
        { id: created.id, title: "High summer", metadata: { hero: "beach" } },
      ],
    });
  });

  it("lets two Collections carry one title, because a title identifies nothing", async () => {
    await using kobai = await createTestKobai();
    const merchant = (await seedTestCatalog(kobai)).merchant;

    const first = await createCollection(kobai, merchant, "Summer");
    const second = await createCollection(kobai, merchant, "Summer");

    // Not `role-name-taken`'s answer one table along, and the contrast is the decision: a
    // Merchant is created *against a Role by name*, so two Roles sharing one could not be told
    // apart. Nothing addresses a Collection by title.
    expect(second.id).not.toEqual(first.id);
  });

  it("refuses a body that names nothing it would change", async () => {
    await using kobai = await createTestKobai();
    const merchant = (await seedTestCatalog(kobai)).merchant;
    const summer = await createCollection(kobai, merchant, "Summer");

    const response = await kobai.request(`/admin/collections/${summer.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      // `products` is not a field this route has — membership is `collections` on the Product's
      // own `PATCH` — so the schema strips it and what arrives is an empty body, which is
      // exactly the case ADR-0062's refusal is for.
      body: JSON.stringify({ products: [{ id: summer.id }] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("answers collection-not-found for an address naming no Collection", async () => {
    await using kobai = await createTestKobai();
    const merchant = (await seedTestCatalog(kobai)).merchant;

    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", JSON.stringify({ title: "Anything" })],
      ["DELETE", undefined],
    ] as const) {
      const response = await kobai.request(`/admin/collections/${ABSENT}`, {
        method,
        headers:
          body === undefined
            ? merchant.headers
            : { ...merchant.headers, "content-type": "application/json" },
        body,
      });

      expect(response.status, method).toBe(404);
      await expect(response.json(), method).resolves.toMatchObject({
        reason: "collection-not-found",
      });
    }
  });
});

describe("a Product is in as many Collections as a Merchant put it in", () => {
  it("is grouped, regrouped and ungrouped by one field", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const summer = await createCollection(kobai, catalog.merchant, "Summer");
    const cheap = await createCollection(kobai, catalog.merchant, "Under 20");

    // Story 14: several at once, which is the whole reason this is a join table.
    const both = await group(kobai, catalog, catalog.productId, [summer.id, cheap.id]);
    expect(both.status).toBe(200);
    // By **title** and not in the order the request named them — a set has no order, so what a
    // read answers with is one kobai chose rather than one a caller has to keep in step.
    expect(both.body.collections.map((one) => one.title)).toEqual(["Summer", "Under 20"]);

    // The whole set, so an entry left out is a membership removed.
    const narrowed = await group(kobai, catalog, catalog.productId, [cheap.id]);
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.collections.map((one) => one.id)).toEqual([cheap.id]);

    // And an empty list takes it out of everything, which is the only way to say that.
    const ungrouped = await group(kobai, catalog, catalog.productId, []);
    expect(ungrouped.status).toBe(200);
    expect(ungrouped.body.collections).toEqual([]);

    // Both Collections are still there: what went was a membership, not a grouping.
    const still = await kobai.request("/admin/collections", {
      headers: catalog.merchant.headers,
    });
    const listed = (await still.json()) as { collections: readonly Collection[] };
    expect(listed.collections.map((one) => one.id).sort()).toEqual(
      [summer.id, cheap.id].sort(),
    );
  });

  it("reports its Collections on the list shape as well as on the detail", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const summer = await createCollection(kobai, catalog.merchant, "Summer");
    await group(kobai, catalog, catalog.productId, [summer.id]);

    const list = await kobai.request("/admin/products", {
      headers: catalog.merchant.headers,
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { products: readonly Product[] };

    // A Merchant checks that a Product got grouped from the list they grouped it from, which is
    // why this is on both shapes rather than only on the one a detail read answers with.
    expect(body.products[0]?.collections).toEqual([summer]);
  });

  it("refuses a set naming a Collection this Store has not got, and writes nothing", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const summer = await createCollection(kobai, catalog.merchant, "Summer");

    const refused = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      // A well formed body naming a real Collection **and** an absent one, alongside a title
      // this route would otherwise have changed. #255's lesson is the subject: a refusal
      // returned from inside a transaction commits it, so the title below is what says the
      // judgement really did come before every write this request makes.
      body: JSON.stringify({
        title: "A renamed poster",
        collections: [{ id: summer.id }, { id: ABSENT }],
      }),
    });

    // 422 and not 400: the body is well formed and the state of the Store is what refuses it,
    // which is `media-not-found`'s distinction one noun along.
    expect(refused.status).toBe(422);
    const refusal = (await refused.json()) as Refusal;
    expect(refusal.reason).toBe("collection-not-found");
    expect(refusal.error).toContain(ABSENT);

    const after = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    const product = (await after.json()) as Product;
    // Neither half of the request landed — not the membership it could have written, and not
    // the title it was asked for beside it.
    expect(product.collections).toEqual([]);
    expect(product.title).not.toBe("A renamed poster");
  });

  it("refuses the same Collection named twice, because membership is a set", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const summer = await createCollection(kobai, catalog.merchant, "Summer");

    const twice = await group(kobai, catalog, catalog.productId, [summer.id, summer.id]);

    // 400 rather than the unique index refusing the second row from inside the transaction,
    // which would travel as a 500 on a request whose only fault is saying one thing twice.
    expect(twice.status).toBe(400);
    expect(twice.body.reason).toBe("invalid");
  });
});

describe("deleting a Collection ungroups its Products and deletes none of them", () => {
  /**
   * Story 17, asserted directly.
   *
   * **Watched failing** against a `deleteCollection` that deleted the Products it held before
   * deleting the grouping — the shape a "tidy up after yourself" reading of the route produces,
   * which every other case in this file passes against, cleanly. What it takes to see the
   * difference is asking after the Products *by name* once the Collection they were in has gone,
   * which is why this case exists rather than a reading of the DDL.
   */
  it("leaves every Product it held readable, published and sellable", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "published" });
    const key = await createTestApiKey(kobai, catalog.merchant, { name: "a storefront" });
    const second = await anotherProduct(kobai, catalog, "A mug", "MUG");

    const summer = await createCollection(kobai, catalog.merchant, "Summer");
    await group(kobai, catalog, catalog.productId, [summer.id]);
    await group(kobai, catalog, second, [summer.id]);

    const deleted = await kobai.request(`/admin/collections/${summer.id}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    // Not refused, and nothing had to be emptied first — the contrast with `role-in-use` is the
    // decision (ADR-0059): a Role Merchants hold is refused because deleting it takes something
    // away, and this takes away a label.
    expect(deleted.status).toBe(204);

    for (const id of [catalog.productId, second]) {
      const product = await kobai.request(`/admin/products/${id}`, {
        headers: catalog.merchant.headers,
      });
      expect(product.status, `reading ${id} back`).toBe(200);
      const body = (await product.json()) as Product;
      // Ungrouped, and nothing else about it moved.
      expect(body.collections, `${id} after the Collection went`).toEqual([]);
    }

    // And still on the storefront, which is the half a Merchant would actually notice: a
    // cascade onto `core_product` takes the catalog off sale as well as out of the database.
    const onSale = await productIdsIn(kobai, "/store/products", key.headers);
    expect([...onSale].sort()).toEqual([catalog.productId, second].sort());
  });

  it("takes a deleted Product out of the Collections it was in, and leaves them", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const summer = await createCollection(kobai, catalog.merchant, "Summer");
    const second = await anotherProduct(kobai, catalog, "A mug", "MUG");
    await group(kobai, catalog, catalog.productId, [summer.id]);
    await group(kobai, catalog, second, [summer.id]);

    const deleted = await kobai.request(`/admin/products/${second}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    expect(deleted.status).toBe(204);

    // The mirror image of the case above, and the reason both foreign keys cascade: a deleted
    // Product must not be refused for being in a Collection, and must not take one with it.
    const collection = await kobai.request(`/admin/collections/${summer.id}`, {
      headers: catalog.merchant.headers,
    });
    expect(collection.status).toBe(200);

    const left = await productIdsIn(
      kobai,
      `/admin/products?collection=${summer.id}`,
      catalog.merchant.headers,
    );
    expect(left).toEqual([catalog.productId]);
  });
});

describe("both Product lists narrow to one Collection", () => {
  it("answers the Merchant's Products in it, and composes with status", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "published" });
    const summer = await createCollection(kobai, catalog.merchant, "Summer");
    const draft = await anotherProduct(kobai, catalog, "A draft mug", "MUG");
    await kobai.request(`/admin/products/${draft}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "draft" }),
    });
    const ungrouped = await anotherProduct(kobai, catalog, "A lone tote", "TOTE");

    await group(kobai, catalog, catalog.productId, [summer.id]);
    await group(kobai, catalog, draft, [summer.id]);

    const inSummer = await productIdsIn(
      kobai,
      `/admin/products?collection=${summer.id}`,
      catalog.merchant.headers,
    );
    // The Product nobody grouped is absent, and both statuses are present: a Merchant's list is
    // the one place a draft is visible at all.
    expect([...inSummer].sort()).toEqual([catalog.productId, draft].sort());
    expect(inSummer).not.toContain(ungrouped);

    // **The two filters compose**, which is what makes them two predicates in one `and` rather
    // than two branches. Story 16 read literally is a Merchant working on one section of the
    // catalog, and finding the drafts in it is the same question narrowed twice.
    const draftsInSummer = await productIdsIn(
      kobai,
      `/admin/products?collection=${summer.id}&status=draft`,
      catalog.merchant.headers,
    );
    expect(draftsInSummer).toEqual([draft]);
  });

  /**
   * Story 18, and the one thing the store surface's filter must never become.
   *
   * **Watched failing** against a build whose store reader dropped `IS_PUBLISHED` when a
   * Collection was named: the draft came back, on a publishable key, which is exactly the leak
   * #252 put the status in the route rather than in a parameter to prevent.
   */
  it("answers a storefront the published Products in it and no others", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "published" });
    const key = await createTestApiKey(kobai, catalog.merchant, { name: "a storefront" });
    const draft = await anotherProduct(kobai, catalog, "A draft mug", "MUG");
    await kobai.request(`/admin/products/${draft}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "draft" }),
    });

    const summer = await createCollection(kobai, catalog.merchant, "Summer");
    await group(kobai, catalog, catalog.productId, [summer.id]);
    await group(kobai, catalog, draft, [summer.id]);

    const browsing = await productIdsIn(
      kobai,
      `/store/products?collection=${summer.id}`,
      key.headers,
    );
    expect(browsing).toEqual([catalog.productId]);
  });

  it("carries a Product's Collections to a storefront, on both store shapes", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "published" });
    const key = await createTestApiKey(kobai, catalog.merchant, { name: "a storefront" });
    const summer = await createCollection(kobai, catalog.merchant, "Summer", {
      blurb: "for the beach",
    });
    await group(kobai, catalog, catalog.productId, [summer.id]);

    const listed = await kobai.request("/store/products", { headers: key.headers });
    const list = (await listed.json()) as { products: readonly Product[] };
    // The whole entry rather than its `id`: the shape is what a storefront renders a breadcrumb
    // out of, so a field that stopped being published would go unnoticed by a containment check.
    expect(list.products[0]?.collections).toEqual([
      { id: summer.id, title: "Summer", metadata: { blurb: "for the beach" } },
    ]);

    const opened = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: key.headers,
    });
    const detail = (await opened.json()) as Product;
    // On the detail too, which is where the breadcrumb actually goes — and it is the same
    // answer, because the detail shape extends the list one.
    expect(detail.collections).toEqual(list.products[0]?.collections);
  });

  it("refuses a Collection this Store has not got rather than answering an empty page", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "published" });
    const key = await createTestApiKey(kobai, catalog.merchant, { name: "a storefront" });

    for (const [path, headers] of [
      [`/admin/products?collection=${ABSENT}`, catalog.merchant.headers],
      [`/store/products?collection=${ABSENT}`, key.headers],
      // Not an identifier at all, which is the same mistake and gets the same sentence: this
      // parameter takes the `id` of a Collection, and neither of these is one.
      ["/admin/products?collection=summer", catalog.merchant.headers],
      ["/store/products?collection=summer", key.headers],
    ] as const) {
      const response = await kobai.request(path, { headers });

      // The failure this promise exists for is a **200 with an empty list**, which a caller
      // reads as *there is nothing in that Collection* rather than as *there is no such
      // Collection* (#209).
      expect(response.status, path).toBe(400);
      await expect(response.json(), path).resolves.toMatchObject({ reason: "invalid" });
    }
  });
});

/**
 * A well formed identifier that names nothing, and never will.
 *
 * A constant rather than a fresh `randomUUID` per case, so the sentence a refusal names is the
 * one a reader of a failure sees quoted back.
 */
const ABSENT = "00000000-0000-4000-8000-000000000000";
