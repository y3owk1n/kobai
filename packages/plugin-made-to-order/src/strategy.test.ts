import type { Kobai } from "@kobai/core";
import {
  createTestKobai,
  seedTestCatalog,
  seedTestOrder,
  signInTestMerchant,
  type TestCatalog,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { madeToOrder } from "./strategy.ts";

/**
 * The proof ADR-0014 asked for: *if made-to-order cannot be expressed as a strategy Plugin, the
 * strategy interface is wrong.*
 *
 * So these tests are about the Strategy this package exports rather than about the interface —
 * Core proves the mechanism with a stand-in of its own. What is under test here is that the
 * real object, wired the way a Project wires one, makes a Variant nobody has any stock of
 * sellable end to end, and says so on the Order.
 *
 * Everything goes through the public API, which is the only thing a Plugin has.
 */

/** What a Project wires, spelled once because every test below boots with it (ADR-0017). */
const wiredHere = { fulfilment: { strategies: { "made-to-order": madeToOrder } } };

/** Something this Store makes rather than stocks, at the usual 1250. */
function aCommission(kobai: Kobai): Promise<TestCatalog> {
  return seedTestCatalog(kobai, {
    variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
  });
}

describe("the Strategy this Plugin offers", () => {
  it("answers the three questions, and the Order records what it said", async () => {
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);

    const order = await seedTestOrder(kobai, { catalog });

    const read = await kobai.request(`/store/orders/${order.id}`, {
      headers: order.apiKey.headers,
    });
    // ADR-0014's three, snapshotted onto the Fulfilment at Capture — which is where an Order
    // keeps them, so rewiring the Strategy or uninstalling this Plugin cannot rewrite what this
    // Order was. `hasLeadTime: true` is the answer neither of Core's own two ever gives.
    await expect(read.json()).resolves.toMatchObject({
      fulfilments: [
        {
          strategy: "made-to-order",
          requiresShipping: true,
          tracksInventory: false,
          hasLeadTime: true,
        },
      ],
    });
  });

  it("makes a Variant sellable with no Inventory row and no Reservation", async () => {
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);

    const order = await seedTestOrder(kobai, { catalog, quantity: 3 });

    expect(order.total).toBe(3750);
    // Nobody counted it, and nobody has to: nothing is on a shelf until it is made. A row is
    // how many there are, and this Variant's Strategy is what says there is nothing to count.
    const product = (await (
      await kobai.request(`/admin/products/${catalog.productId}`, {
        headers: catalog.merchant.headers,
      })
    ).json()) as { variants: readonly { sku: string; inventory: unknown }[] };
    expect(product.variants).toMatchObject([{ sku: "COMMISSION", inventory: null }]);

    // No row, rather than a row claiming nothing — asked of the database, because the
    // difference is invisible from outside and is the whole of what "claims no Inventory"
    // means (ADR-0018).
    await expect(
      kobai.database.query("select id from core_reservation"),
    ).resolves.toEqual([]);
  });

  it("claims no Inventory even from a shelf somebody counted", async () => {
    // This is the assertion the one above cannot make: an *uncounted* Variant sells freely
    // whatever its Strategy answers, so only a counted one can show that `tracksInventory:
    // false` is what decides. One on the shelf, three ordered — a `physical` Variant would be
    // refused `insufficient-inventory` here, and this one is not.
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const counted = await kobai.request(
      `/admin/variants/${catalog.variantId}/inventory`,
      {
        method: "PUT",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ onHand: 1 }),
      },
    );
    expect(counted.status).toBe(200);

    const order = await seedTestOrder(kobai, { catalog, quantity: 3 });

    expect(order.total).toBe(3750);
    // Untouched, because nothing was ever claimed: the Strategy says whether stock is
    // involved and the row only ever says how many.
    await expect(
      kobai.database.query("select on_hand, reserved from core_inventory"),
      // Strings, because Core counts stock in `bigint` columns and the driver hands those back
      // as text rather than losing precision on the way.
    ).resolves.toEqual([{ on_hand: "1", reserved: "0" }]);
    await expect(
      kobai.database.query("select id from core_reservation"),
    ).resolves.toEqual([]);
  });
});

describe("a Strategy a Project has not wired", () => {
  it("is not a name a Variant may point at, however installed the Plugin is", async () => {
    // This package is a dependency of the test that is running: it is installed, imported, and
    // `madeToOrder` is in scope on the line above. None of that is wiring (ADR-0017) — a
    // deployment that says nothing about fulfilment has Core's two and no others.
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/products", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: "A commission",
        variants: [{ sku: "COMMISSION", fulfilment: { strategy: "made-to-order" } }],
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "unknown-fulfilment-strategy",
    });
  });
});
