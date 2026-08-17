import { describe, expect, it } from "vitest";
import { createTestApiKey } from "./api-key.ts";
import { seedTestCart } from "./cart.ts";
import { seedTestCatalog } from "./catalog.ts";
import { createTestKobai } from "./kobai.ts";

/**
 * The Cart seam of `@kobai/core/testing`, asserted at the surface it promises.
 *
 * This helper is promised surface under ADR-0019 and ADR-0047, so what it seeds is asked of
 * the running application rather than of the object it hands back — an assertion against its
 * own return value would agree with itself however wrong the arrangement was.
 */

/** What `GET /store/carts/{id}` answers with, as far as anything here reads it. */
type CartBody = {
  readonly id: string;
  readonly shopper: { email: string; externalId: string | null } | null;
  readonly lineItems: readonly {
    id: string;
    variant: { id: string; sku: string };
    quantity: number;
  }[];
  readonly expired: boolean;
};

async function readCart(
  kobai: Awaited<ReturnType<typeof createTestKobai>>,
  cart: { id: string; apiKey: { headers: Record<string, string> } },
): Promise<CartBody> {
  const response = await kobai.request(`/store/carts/${cart.id}`, {
    headers: cart.apiKey.headers,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as CartBody;
}

describe("seeding a Cart", () => {
  it("gives an untold test one live Cart carrying one of the one Variant", async () => {
    await using kobai = await createTestKobai();

    const cart = await seedTestCart(kobai);

    const body = await readCart(kobai, cart);
    expect(body.id).toBe(cart.id);
    expect(body.expired).toBe(false);
    expect(body.lineItems).toEqual([
      {
        id: cart.lineItem("POSTER-A2").id,
        variant: { id: cart.catalog.variantId, sku: "POSTER-A2" },
        quantity: 1,
        metadata: {},
      },
    ]);
  });

  it("is a guest's Cart, because that is what Core assumes everywhere", async () => {
    await using kobai = await createTestKobai();

    const cart = await seedTestCart(kobai);

    // ADR-0020: Core never assumes an authenticated Shopper, so the arrangement a test
    // inherits must not quietly be a signed-in one.
    expect((await readCart(kobai, cart)).shopper).toBeNull();
  });

  it("takes a quantity when the test cares how many", async () => {
    await using kobai = await createTestKobai();

    const cart = await seedTestCart(kobai, { quantity: 3 });

    expect((await readCart(kobai, cart)).lineItems[0]?.quantity).toBe(3);
    expect(cart.lineItem("POSTER-A2").quantity).toBe(3);
  });

  it("seeds an empty Cart when asked for no lines at all", async () => {
    await using kobai = await createTestKobai();

    // The arrangement a refusal test needs, and one nobody should have to hand-roll the rest
    // of the Cart for.
    const cart = await seedTestCart(kobai, { lines: [] });

    expect((await readCart(kobai, cart)).lineItems).toEqual([]);
    expect(cart.lineItems).toEqual([]);
  });

  it("puts several named Variants on one Cart, each with its own quantity", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [800] }],
    });

    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
    });

    const body = await readCart(kobai, cart);
    expect(body.lineItems.map((line) => [line.variant.sku, line.quantity])).toEqual([
      ["POSTER-A2", 1],
      ["MUG", 2],
    ]);
    // By SKU rather than by position, for the reason `seedTestCatalog.variant` is: a test
    // that indexes into a list is a test that breaks when the list grows.
    expect(cart.lineItem("MUG").variantId).toBe(catalog.variant("MUG").id);
  });

  it("builds on a catalog a test already seeded, rather than seeding a second one", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250, 900] });

    const cart = await seedTestCart(kobai, { catalog });

    // A deployment has only ever one first Merchant (ADR-0041), so handing one over is how a
    // test that has already signed in gets a Cart at all — and the catalog is the one it set
    // up rather than a second Product beside it.
    const products = await kobai.request("/admin/products", {
      headers: catalog.merchant.headers,
    });
    const listed = (await products.json()) as { products: readonly unknown[] };
    expect(listed.products).toHaveLength(1);
    expect(cart.catalog).toBe(catalog);
  });

  it("attaches a Shopper when a test says who the Cart is for", async () => {
    await using kobai = await createTestKobai();

    const cart = await seedTestCart(kobai, {
      shopper: { email: "shopper@example.test", externalId: "auth0|42" },
    });

    expect((await readCart(kobai, cart)).shopper).toEqual({
      email: "shopper@example.test",
      externalId: "auth0|42",
    });
  });

  it("builds the Cart with the key it was given, and reports which one", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    // The common storefront pattern: a browser's key builds and reads the Cart. Only asserting
    // who the Shopper is needs a secret one (ADR-0020), and this Cart asserts nobody.
    const cart = await seedTestCart(kobai, { catalog, apiKey: publishable });

    expect(cart.apiKey.kind).toBe("publishable");
    expect((await readCart(kobai, cart)).lineItems).toHaveLength(1);
  });

  it("says which line is missing rather than handing back undefined", async () => {
    await using kobai = await createTestKobai();

    const cart = await seedTestCart(kobai);

    expect(() => cart.lineItem("MUG")).toThrow(/POSTER-A2/);
  });
});
