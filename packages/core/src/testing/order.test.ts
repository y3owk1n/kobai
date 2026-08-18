import { describe, expect, it } from "vitest";
import { createTestApiKey } from "./api-key.ts";
import { seedTestCart } from "./cart.ts";
import { seedTestCatalog } from "./catalog.ts";
import { createTestKobai } from "./kobai.ts";
import { seedTestOrder } from "./order.ts";

/**
 * The Order seam of `@kobai/core/testing`, asserted at the surface it promises.
 *
 * This helper is promised surface under ADR-0019 and ADR-0047, so what it places is asked of
 * the running application rather than of the object it hands back — an assertion against its
 * own return value would agree with itself however wrong the arrangement was.
 */

/** What `GET /store/orders/{id}` answers with, as far as anything here reads it. */
type OrderBody = {
  readonly id: string;
  readonly number: number;
  readonly currency: string;
  readonly total: number;
  readonly lineItems: readonly {
    id: string;
    variantId: string | null;
    sku: string;
    unitAmount: number;
    quantity: number;
    total: number;
  }[];
};

async function readOrder(
  kobai: Awaited<ReturnType<typeof createTestKobai>>,
  order: { id: string; apiKey: { headers: Record<string, string> } },
): Promise<OrderBody> {
  const response = await kobai.request(`/store/orders/${order.id}`, {
    headers: order.apiKey.headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as OrderBody;
}

describe("seeding an Order", () => {
  it("gives an untold test one placed Order for one of the one Variant", async () => {
    await using kobai = await createTestKobai();

    const order = await seedTestOrder(kobai);

    const body = await readOrder(kobai, order);
    expect(body.id).toBe(order.id);
    expect(body.number).toBe(order.number);
    expect(body.total).toBe(1250);
    expect(body.currency).toBe("USD");
    expect(body.lineItems).toMatchObject([
      { sku: "POSTER-A2", unitAmount: 1250, quantity: 1, total: 1250 },
    ]);
  });

  it("spends the Cart it placed, so the Order really was placed from it", async () => {
    await using kobai = await createTestKobai();

    const order = await seedTestOrder(kobai);

    // A Cart becomes exactly one Order (#102), and a Cart that says `placed` is the
    // application agreeing that this arrangement happened the way a storefront does it.
    const cart = await kobai.request(`/store/carts/${order.cart.id}`, {
      headers: order.cart.apiKey.headers,
    });
    await expect(cart.json()).resolves.toMatchObject({ placed: true, expired: false });
  });

  it("takes a quantity when the test cares how many", async () => {
    await using kobai = await createTestKobai();

    const order = await seedTestOrder(kobai, { quantity: 3 });

    const body = await readOrder(kobai, order);
    expect(body.lineItems[0]).toMatchObject({ quantity: 3, total: 3750 });
    expect(body.total).toBe(3750);
  });

  it("places a Cart a test already built, rather than building a second one", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, {
      shopper: { email: "shopper@example.test" },
    });

    const order = await seedTestOrder(kobai, { cart });

    // The Cart's own arrangement reached the Order, which is what handing one over is for.
    const body = (await (
      await kobai.request(`/store/orders/${order.id}`, { headers: order.apiKey.headers })
    ).json()) as { shopper: { email: string } | null };
    expect(body.shopper).toMatchObject({ email: "shopper@example.test" });
    expect(order.cart).toBe(cart);
  });

  it("builds on a catalog a test already seeded, rather than seeding a second one", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [900] });

    const order = await seedTestOrder(kobai, { catalog });

    // A deployment has only ever one first Merchant (ADR-0041), so handing one over is how a
    // test that has already signed in gets an Order at all — and the Order is for the Price
    // that test set rather than for a second Product beside it.
    expect((await readOrder(kobai, order)).total).toBe(900);
    const products = await kobai.request("/admin/products", {
      headers: order.catalog.merchant.headers,
    });
    const listed = (await products.json()) as { products: readonly unknown[] };
    expect(listed.products).toHaveLength(1);
    expect(order.catalog).toBe(catalog);
  });

  it("places several named Variants, and reports each line by SKU", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [800] }],
    });

    const order = await seedTestOrder(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
    });

    const body = await readOrder(kobai, order);
    expect(body.lineItems.map((line) => [line.sku, line.quantity])).toEqual([
      ["MUG", 2],
      ["POSTER-A2", 1],
    ]);
    // By SKU rather than by position, for the reason `seedTestCart.lineItem` is: an Order
    // reports its lines in SKU order, not in the order they were selected.
    expect(order.lineItem("MUG").total).toBe(1600);
    expect(order.lineItem("MUG").variantId).toBe(catalog.variant("MUG").id);
  });

  it("places with the secret key a test named, so it can name the one it means", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const server = await createTestApiKey(kobai, catalog.merchant, { name: "checkout" });

    const order = await seedTestOrder(kobai, { catalog, apiKey: server });

    // The key it reports is the one it was given rather than the catalog's, and it is a key
    // the Order really can be read back with — which is what a test then does with it.
    expect(order.apiKey.id).toBe(server.id);
    expect(await readOrder(kobai, order)).toMatchObject({ id: order.id });
  });

  it("places over a secret key even when a browser's key built the Cart", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    // The storefront pattern ADR-0055 keeps working: the browser builds the Cart and the
    // server places it, because placing is where money moves and a publishable key is refused.
    const order = await seedTestOrder(kobai, { catalog, apiKey: publishable });

    expect(order.cart.apiKey.kind).toBe("publishable");
    expect(order.apiKey.id).toBe(catalog.apiKey.id);
    // And the key it reports is one that can actually read the Order back.
    expect(await readOrder(kobai, order)).toMatchObject({ id: order.id });
  });

  it("says which line is missing rather than handing back undefined", async () => {
    await using kobai = await createTestKobai();

    const order = await seedTestOrder(kobai);

    expect(() => order.lineItem("MUG")).toThrow(/POSTER-A2/);
  });

  it("refuses to be told the same thing twice", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const seed = async () =>
      seedTestOrder(kobai, {
        cart,
        // @ts-expect-error `cart` is a Cart already built, so there is none left to shape.
        quantity: 2,
      });

    expect(seed).toBeDefined();
  });

  it("says what the application refused when it cannot place the Cart", async () => {
    // A deployment with no Payment Provider cannot take an Order at all (ADR-0053), and the
    // helper wires none — so this fails naming the refusal rather than somewhere later on an
    // Order that was never placed.
    await using kobai = await createTestKobai({ payments: {} });

    await expect(seedTestOrder(kobai)).rejects.toThrow(/no-payment-provider/);
  });
});
