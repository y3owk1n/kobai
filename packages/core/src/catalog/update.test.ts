import { afterEach, describe, expect, it } from "vitest";
import type { ReservedLines } from "../order/place-order.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";

/**
 * Correcting a Variant, and the property that makes correcting one safe at all.
 *
 * ADR-0009 says an Order's Line Items snapshot everything precisely so that catalog data
 * stays freely *mutable*, and until this route existed that half of the claim had no way to
 * be checked — the catalog could only be added to and taken away. Everything here goes
 * through the public HTTP API for that reason, exactly as `deletion.test.ts` does.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

describe("a Variant whose stock is claimed while an Order is being placed", () => {
  it("is corrected anyway, and the Order it was claimed for still completes", async () => {
    const paused = pause();
    kobai = await createTestKobai({
      workflows: { "place-order": { after: { "hold-reservations": [paused.step] } } },
    });
    const catalog = await seedTestCatalog(kobai);
    const headers = catalog.merchant.headers;
    await count(kobai, catalog.variantId, headers, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placing = kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    await paused.reached;

    // ADR-0059 refuses a *delete* here, because releasing a live hold fails a Capture past
    // `take-payment` and a Shopper is charged and refunded. An update takes nothing away: the
    // row stays, its Inventory row stays, and a Reservation names its subject by the Variant's
    // identifier, which is the one thing on the record that cannot be corrected. So there is
    // nothing for this to defend, and a refusal here would only make fixing a typo wait on a
    // stranger's checkout (ADR-0062).
    const corrected = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        sku: "POSTER-A2-REV-B",
        fulfilment: { strategy: "digital" },
      }),
    });
    expect(corrected.status).toBe(200);

    // The delete beside it *is* still refused, so the contrast is asserted rather than
    // described: these two routes answer differently about the same live hold, on purpose.
    const deleted = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "DELETE",
      headers,
    });
    expect(deleted.status).toBe(409);
    await expect(deleted.json()).resolves.toMatchObject({ reason: "stock-is-reserved" });

    paused.release();
    const placed = await placing;

    // The hold was consumed, under the SKU it was never named by: two units off a shelf of
    // three, and a Line Item saying what the catalog said when the Cart was loaded.
    expect(placed.status).toBe(201);
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({
      onHand: 1,
      reserved: 0,
    });
    await expect(placed.json()).resolves.toMatchObject({
      lineItems: [{ sku: "POSTER-A2", quantity: 2 }],
    });
  });
});

/** Counts a Variant's stock, which is the arrangement every Strategy swap below is about. */
async function count(
  kobai: TestKobai,
  variantId: string,
  headers: Record<string, string>,
  onHand: number,
): Promise<void> {
  const response = await kobai.request(`/admin/variants/${variantId}/inventory`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
  if (response.status !== 200) {
    throw new Error(`Counting ${variantId} answered ${response.status}.`);
  }
}

/** What the Store has of a Variant, as a Merchant reads it — `null` when nobody counts it. */
async function stockOf(
  kobai: TestKobai,
  catalog: {
    productId: string;
    variantId: string;
    merchant: { headers: Record<string, string> };
  },
): Promise<unknown> {
  const product = (await (
    await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    })
  ).json()) as { variants: { id: string; inventory: unknown }[] };
  return product.variants.find((row) => row.id === catalog.variantId)?.inventory;
}

describe("swapping a Variant's Fulfilment Strategy", () => {
  it("leaves the stock count alone, and stops selling from it", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = catalog.merchant.headers;
    await count(kobai, catalog.variantId, headers, 5);

    const swapped = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fulfilment: { strategy: "digital" } }),
    });

    expect(swapped.status).toBe(200);
    await expect(swapped.json()).resolves.toMatchObject({
      fulfilment: { strategy: "digital" },
      // The count is untouched and still reported. Deleting it would discard a number a
      // Merchant went and counted, and would take it out from under any hold standing on it —
      // which is the delete ADR-0059 refuses, arrived at through an update (ADR-0062).
      inventory: { onHand: 5, reserved: 0, available: 5 },
    });

    const order = await seedTestOrder(kobai, { catalog, quantity: 2 });
    // Nothing came off the shelf, because the Strategy answers whether stock is involved and
    // the row only ever said how many (ADR-0014). The poster is a download now.
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({
      onHand: 5,
      reserved: 0,
    });
    await expect(
      (await kobai.request(`/admin/orders/${order.id}`, { headers })).json(),
    ).resolves.toMatchObject({ fulfilments: [{ strategy: "digital" }] });
  });

  it("sells from that same count again when it is swapped back", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }],
    });
    const headers = catalog.merchant.headers;
    await count(kobai, catalog.variantId, headers, 5);

    const swapped = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ fulfilment: { strategy: "physical" } }),
    });
    expect(swapped.status).toBe(200);

    await seedTestOrder(kobai, { catalog, quantity: 2 });
    // The row that was standing idle under a `digital` Variant is the shelf a `physical` one
    // sells from — so the swap orphaned nothing, in either direction.
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({
      onHand: 3,
      reserved: 0,
    });
  });

  it("leaves a Variant nobody has counted selling freely", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }],
    });

    const swapped = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ fulfilment: { strategy: "physical" } }),
    });

    // Untracked, and that is a state creation already produces: a `physical` Variant nobody
    // has counted sells freely and holds no Reservation (ADR-0018). So this swap is not
    // refused for want of a shelf, and the Merchant's next call is `PUT …/inventory`.
    expect(swapped.status).toBe(200);
    await expect(swapped.json()).resolves.toMatchObject({ inventory: null });
    const order = await seedTestOrder(kobai, { catalog, quantity: 99 });
    expect(order.total).toBe(99 * 1250);
  });

  it("refuses a Strategy this deployment has not wired, and changes nothing", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = catalog.merchant.headers;

    const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sku: "MUG", fulfilment: { strategy: "made-to-order" } }),
    });

    // The same 422 creating one is refused with, for the same reason: a Variant pointing at a
    // Strategy nothing has wired cannot answer the three questions and so cannot be sold. The
    // SKU beside it does not move either — one statement, so a refusal leaves the whole row.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unknown-fulfilment-strategy",
    });
    await expect(
      (await kobai.request(`/admin/products/${catalog.productId}`, { headers })).json(),
    ).resolves.toMatchObject({
      variants: [{ sku: "POSTER-A2", fulfilment: { strategy: "physical" } }],
    });
  });
});

describe("PATCH /admin/products/{id}", () => {
  it("changes the title, and answers with the Product as a read would report it", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = catalog.merchant.headers;

    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "A2 poster, second edition" }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated).toMatchObject({
      id: catalog.productId,
      title: "A2 poster, second edition",
    });

    // The same bytes a read reports, because the answer is read back rather than assembled
    // from what went in — and a Product read carries its Variants, so a rename cannot quietly
    // report a different shape from the route a Merchant looks at it through.
    await expect(
      (await kobai.request(`/admin/products/${catalog.productId}`, { headers })).json(),
    ).resolves.toEqual(updated);
  });

  it("leaves out what the body left out, and replaces the metadata it names", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };
    const address = `/admin/products/${catalog.productId}`;
    await kobai.request(address, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ metadata: { shelf: "A", campaign: "spring" } }),
    });

    const response = await kobai.request(address, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ metadata: { shelf: "B" } }),
    });

    // The title is untouched because the body did not mention it, and the bag is *replaced*
    // rather than merged — a merge would leave no way to take `campaign` back out, which is
    // the same judgement `PATCH /admin/variants/{id}` makes about the same field (ADR-0062).
    //
    // **`toEqual` on the bag, and that is the whole assertion**: `toMatchObject` matches a
    // nested object as a *subset*, so a merge leaving `campaign` beside `shelf` would satisfy
    // it — the one implementation this case exists to rule out would pass.
    expect(response.status).toBe(200);
    const corrected = (await response.json()) as {
      title: string;
      metadata: Record<string, unknown>;
    };
    expect(corrected.title).toBe("A poster");
    expect(corrected.metadata).toEqual({ shelf: "B" });
  });

  it("writes a description, corrects it, and takes it back off again", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };
    const address = `/admin/products/${catalog.productId}`;

    /** What this Product says about itself after one `PATCH` of the body given. */
    const patch = async (body: Record<string, unknown>) => {
      const response = await kobai?.request(address, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
      expect(response?.status, JSON.stringify(body)).toBe(200);
      return (await response?.json()) as { title: string; description: string | null };
    };

    // A Product seeded without one holds none, which is the state `null` puts it back into
    // below — so this is the assertion the last one is measured against.
    const before = await patch({ title: "A poster" });
    expect(before.description).toBeNull();

    expect((await patch({ description: "Printed on 200gsm stock." })).description).toBe(
      "Printed on 200gsm stock.",
    );

    // Absent means "leave it", exactly as it does for the title beside it: correcting one
    // must not silently clear the other.
    const renamed = await patch({ title: "A poster, second edition" });
    expect(renamed.title).toBe("A poster, second edition");
    expect(renamed.description).toBe("Printed on 200gsm stock.");

    expect((await patch({ description: "Printed on 300gsm stock." })).description).toBe(
      "Printed on 300gsm stock.",
    );

    // `null` is how copy is taken back off, and there is no other way: an absent field means
    // "leave it" and an empty string is refused, so without this a description a Merchant
    // wrote by mistake could be rewritten for ever and never removed.
    expect((await patch({ description: null })).description).toBeNull();

    // And through the route a Merchant reads it back with, rather than only through what the
    // correction answered.
    await expect(
      (await kobai.request(address, { headers: catalog.merchant.headers })).json(),
    ).resolves.toMatchObject({ description: null });
  });

  it("refuses an empty description rather than storing one", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    // `""` is not how a description is removed — `null` is. Storing it would leave the two
    // spellings of "there is no copy here" both reachable, and a storefront branching on one
    // of them would render an empty paragraph for the other.
    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ description: "   " }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("moves the handle, and the storefront address moves with it", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };

    const corrected = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ handle: "the-blue-one" }),
    });

    expect(corrected.status).toBe(200);
    await expect(corrected.json()).resolves.toMatchObject({ handle: "the-blue-one" });

    // The point of correcting one, asserted where it can be seen: the Product answers at its
    // new address on the store surface, and at the old one it answers to nothing. That second
    // half is what makes a handle change a thing to warn a Merchant about rather than a typo
    // fix like the title beside it.
    const moved = await kobai.request("/store/products/the-blue-one", {
      headers: catalog.apiKey.headers,
    });
    expect(moved.status).toBe(200);
    const gone = await kobai.request("/store/products/a-poster", {
      headers: catalog.apiKey.headers,
    });
    expect(gone.status).toBe(404);
  });

  it("refuses a handle another Product answers to, and leaves both alone", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };
    const second = await kobai.request("/admin/products", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "A mug", variants: [{ sku: "MUG" }] }),
    });
    const other = (await second.json()) as { id: string; handle: string };

    const response = await kobai.request(`/admin/products/${other.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ handle: "a-poster" }),
    });

    // Creation's own word, at creation's own status, because it is one fact about the Store
    // rather than about the route (ADR-0060) — the same thing `sku-taken` does for a Variant.
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "handle-taken" });

    const unchanged = await kobai.request(`/admin/products/${other.id}`, {
      headers: catalog.merchant.headers,
    });
    await expect(unchanged.json()).resolves.toMatchObject({ handle: "a-mug" });
  });

  it("refuses a handle that reads as an identifier, and takes back the one it holds", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };

    // The correction is read by the very narrowing a create is read by, so what a Merchant
    // could not have created a Product with is what they cannot correct one to.
    const asIdentifier = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ handle: catalog.productId }),
    });
    expect(asIdentifier.status).toBe(400);
    await expect(asIdentifier.json()).resolves.toMatchObject({ reason: "invalid" });

    // And there is no `null` here as there is for the description: a Product with no address
    // is not a state that exists, so asking for one is the ordinary refusal rather than the
    // removal that spelling means one field along.
    const removed = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ handle: null }),
    });
    expect(removed.status).toBe(400);
  });

  it("publishes a draft, and the storefront can see it by both its addresses", async () => {
    // Story 6, end to end and in one place: a Merchant decides a Product is ready, and the
    // deciding is this request. What makes it a decision rather than a formality is the state
    // before it — `seedTestCatalog({ status: "draft" })` leaves the Product exactly where
    // `POST /admin/products` leaves one — so the 404s below are the *before* rather than the
    // arrangement being wrong.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "draft" });
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };

    const hidden = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });
    await expect(hidden.json()).resolves.toEqual({ products: [] });

    const published = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "published" }),
    });

    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({ status: "published" });

    const listed = await kobai.request("/store/products", {
      headers: catalog.apiKey.headers,
    });
    await expect(listed.json()).resolves.toMatchObject({
      products: [{ id: catalog.productId }],
    });
    for (const address of [catalog.productId, "a-poster"]) {
      const shown = await kobai.request(`/store/products/${address}`, {
        headers: catalog.apiKey.headers,
      });
      expect(shown.status, `/store/products/${address}`).toBe(200);
    }
  });

  it("archives a published Product, and leaves the Order placed from it alone", async () => {
    // Story 7, and the whole reason archiving exists beside `DELETE /admin/products/{id}`: the
    // Product leaves the storefront and **the Order that was placed from it reads back
    // unchanged**. That is ADR-0009's snapshot doing the work — so the assertion is the Order
    // rather than the catalog, because "it disappeared from the store" is true of a delete too
    // and only one of the two is safe to do to something that has been sold.
    kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const catalog = order.catalog;
    const before = await kobai.request(`/admin/orders/${order.id}`, {
      headers: catalog.merchant.headers,
    });
    const asPlaced = await before.json();

    const archived = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ status: "archived" }),
    });

    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({ status: "archived" });

    const gone = await kobai.request(`/store/products/${catalog.productId}`, {
      headers: catalog.apiKey.headers,
    });
    expect(gone.status).toBe(404);
    // Byte for byte, which is the promise: an archived Product rewrites nothing anybody has
    // been charged for.
    const after = await kobai.request(`/admin/orders/${order.id}`, {
      headers: catalog.merchant.headers,
    });
    await expect(after.json()).resolves.toEqual(asPlaced);
  });

  it("puts an archived Product back into draft, so nothing here is one-way", async () => {
    // Every one of the three is reachable from every other, because `status` is a field of an
    // ordinary correction rather than a pair of one-way routes. A Merchant who archived the
    // wrong Product has a way back that is not raw SQL.
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { status: "archived" });
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };

    const redrafted = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "draft" }),
    });

    expect(redrafted.status).toBe(200);
    await expect(redrafted.json()).resolves.toMatchObject({ status: "draft" });
  });

  it("refuses a status kobai does not have, and leaves the Product where it was", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };

    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "live" }),
    });

    // Refused by the schema, before the handler runs — `invalid`, which is what that word
    // already means for a request that does not fit the endpoint.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
    // And nothing moved, which is the half a refusal is only half of.
    const unchanged = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });
    await expect(unchanged.json()).resolves.toMatchObject({ status: "published" });
  });

  it("refuses a body that names nothing it could change", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const body of [{}, { variants: [{ sku: "MUG" }] }]) {
      const response = await kobai.request(`/admin/products/${catalog.productId}`, {
        method: "PATCH",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // The second body is the first one: a field this route does not carry is stripped
      // before the handler sees it, so "I sent a Variant and nothing happened" and "I sent
      // nothing" are one request — and this refusal is where a Merchant is told where a
      // Variant is added instead.
      expect(response.status, JSON.stringify(body)).toBe(400);
      const refusal = (await response.json()) as { reason: string; error: string };
      expect(refusal.reason).toBe("invalid");
      expect(refusal.error).toContain("/variants");
    }
  });

  it("answers 404 for a Product that does not exist, and for an id that is not one", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["2f1b8a5e-0000-4000-8000-000000000000", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/products/${id}`, {
        method: "PATCH",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ title: "Anything" }),
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "product-not-found",
      });
    }
  });
});

describe("an Order does not depend on the catalog it was placed from", () => {
  it("reads back byte for byte when the Product it was placed from is renamed", async () => {
    kobai = await createTestKobai();
    const order = await seedTestOrder(kobai, { quantity: 2 });
    const headers = order.catalog.merchant.headers;
    const address = `/admin/orders/${order.id}`;

    const before = await (await kobai.request(address, { headers })).text();

    const renamed = await kobai.request(`/admin/products/${order.catalog.productId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ title: "A2 poster, second edition" }),
    });
    expect(renamed.status).toBe(200);

    // A Line Item snapshots the title it was bought under (ADR-0009), so an Order placed
    // before the correction still says what the Merchant was selling then. That is the whole
    // reason a Product's title is safe to move at all, and it is only worth asserting because
    // the old title is in the body being compared — checked below.
    const after = await kobai.request(address, { headers });
    expect(after.status).toBe(200);
    await expect(after.text()).resolves.toBe(before);
    expect(before).toContain("A poster");
  });

  it("reads back byte for byte when the Variant it named is corrected", async () => {
    kobai = await createTestKobai();
    const order = await seedTestOrder(kobai, { quantity: 2 });
    const headers = order.catalog.merchant.headers;
    const address = `/admin/orders/${order.id}`;

    const before = await (await kobai.request(address, { headers })).text();

    // Both of the things this route exists to move, on the very Variant that was bought: the
    // SKU the Line Item snapshotted, and the Strategy the Fulfilment recorded at Capture.
    const corrected = await kobai.request(`/admin/variants/${order.catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        sku: "POSTER-A2-REV-B",
        fulfilment: { strategy: "digital" },
        metadata: { print: "giclée" },
      }),
    });
    expect(corrected.status).toBe(200);

    // As text rather than as a parsed object, because the claim is that *nothing* moved: the
    // Line Item still says `POSTER-A2` at 1250, the Fulfilment still says it ships and comes
    // off a shelf, and the reference to the Variant is still there because the Variant is.
    // This is ADR-0009's whole promise, and it is only worth anything asserted after a write
    // that would have broken it under a live join.
    const after = await kobai.request(address, { headers });
    expect(after.status).toBe(200);
    await expect(after.text()).resolves.toBe(before);
    // …and the comparison is only worth what it is compared *about*: both of the words this
    // correction changed on the catalog are in that body, so an Order that had joined to the
    // row would have moved.
    expect(before).toContain("POSTER-A2");
    expect(before).toContain("physical");
  });
});

describe("PATCH /admin/variants/{id}", () => {
  it("changes the SKU, and answers with the Variant as a read would report it", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = catalog.merchant.headers;

    const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sku: "POSTER-A2-REV-B" }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated).toMatchObject({ id: catalog.variantId, sku: "POSTER-A2-REV-B" });

    // The same bytes a read reports, because the answer is read back rather than assembled
    // from what went in — the property `createProduct` keeps for the same reason.
    const product = (await (
      await kobai.request(`/admin/products/${catalog.productId}`, { headers })
    ).json()) as { variants: unknown[] };
    expect(product.variants).toEqual([updated]);
  });

  it("leaves out what the body left out, and replaces the metadata it names", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }],
    });
    const headers = catalog.merchant.headers;

    const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { edition: "second" } }),
    });

    // The Strategy is untouched because the body did not mention it — which is the whole of
    // why this is a `PATCH`: under a `PUT`, a client that sent only its metadata would have
    // made this a poster again, and one that sent only its SKU would have emptied the bag.
    expect(response.status).toBe(200);
    const corrected = (await response.json()) as {
      sku: string;
      fulfilment: { strategy: string };
      metadata: Record<string, unknown>;
    };
    expect(corrected).toMatchObject({ sku: "PDF", fulfilment: { strategy: "digital" } });
    // `toEqual` on the bag, exactly as the Product's and the Store's versions of this case
    // do it: a subset match around a bag permits the keys a merge would have left beside
    // `edition`, which is the implementation this case exists to rule out.
    expect(corrected.metadata).toEqual({ edition: "second" });

    // Replaced rather than merged: a merge would leave no way to take a key back out.
    //
    // `toEqual` on the bag rather than `toMatchObject` around it, because an empty object is a
    // subset of every object — the version of this assertion that read
    // `toMatchObject({ metadata: {} })` passed just as happily against a merge that had kept
    // `edition`, which is the one thing it exists to catch (#172).
    const emptied = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ metadata: {} }),
    });
    const bag = (await emptied.json()) as { metadata: Record<string, unknown> };
    expect(bag.metadata).toEqual({});
  });

  it("refuses a SKU another Variant carries, and leaves both alone", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [400] }],
    });
    const headers = catalog.merchant.headers;

    const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ sku: "MUG" }),
    });

    // The unique index is what answers this, exactly as it answers for a create: two Merchants
    // renaming two Variants to one SKU at the same instant cannot both be told there was no
    // such SKU (ADR-0018).
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "sku-taken" });
    await expect(
      (await kobai.request(`/admin/products/${catalog.productId}`, { headers })).json(),
    ).resolves.toMatchObject({ variants: [{ sku: "MUG" }, { sku: "POSTER-A2" }] });
  });

  it("takes a Variant to the SKU it already carries", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ sku: "POSTER-A2" }),
    });

    // A row does not conflict with itself, so sending the whole record back unchanged is not
    // a mistake this route punishes — which is what makes it usable from a form.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sku: "POSTER-A2" });
  });

  it("refuses a body that names nothing it could change", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const body of [{}, { amount: 900 }]) {
      const response = await kobai.request(`/admin/variants/${catalog.variantId}`, {
        method: "PATCH",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // The second body is the first one: a field this route does not carry is stripped before
      // the handler sees it, so "I sent a price and nothing happened" and "I sent nothing" are
      // the same request — and this refusal is where a Merchant is told where a Price is set.
      expect(response.status, JSON.stringify(body)).toBe(400);
      const refusal = (await response.json()) as { reason: string; error: string };
      expect(refusal.reason).toBe("invalid");
      expect(refusal.error).toContain("/prices");
    }
  });

  it("answers 404 for a Variant that does not exist, and for an id that is not one", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["2f1b8a5e-0000-4000-8000-000000000000", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/variants/${id}`, {
        method: "PATCH",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ sku: "ANYTHING" }),
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "variant-not-found",
      });
    }
  });
});

/**
 * A Step that stops a placement where a test wants to look at what the hold did.
 *
 * The same shape `deletion.test.ts` uses, and deliberately a second copy rather than something
 * exported and shared: what a test pauses at differs, and a helper two test files reached into
 * would be a seam nobody dispatches requests at.
 */
function pause() {
  let reached = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    step: defineStep("pause", async (input: ReservedLines): Promise<ReservedLines> => {
      reached();
      await held;
      return input;
    }),
    reached: arrived,
    release: () => {
      release();
    },
  };
}
