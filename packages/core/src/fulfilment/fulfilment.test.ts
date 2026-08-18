import { describe, expect, it } from "vitest";
import type { KobaiProjectConfig } from "../config.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  signInTestMerchant,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import type { FulfilledVariant, FulfilmentStrategy } from "./strategy.ts";

/**
 * A Strategy from outside Core, standing in for the one a Plugin offers.
 *
 * It is declared at module level and is therefore *present* in every test below — imported,
 * constructed, sitting right here — which is the whole point of ADR-0017: having a Strategy and
 * wiring one are different things, and only the line in `kobai.config.ts` is the second.
 *
 * Made-to-order's answers, because that is the Plugin this interface was designed for (#108): it
 * ships, it consumes no stock — nothing is on a shelf until somebody makes it — and it has a
 * Lead Time.
 */
const madeToOrder: FulfilmentStrategy = {
  answersFor: () => ({
    requiresShipping: true,
    tracksInventory: false,
    hasLeadTime: true,
  }),
};

/** As much of a placed Order as these tests read — the lines, and what fulfils them. */
type PlacedOrderBody = {
  readonly id: string;
  readonly lineItems: readonly { readonly id: string; readonly sku: string }[];
  readonly fulfilments: readonly {
    readonly id: string;
    readonly strategy: string;
    readonly lineItemIds: readonly string[];
  }[];
};

/** The line for this SKU, by SKU rather than by position — an Order reports its lines in SKU order. */
function lineIdFor(order: PlacedOrderBody, sku: string): string {
  const line = order.lineItems.find((item) => item.sku === sku);
  if (!line) throw new Error(`this Order has no line for ${sku}`);
  return line.id;
}

/** What a Merchant says they have, through the route a Merchant says it through. */
async function countStock(
  kobai: TestKobai,
  catalog: TestCatalog,
  variantId: string,
  onHand: number,
): Promise<void> {
  const response = await kobai.request(`/admin/variants/${variantId}/inventory`, {
    method: "PUT",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
  expect(response.status).toBe(200);
}

/** What the Store has of it now, read back the way a Merchant reads it. */
async function stockOf(
  kobai: TestKobai,
  catalog: TestCatalog,
  variantId: string,
): Promise<{ onHand: number; reserved: number } | null> {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  const product = (await response.json()) as {
    variants: readonly {
      id: string;
      inventory: { onHand: number; reserved: number } | null;
    }[];
  };
  return product.variants.find((variant) => variant.id === variantId)?.inventory ?? null;
}

/** Turns a Cart into an Order, over the surface a storefront places on. */
async function place(
  kobai: TestKobai,
  headers: Record<string, string>,
  cartId: string,
): Promise<Response> {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

/**
 * **Fulfilment Strategies**, and Fulfilment as its own entity (ADR-0014, ADR-0052).
 *
 * Everything is asserted at the public HTTP seam, because that is where a Merchant and a
 * storefront meet these decisions: a Variant points at a Strategy through the route that
 * creates it, an Order records its Fulfilments in the body Capture answers with, and what a
 * Strategy *answers* is visible in what the Store does about stock.
 */

describe("a Variant points at a Fulfilment Strategy", () => {
  it("is physical when nobody says otherwise", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      variants: [{ sku: "POSTER-A2", fulfilment: { strategy: "physical" } }],
    });
  });

  it("is whichever of Core's two it was created with", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "POSTER-A2" }, { sku: "PDF", fulfilmentStrategy: "digital" }],
    });

    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      variants: [
        { sku: "PDF", fulfilment: { strategy: "digital" } },
        { sku: "POSTER-A2", fulfilment: { strategy: "physical" } },
      ],
    });
  });
});

/**
 * **Fulfilment is its own entity** (ADR-0014), and an Order has as many as it has ways of
 * getting to a Shopper.
 *
 * Not a status column on the Order, and that is the ADR-0009-class decision: a mixed Order ships
 * a poster and emails a PDF, and one lifecycle column would force a single timeline onto parts
 * that do not share one — cheap now, unfixable once there is order history. This ticket builds
 * the shape; fulfilling anything is not in this spec, so what these assert is that the parts are
 * recorded separately and say what was true of them at Capture.
 */
describe("an Order's Fulfilments", () => {
  /** A poster and a PDF in one Cart, placed. */
  async function placeAMixedOrder(kobai: TestKobai) {
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "POSTER-A2" }, { sku: "PDF", fulfilmentStrategy: "digital" }],
    });
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "PDF", quantity: 2 }],
    });

    const response = await place(kobai, cart.apiKey.headers, cart.id);
    expect(response.status).toBe(201);

    return { catalog, cart, order: (await response.json()) as PlacedOrderBody };
  }

  it("are one per way the Order is delivered, on the Order that has them", async () => {
    await using kobai = await createTestKobai();

    const { order } = await placeAMixedOrder(kobai);

    // Two, because these two parts do not share a timeline — and each says what its Strategy
    // answered rather than referring back to a Strategy that may be rewired tomorrow.
    expect(order.fulfilments).toEqual([
      {
        id: expect.any(String),
        strategy: "digital",
        requiresShipping: false,
        tracksInventory: false,
        hasLeadTime: false,
        lineItemIds: [lineIdFor(order, "PDF")],
      },
      {
        id: expect.any(String),
        strategy: "physical",
        requiresShipping: true,
        tracksInventory: true,
        hasLeadTime: false,
        lineItemIds: [lineIdFor(order, "POSTER-A2")],
      },
    ]);
  });

  it("gather the lines that share one, rather than one per line", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "POSTER-A2" }, { sku: "POSTER-A3" }],
    });
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "POSTER-A3" }],
    });

    const response = await place(kobai, cart.apiKey.headers, cart.id);
    const order = (await response.json()) as PlacedOrderBody;

    // Two posters go in one parcel. A Fulfilment per line would be a Fulfilment that means
    // nothing — it would be the line.
    expect(order.fulfilments).toHaveLength(1);
    expect(order.fulfilments[0]?.lineItemIds.toSorted()).toEqual(
      [lineIdFor(order, "POSTER-A2"), lineIdFor(order, "POSTER-A3")].toSorted(),
    );
  });

  it("read back exactly as Capture reported them", async () => {
    // The same bytes from both routes, which is what makes the placement response something a
    // storefront can render a confirmation from without a second round trip.
    await using kobai = await createTestKobai();
    const { cart, order } = await placeAMixedOrder(kobai);

    const read = await kobai.request(`/store/orders/${order.id}`, {
      headers: cart.apiKey.headers,
    });

    await expect(read.json()).resolves.toMatchObject({ fulfilments: order.fulfilments });
  });

  it("say what a Plugin's Strategy answered, in the Order's own record of it", async () => {
    await using kobai = await createTestKobai({
      fulfilment: { strategies: { "made-to-order": madeToOrder } },
    });
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
    });
    const cart = await seedTestCart(kobai, { catalog });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      fulfilments: [
        {
          strategy: "made-to-order",
          requiresShipping: true,
          tracksInventory: false,
          // The answer no Core Strategy gives, recorded by Core because it asked rather than
          // because it knows what made-to-order is.
          hasLeadTime: true,
        },
      ],
    });
  });
});

/**
 * What `tracksInventory` decides — the load-bearing answer, and the one #106 made so.
 *
 * `hold-reservations` claims everything scarce in a Cart, and what makes a line scarce is now
 * its Strategy rather than the presence of a row. The distinction that matters is **skipped
 * versus claimed for zero**: a claim of zero is still a claim, and a Store selling downloads
 * would be taking row locks and writing Reservations for every line of every Order it ever
 * takes.
 */
describe("a Variant whose Strategy does not track Inventory", () => {
  it("is sellable with no Inventory row at all", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }],
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 3 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // Nobody counted it and nobody needs to: a download is not on a shelf.
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toBeNull();
  });

  it("holds no Reservation, rather than one for nothing", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }],
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 3 });

    await place(kobai, cart.apiKey.headers, cart.id);

    // No row, not a row saying zero — asked of the database, because the difference is
    // invisible from outside and is the whole of what "skips the hold" means.
    await expect(
      kobai.database.query("select id, quantity from core_reservation"),
    ).resolves.toEqual([]);
  });

  it("sells past a shelf that has been counted anyway", async () => {
    // A row exists — a Merchant counted it once, or this Variant used to be a poster — and it
    // is not what decides. The Strategy is the answer; the row is only how many.
    await using kobai = await createTestKobai({
      fulfilment: { strategies: { "made-to-order": madeToOrder } },
    });
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
    });
    await countStock(kobai, catalog, catalog.variantId, 1);
    const cart = await seedTestCart(kobai, { catalog, quantity: 3 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // Untouched: nothing was claimed, so nothing was consumed.
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toMatchObject({
      onHand: 1,
      reserved: 0,
    });
  });

  it("is the difference from the same Cart of a physical Variant", async () => {
    // The pairing is the assertion. Same shelf, same quantity, same request — and `physical`
    // says yes to the question the Plugin's Strategy says no to.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 1);
    const cart = await seedTestCart(kobai, { catalog, quantity: 3 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "insufficient-inventory",
    });
  });
});

/**
 * ADR-0017, at the surface a Developer actually writes it at.
 *
 * A Plugin **offers** a Strategy and the Project **wires** it. The two deployments below are the
 * same code, the same import and the same object — one line of configuration apart — and the
 * difference is whether a Variant may point at it at all.
 */
describe("a Strategy from outside Core", () => {
  /** A Product whose one Variant is delivered by `made-to-order`. */
  async function createCommission(kobai: TestKobai) {
    const merchant = await signInTestMerchant(kobai);

    return kobai.request("/admin/products", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: "A commission",
        variants: [{ sku: "COMMISSION", fulfilment: { strategy: "made-to-order" } }],
      }),
    });
  }

  it("does nothing until the Project wires it", async () => {
    // The Strategy at the top of this file is imported and constructed either way; this
    // deployment simply never named it.
    await using kobai = await createTestKobai();

    const response = await createCommission(kobai);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unknown-fulfilment-strategy",
    });
  });

  it("names the Strategies the deployment does have, so the fix is obvious", async () => {
    await using kobai = await createTestKobai();

    const response = await createCommission(kobai);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('"digital"');
    expect(body.error).toContain('"physical"');
    expect(body.error).toContain("kobai.config.ts");
  });

  it("is not something a name JavaScript happens to answer to gets past", async () => {
    // The Strategies are an object keyed by name, and every object answers to `toString`,
    // `constructor` and `valueOf`. A membership test that asked the prototype would let a
    // Variant point at one of those — refused nowhere, and then a 500 at the first Order for
    // it, because what came back was a function rather than a Strategy.
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: "A poster",
        variants: [{ sku: "POSTER-A2", fulfilment: { strategy: "toString" } }],
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unknown-fulfilment-strategy",
    });
  });

  it("is what a Variant may point at once the Project has", async () => {
    // One key of `kobai.config.ts`, and the same object as above.
    await using kobai = await createTestKobai({
      fulfilment: { strategies: { "made-to-order": madeToOrder } },
    });

    const response = await createCommission(kobai);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      variants: [{ sku: "COMMISSION", fulfilment: { strategy: "made-to-order" } }],
    });
  });

  it("replaces one of Core's when it is wired under that name", async () => {
    // Substitution, rather than addition: a Project that disagrees with what `physical` means
    // says so under that key, and the difference is visible in the one file that exists to show
    // it. Here `physical` stops consuming stock, so a shelf of one sells three.
    await using kobai = await createTestKobai({
      fulfilment: { strategies: { physical: madeToOrder } },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 1);
    const cart = await seedTestCart(kobai, { catalog, quantity: 3 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      fulfilments: [{ strategy: "physical", hasLeadTime: true }],
    });
  });

  it("leaves Core's own two where they were", async () => {
    // Wiring adds; it does not replace the set. A deployment that wires a Plugin's Strategy is
    // still a deployment that sells posters.
    await using kobai = await createTestKobai({
      fulfilment: { strategies: { "made-to-order": madeToOrder } },
    });
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital" }, { sku: "POSTER-A2" }],
    });

    const response = await kobai.request(`/admin/products/${catalog.productId}`, {
      headers: catalog.merchant.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      variants: [
        { sku: "PDF", fulfilment: { strategy: "digital" } },
        { sku: "POSTER-A2", fulfilment: { strategy: "physical" } },
      ],
    });
  });
});

/**
 * What the compiler refuses to let a Project wire.
 *
 * Registering a Strategy has to be **safe** rather than merely possible, which is the standard
 * ADR-0017 sets for replacing a Workflow Step — so these sit beside the Workflow's own
 * type-level assertions and are run by the same thing: the `typecheck` step of the gate, not
 * vitest. The `expect` below each only keeps the block a test; the assertion is the
 * `@ts-expect-error`, which fails the build if the line it marks ever compiles.
 *
 * They are written against `KobaiProjectConfig` — the type of the file a Developer actually
 * writes — rather than against `FulfilmentStrategy` alone, because that is where the promise is
 * kept.
 */
describe("what a Project could not have wired", () => {
  it("rejects a Strategy that answers something other than the three questions", () => {
    const wrong: KobaiProjectConfig = {
      fulfilment: {
        strategies: {
          // @ts-expect-error a Strategy answers three booleans, and this answers one.
          rental: { answersFor: () => ({ requiresShipping: true }) },
        },
      },
    };

    expect(wrong).toBeDefined();
  });

  it("rejects a Strategy that answers with something that is not a boolean", () => {
    const fuzzy: KobaiProjectConfig = {
      fulfilment: {
        strategies: {
          rental: {
            answersFor: () => ({
              requiresShipping: true,
              tracksInventory: true,
              // @ts-expect-error whether there is a Lead Time, not how long it is.
              hasLeadTime: 14,
            }),
          },
        },
      },
    };

    expect(fuzzy).toBeDefined();
  });

  it("rejects a Strategy that demands more than Core sends", () => {
    // Contravariance, and the reason `answersFor` is a function-valued property rather than a
    // method: a Strategy that insists on a field Core does not model would be handed
    // `undefined` at runtime, and TypeScript only says so for a property. What such a Strategy
    // actually wants arrives on `variant.metadata`, which is ADR-0013's open door.
    const fussy: KobaiProjectConfig = {
      fulfilment: {
        strategies: {
          "made-to-order": {
            // @ts-expect-error Core sends a Variant's id, SKU and metadata, and nothing else.
            answersFor: (variant: FulfilledVariant & { leadTimeDays: number }) => ({
              requiresShipping: true,
              tracksInventory: false,
              hasLeadTime: variant.leadTimeDays > 0,
            }),
          },
        },
      },
    };

    expect(fussy).toBeDefined();
  });

  it("rejects a Strategy that is a bag of flags rather than an interface", () => {
    // The shape ADR-0014 rules out, refused at the boundary: `requires_shipping` and
    // `tracks_inventory` are questions a Strategy answers, never values it holds.
    const flags: KobaiProjectConfig = {
      fulfilment: {
        strategies: {
          // @ts-expect-error a Strategy answers; it does not carry the answers.
          rental: { requiresShipping: true, tracksInventory: true, hasLeadTime: false },
        },
      },
    };

    expect(flags).toBeDefined();
  });
});
