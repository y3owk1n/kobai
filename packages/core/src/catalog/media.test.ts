import { describe, expect, it } from "vitest";
import type { MediaStorage } from "../media/storage.ts";
import {
  createTestKobai,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * Media attached to a Product and to a Variant, in the order a Merchant sets (#255).
 *
 * **Through HTTP, because all of it is a promise about a request and a response**: what
 * `PATCH /admin/products/{id}` does with a `media` list, what a storefront is handed for a
 * Product and for one Variant of it, and — the half the ticket asks to be decided out loud —
 * that detaching an image and deleting the Product it was on both leave the Media exactly where
 * it was (ADR-0082).
 *
 * **Two of these were watched failing before they were made to pass**, and each says so where it
 * sits: the order cases against a reader ordering by the Media's own `created_at`, and the
 * store-shape case against an `asStoreMedia` that spread the admin shape instead of naming five
 * fields.
 *
 * Nothing here reaches a network or a real object store. `createTestKobai` points the shipped
 * filesystem storage at a directory of its own and deletes it with the database; the one case
 * about the address substitutes a storage that answers a CDN and holds nothing.
 */

/** A 2×3 PNG, built from the format's own header rather than checked in as a blob. */
function pngBytes(width = 2, height = 3): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

type Media = {
  readonly id: string;
  readonly url: string;
  readonly alt: string | null;
};

type Product = {
  readonly id: string;
  readonly media: readonly Media[];
  readonly variants: readonly { readonly id: string; readonly media: readonly Media[] }[];
};

type Refusal = { readonly reason?: string; readonly error?: string };

/** Uploads one image through the public route, exactly as the Admin's form does. */
async function upload(
  kobai: TestKobai,
  catalog: TestCatalog,
  named: string,
): Promise<Media> {
  const body = new FormData();
  body.set("file", new File([pngBytes()], named, { type: "image/png" }));
  body.set("alt", `The ${named}`);

  // No `content-type` of our own: `FormData` sets one with the boundary it generated.
  const response = await kobai.request("/admin/media", {
    method: "POST",
    headers: catalog.merchant.headers,
    body,
  });
  const media = (await response.json()) as Media;
  if (response.status !== 201) {
    throw new Error(`uploading answered ${response.status}: ${JSON.stringify(media)}`);
  }
  return media;
}

/** What a `PATCH` carrying a `media` list answers, whichever of the two routes it went to. */
async function attach(
  kobai: TestKobai,
  catalog: TestCatalog,
  path: string,
  media: readonly { readonly id: string }[],
): Promise<Response> {
  return kobai.request(path, {
    method: "PATCH",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ media }),
  });
}

/** The Product as `GET /admin/products/{id}` reports it — a read, never the write's answer. */
async function readProduct(kobai: TestKobai, catalog: TestCatalog): Promise<Product> {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Product;
}

/** Every Media this Store still holds, by identifier — the library, whatever is showing it. */
async function library(kobai: TestKobai, catalog: TestCatalog): Promise<string[]> {
  const response = await kobai.request("/admin/media", {
    headers: catalog.merchant.headers,
  });
  expect(response.status).toBe(200);
  const page = (await response.json()) as { readonly media: readonly Media[] };
  return page.media.map((one) => one.id);
}

describe("Media on a Product", () => {
  it("is attached, and reported in the order the Merchant sent", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");
    const back = await upload(kobai, catalog, "back.png");

    const attached = await attach(
      kobai,
      catalog,
      `/admin/products/${catalog.productId}`,
      [{ id: back.id }, { id: front.id }],
    );
    expect(attached.status).toBe(200);

    // The write's own answer and the next read's, because a correction answers with what a read
    // answers with and only asserting on one of them would not say so.
    const answered = (await attached.json()) as Product;
    const read = await readProduct(kobai, catalog);
    for (const product of [answered, read]) {
      // **The order is the request's, not the upload's**, which is the whole of story 9 — `back`
      // was uploaded second and leads because the Merchant said so. Watched failing against a
      // reader ordering by the Media's own `created_at`, which is the plausible wrong answer and
      // is the one an unordered read would have agreed with by accident.
      expect(product.media.map((one) => one.id)).toEqual([back.id, front.id]);
    }

    expect(answered.media[0]).toMatchObject({
      id: back.id,
      url: back.url,
      alt: "The back.png",
    });

    // And the Merchant's **list**, which carries the images as well as the detail does: a catalog
    // grid is nothing but leading images, so a list that reported none would be the shape this
    // field is on `Product` rather than on `ProductDetail` to avoid.
    const listed = await kobai.request("/admin/products", {
      headers: catalog.merchant.headers,
    });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { readonly products: readonly Product[] };
    expect(page.products[0]?.media.map((one) => one.id)).toEqual([back.id, front.id]);
  });

  it("is reordered and detached by sending the list again", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");
    const back = await upload(kobai, catalog, "back.png");
    const path = `/admin/products/${catalog.productId}`;

    await attach(kobai, catalog, path, [{ id: front.id }, { id: back.id }]);

    const reordered = await attach(kobai, catalog, path, [
      { id: back.id },
      { id: front.id },
    ]);
    expect(reordered.status).toBe(200);
    expect((await readProduct(kobai, catalog)).media.map((one) => one.id)).toEqual([
      back.id,
      front.id,
    ]);

    // One of the two left out of the list is detached by that alone: there is no route to call
    // and nothing else to say.
    const dropped = await attach(kobai, catalog, path, [{ id: front.id }]);
    expect(dropped.status).toBe(200);
    expect((await readProduct(kobai, catalog)).media.map((one) => one.id)).toEqual([
      front.id,
    ]);

    // And an empty list detaches everything, which is the only spelling of that there is.
    expect((await attach(kobai, catalog, path, [])).status).toBe(200);
    expect((await readProduct(kobai, catalog)).media).toEqual([]);

    // **Neither Media went anywhere**, which is ADR-0082 and is the assertion this whole file
    // exists to make: what a detach removes is an attachment, and the library is unchanged.
    expect((await library(kobai, catalog)).sort()).toEqual([back.id, front.id].sort());
  });

  it("refuses a list naming a Media this Store does not have, and changes nothing", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");
    const path = `/admin/products/${catalog.productId}`;

    await attach(kobai, catalog, path, [{ id: front.id }]);

    const refused = await attach(kobai, catalog, path, [
      { id: front.id },
      // A well formed identifier naming nothing, which is what a Merchant working from a stale
      // library sends. 422 rather than 400: the body is usable and the Store is what refuses it.
      { id: "00000000-0000-4000-8000-000000000000" },
    ]);
    expect(refused.status).toBe(422);
    expect((await refused.json()) as Refusal).toMatchObject({
      reason: "media-not-found",
    });

    // Every judgement before every write, so a refusal leaves the Product exactly as it was —
    // and not, as a delete-then-insert would leave it, showing nothing at all.
    expect((await readProduct(kobai, catalog)).media.map((one) => one.id)).toEqual([
      front.id,
    ]);
  });

  it("changes nothing else on the Product when it refuses the images", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const path = `/admin/products/${catalog.productId}`;

    // **A refusal returned from inside a transaction commits it**, so a `media` judged after the
    // options had been corrected would answer 422 over a Product whose options really had been
    // renamed — the request refused and half of it done. That is what `catalog/media.ts` exports
    // the question apart from the write for. Watched failing against the build that judged
    // inside `setProductMedia`: the Product came back declaring `Colour`.
    const refused = await kobai.request(path, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: "A better poster",
        options: [{ name: "Colour" }],
        media: [{ id: "00000000-0000-4000-8000-000000000000" }],
      }),
    });
    expect(refused.status).toBe(422);
    expect((await refused.json()) as Refusal).toMatchObject({
      reason: "media-not-found",
    });

    const after = (await readProduct(kobai, catalog)) as Product & {
      readonly title: string;
      readonly options: readonly { readonly name: string }[];
    };
    expect(after.title).toBe("A poster");
    expect(after.options).toEqual([]);
    expect(after.media).toEqual([]);
  });

  it("refuses the same Media twice in one list", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");

    const refused = await attach(kobai, catalog, `/admin/products/${catalog.productId}`, [
      { id: front.id },
      { id: front.id },
    ]);
    // 400 and not 422: two positions for one image is a body that cannot be used, whatever the
    // Store holds — and it is the refusal rather than the unique index answering, which would
    // have been a 500 on a request kobai can perfectly well describe.
    expect(refused.status).toBe(400);
    expect((await refused.json()) as Refusal).toMatchObject({ reason: "invalid" });
  });

  it("survives the Product it was attached to being deleted", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");

    await attach(kobai, catalog, `/admin/products/${catalog.productId}`, [
      { id: front.id },
    ]);

    const deleted = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    // 204 rather than a 500 is half the assertion: the attachment rows go by cascade, and a
    // schema that kept them would have made this a foreign-key violation.
    expect(deleted.status).toBe(204);

    // The other half, and the one a Merchant would notice: the photograph is still theirs.
    expect(await library(kobai, catalog)).toEqual([front.id]);
  });
});

describe("Media on a Variant", () => {
  it("is attached to the Variant and not to its Product", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const red = await upload(kobai, catalog, "red.png");
    const generic = await upload(kobai, catalog, "generic.png");

    await attach(kobai, catalog, `/admin/products/${catalog.productId}`, [
      { id: generic.id },
    ]);
    const attached = await attach(
      kobai,
      catalog,
      `/admin/variants/${catalog.variantId}`,
      [{ id: red.id }],
    );
    expect(attached.status).toBe(200);

    const product = await readProduct(kobai, catalog);
    // **The two lists are separate and neither falls back to the other**, which is what lets a
    // storefront decide whether picking a colour replaces the gallery or adds to it.
    expect(product.media.map((one) => one.id)).toEqual([generic.id]);
    expect(product.variants[0]?.media.map((one) => one.id)).toEqual([red.id]);
  });

  it("survives the Variant being deleted", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "POSTER-A2" }, { sku: "POSTER-A3" }],
    });
    const red = await upload(kobai, catalog, "red.png");

    await attach(kobai, catalog, `/admin/variants/${catalog.variant("POSTER-A3").id}`, [
      { id: red.id },
    ]);

    const deleted = await kobai.request(
      `/admin/variants/${catalog.variant("POSTER-A3").id}`,
      { method: "DELETE", headers: catalog.merchant.headers },
    );
    expect(deleted.status).toBe(204);
    expect(await library(kobai, catalog)).toEqual([red.id]);
  });

  it("refuses a Media this Store does not have, at the same word and the same status", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const refused = await attach(kobai, catalog, `/admin/variants/${catalog.variantId}`, [
      { id: "00000000-0000-4000-8000-000000000000" },
    ]);
    // One fact about a `media` list, so one word and one status wherever the list was sent.
    expect(refused.status).toBe(422);
    expect((await refused.json()) as Refusal).toMatchObject({
      reason: "media-not-found",
    });
  });
});

describe("what a storefront is shown", () => {
  it("carries a Product's Media in order, on the list and on the detail", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");
    const back = await upload(kobai, catalog, "back.png");

    await attach(kobai, catalog, `/admin/products/${catalog.productId}`, [
      { id: back.id },
      { id: front.id },
    ]);

    const listed = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { readonly products: readonly Product[] };
    expect(page.products[0]?.media.map((one) => one.id)).toEqual([back.id, front.id]);

    const opened = await kobai.request("/store/products/a-poster", {
      headers: catalog.apiKey.headers,
    });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as Product).media.map((one) => one.id)).toEqual([
      back.id,
      front.id,
    ]);
  });

  it("carries a Variant's own Media, at its own route and inside its Product", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const red = await upload(kobai, catalog, "red.png");

    await attach(kobai, catalog, `/admin/variants/${catalog.variantId}`, [
      { id: red.id },
    ]);

    const opened = await kobai.request("/store/products/a-poster", {
      headers: catalog.apiKey.headers,
    });
    const product = (await opened.json()) as Product;
    expect(product.variants[0]?.media.map((one) => one.id)).toEqual([red.id]);

    // The Variant's own route answers the same list, because a Cart line carries a `variantId`
    // and nothing else — rebuilding a page from one should not mean fetching the whole Product.
    const variant = await kobai.request(`/store/variants/${catalog.variantId}`, {
      headers: catalog.apiKey.headers,
    });
    expect(variant.status).toBe(200);
    expect(
      ((await variant.json()) as { readonly media: readonly Media[] }).media,
    ).toEqual([{ id: red.id, url: red.url, alt: "The red.png", width: 2, height: 3 }]);
  });

  it("publishes nothing about the file, which is what the store shape drops", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");

    await attach(kobai, catalog, `/admin/products/${catalog.productId}`, [
      { id: front.id },
    ]);

    const opened = await kobai.request("/store/products/a-poster", {
      headers: catalog.apiKey.headers,
    });
    const shown = ((await opened.json()) as Product).media[0] as
      | Record<string, unknown>
      | undefined;

    // A promise about what is **not** in a response is the one nothing else notices going
    // missing, which is why `store.test.ts` asserts `inventory`, `prices` and `status` the same
    // way. Watched failing against an `asStoreMedia` that spread the admin shape through.
    expect(Object.keys(shown ?? {}).sort()).toEqual([
      "alt",
      "height",
      "id",
      "url",
      "width",
    ]);

    // And the admin surface still carries all three, so this is a narrowing rather than a
    // column nobody records.
    const merchantsView = (await readProduct(kobai, catalog)).media[0] as
      | Record<string, unknown>
      | undefined;
    expect(merchantsView).toMatchObject({
      filename: "front.png",
      contentType: "image/png",
      byteSize: 24,
    });
  });
});

describe("where the bytes are", () => {
  it("is the storage's answer on an attached Media too, not a stored column", async () => {
    // A bucket behind a CDN: it answers an address of its own and serves no byte through kobai,
    // which is the case ADR-0078 exists for. What this asserts is that attaching a Media does
    // not put it on some other path — the `url` a Product reports is the same question asked of
    // the same storage.
    const cdn: MediaStorage = {
      put: async () => ({ key: "abcdef" }),
      urlFor: (key) => `https://cdn.example.com/${key}`,
      read: async () => null,
    };

    await using kobai = await createTestKobai({ media: { storage: cdn } });
    const catalog = await seedTestCatalog(kobai);
    const front = await upload(kobai, catalog, "front.png");
    expect(front.url).toBe("https://cdn.example.com/abcdef");

    await attach(kobai, catalog, `/admin/products/${catalog.productId}`, [
      { id: front.id },
    ]);

    const opened = await kobai.request("/store/products/a-poster", {
      headers: catalog.apiKey.headers,
    });
    expect(((await opened.json()) as Product).media[0]?.url).toBe(
      "https://cdn.example.com/abcdef",
    );
  });
});
