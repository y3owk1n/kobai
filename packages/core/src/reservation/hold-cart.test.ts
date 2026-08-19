import { describe, expect, it } from "vitest";
import type { ReservedLines } from "../order/place-order.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";

/**
 * **Holding a Cart's stock before the Shopper leaves** — `POST /store/carts/{id}/reservations`
 * (ADR-0070).
 *
 * The hole this closes is a Shopper paying at their bank for something that sold out while they
 * were authorising: until now `hold-reservations` ran only *inside* `place-order`, so nothing
 * held stock while the Shopper was away and they came back to `insufficient-inventory` with
 * their money already gone. This route is what a storefront calls before the redirect, and
 * `place-order` then **adopts** what it took rather than claiming a second time.
 *
 * Everything is asserted at the public HTTP seam and against what the Store is left holding,
 * because neither implies the other. The race — two requests holding one Cart at the same
 * instant — has a file of its own, `the-cart-that-held-twice.test.ts`, for the reason
 * `the-last-unit.test.ts` does: nothing sequential can tell an atomic claim from a read
 * followed by a write.
 */

describe("holding a Cart's stock", () => {
  it("claims every line that tracks Inventory, and says until when", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      cartId: string;
      expiresAt: string;
      reservations: readonly unknown[];
    };
    expect(body).toEqual({
      cartId: cart.id,
      expiresAt: expect.any(String),
      reservations: [{ provider: "inventory", subject: catalog.variantId, quantity: 2 }],
    });
    // The deadline is a real one and it is in the future — fifteen minutes for a deployment
    // that configured nothing, which the window's own tests hold to the minute.
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // And the Store is holding it: two of the five claimed, three left to sell.
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 5,
      reserved: 2,
      available: 3,
    });
  });

  it("is all of it or none of it, so a Cart that can hold one line holds neither", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [900] }],
    });
    await countStock(kobai, catalog, 5);
    await countStock(kobai, catalog, 0, "MUG");
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG" }],
    });

    const response = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "insufficient-inventory",
    });
    // The poster was claimable and is not claimed: the Shopper is told no either way, and a
    // poster held for a purchase that cannot happen is unsellable until the sweeper notices.
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 5,
      reserved: 0,
      available: 5,
    });
  });

  it("holds nothing, and says so at 200, for a Cart of Variants nobody is counting", async () => {
    // A Store selling downloads takes no lock and writes no Reservation (ADR-0014), so there is
    // nothing to hold and no deadline to report — and that is an answer rather than a refusal.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "PDF", fulfilmentStrategy: "digital", prices: [1250] }],
    });
    const cart = await seedTestCart(kobai, { catalog });

    const response = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cartId: cart.id,
      reservations: [],
    });
  });

  it("adopts the hold it already has when a storefront asks twice", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const first = await (await hold(kobai, cart.apiKey.headers, cart.id)).json();
    const again = await (await hold(kobai, cart.apiKey.headers, cart.id)).json();

    // The same hold, to the millisecond: a second claim would have a deadline of its own, and
    // a renewed one would let a storefront keep a Store's stock by retrying (ADR-0075).
    expect(again).toEqual(first);
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 5,
      reserved: 2,
      available: 3,
    });
    await expect(liveHoldsOn(kobai, cart.id)).resolves.toHaveLength(1);
  });

  it("claims afresh for a Cart that has changed since, and leaves the old hold to lapse", async () => {
    // Two things are being asserted at once and the second is the interesting one. A hold that
    // no longer covers the Cart is **not** adopted — the line added afterwards would be captured
    // against nothing, which is overselling arriving through the door adoption opened. And it is
    // **not released** either: a placement that adopted it may be between taking the money and
    // writing the Order right now, and pulling its Reservations would fail that Capture after
    // the Shopper had paid. So the Cart holds both for a while and the sweeper ends the old one.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog, quantity: 1 });
    await hold(kobai, cart.apiKey.headers, cart.id);

    const response = await kobai.request(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ variantId: catalog.variantId, quantity: 2 }),
    });
    expect(response.status).toBe(200);
    const again = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({
      reservations: [{ provider: "inventory", subject: catalog.variantId, quantity: 3 }],
    });
    // Four held rather than three: the one the Cart no longer needs is still standing, which is
    // a Store with a unit it cannot sell for the length of one window rather than a Shopper who
    // paid for something they will not get.
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 5,
      reserved: 4,
      available: 1,
    });
    await expect(liveHoldsOn(kobai, cart.id)).resolves.toHaveLength(2);
  });

  it("adopts the fresh hold when the storefront asks a third time, rather than claiming again", async () => {
    // The consequence of leaving the stale row standing, and the reason adoption looks for the
    // claims among what the Cart holds rather than at all of it: without that, every retry after
    // a change would claim the Cart's stock over again until the Store ran out.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog, quantity: 1 });
    await hold(kobai, cart.apiKey.headers, cart.id);
    await kobai.request(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ variantId: catalog.variantId, quantity: 2 }),
    });

    const second = await (await hold(kobai, cart.apiKey.headers, cart.id)).json();
    const third = await (await hold(kobai, cart.apiKey.headers, cart.id)).json();

    expect(third).toEqual(second);
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({ reserved: 4 });
  });
});

describe("what holding a Cart's stock refuses", () => {
  it("needs a secret key, whatever the Cart is", async () => {
    // ADR-0055's argument, applied to stock rather than to money: a publishable key is shipped
    // to a browser and is therefore public, so a route that claimed inventory for anybody
    // holding one would let a stranger make a Store unable to sell anything.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const browser = await createTestApiKey(kobai, catalog.merchant, {
      kind: "publishable",
    });
    const cart = await seedTestCart(kobai, { catalog, apiKey: browser });

    const response = await hold(kobai, browser.headers, cart.id);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "secret-key-required",
    });
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({ reserved: 0 });
  });

  it("answers 404 for a Cart that does not exist", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await hold(
      kobai,
      cart.apiKey.headers,
      "00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-not-found" });
  });

  it("answers 404 for an identifier that could never be one", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await hold(kobai, cart.apiKey.headers, "not-an-identifier");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-not-found" });
  });

  it("answers 409 for a Cart that has expired", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog });
    await expire(kobai, cart.id);

    const response = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-expired" });
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({ reserved: 0 });
  });

  it("answers 409 for a Cart that has already become an Order", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog });
    expect((await place(kobai, cart.apiKey.headers, cart.id)).status).toBe(201);

    const response = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-placed" });
  });

  it("answers 422 for a Cart with nothing in it", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { lines: [] });

    const response = await hold(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-empty" });
  });
});

/**
 * **`place-order` adopts the hold rather than taking a second one** (ADR-0070).
 *
 * This is the half of claim-or-adopt that decides whether the whole thing was worth building: a
 * storefront that held before the redirect has to *get* that stock, and a placement that claimed
 * again would need the units twice over — so a Store with exactly what the Shopper asked for
 * would refuse the purchase it had already reserved.
 */
describe("placing a Cart that is already holding its stock", () => {
  it("uses the hold it has, on a Store with exactly enough", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 2);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });
    expect((await hold(kobai, cart.apiKey.headers, cart.id)).status).toBe(200);

    const placed = await place(kobai, cart.apiKey.headers, cart.id);

    expect(placed.status).toBe(201);
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 0,
      reserved: 0,
      available: 0,
    });
    // One Reservation, consumed by the Order — the one the storefront took, rather than a
    // second one written at Capture.
    const rows = await kobai.database.query<{ consumed: boolean }>(
      "select consumed_at is not null as consumed from core_reservation where cart_id = $1",
      [cart.id],
    );
    expect(rows).toEqual([{ consumed: true }]);
  });

  it("leaves that hold standing when the placement is refused", async () => {
    // The failure this whole design exists to prevent, from the inside: the Shopper's money has
    // moved at their bank, the placement fails for some other reason, and a compensation that
    // released the hold would give the goods away while they were being refunded. A run
    // releases what **it** claimed and nothing else.
    await using kobai = await createTestKobai({
      payments: { provider: declines },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 2);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });
    expect((await hold(kobai, cart.apiKey.headers, cart.id)).status).toBe(200);

    const refused = await place(kobai, cart.apiKey.headers, cart.id);

    expect(refused.status).toBe(402);
    // Still held, and still by the Cart that held it: the storefront can retry the payment.
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 2,
      reserved: 2,
      available: 0,
    });
    await expect(liveHoldsOn(kobai, cart.id)).resolves.toHaveLength(1);
  });

  it("keeps the hold it adopted even while the Cart is changed under it", async () => {
    // The failure both reviews of this ticket found in a version that gave the stale hold back:
    // a placement adopts, the storefront changes the Cart and holds again, and Capture then
    // meets Reservations somebody else released — a 500 with the money already moved. Nothing
    // in the hold path releases, so the placement in flight keeps what it adopted.
    await using kobai = await createTestKobai({
      workflows: { "place-order": { after: { "hold-reservations": [pause.step] } } },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 5);
    const cart = await seedTestCart(kobai, { catalog, quantity: 1 });
    expect((await hold(kobai, cart.apiKey.headers, cart.id)).status).toBe(200);

    const placing = place(kobai, cart.apiKey.headers, cart.id);
    await pause.reached;
    // The Cart grows a line while the placement is holding — and a storefront holds again for
    // it, which is what would have released the rows the placement is about to consume.
    await kobai.request(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ variantId: catalog.variantId, quantity: 2 }),
    });
    expect((await hold(kobai, cart.apiKey.headers, cart.id)).status).toBe(200);
    pause.release();

    // The Order is written, for the line the placement read, out of the stock it adopted.
    expect((await placing).status).toBe(201);
    await expect(stockOf(kobai, catalog)).resolves.toMatchObject({ onHand: 4 });
  });

  it("releases what it claimed itself when nothing was held for it", async () => {
    // The other side of the same rule, and the behaviour that was there before adopting
    // existed: a placement that took the hold is the one that gives it back.
    await using kobai = await createTestKobai({ payments: { provider: declines } });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, 2);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const refused = await place(kobai, cart.apiKey.headers, cart.id);

    expect(refused.status).toBe(402);
    await expect(stockOf(kobai, catalog)).resolves.toEqual({
      onHand: 2,
      reserved: 0,
      available: 2,
    });
    await expect(liveHoldsOn(kobai, cart.id)).resolves.toEqual([]);
  });
});

/**
 * A Step that stops a placement where the hold has been decided and nothing has been captured,
 * so the state in between is observable — the same device `reservation.test.ts` uses.
 *
 * Inserted **after** `hold-reservations` rather than replacing anything, so what runs on either
 * side of it is the deployment's own.
 */
const pause = (() => {
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
})();

/** A Payment Provider that takes nothing, so a placement fails after the hold was decided. */
const declines: PaymentProvider = {
  name: "declines",
  charge: async () => ({ ok: false, detail: "The bank said no." }),
  refund: async () => {},
};

/** Holding a Cart's stock, over the surface a storefront actually calls. */
function hold(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request(`/store/carts/${cartId}/reservations`, {
    method: "POST",
    headers,
  });
}

/** Placing the Cart, over the same surface. */
function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

/**
 * What this Cart is holding, as the record says — asked of the database because there is no
 * route that lists a Cart's Reservations, deliberately (ADR-0071).
 */
async function liveHoldsOn(kobai: TestKobai, cartId: string) {
  return kobai.database.query<{ subject: string }>(
    `select subject from core_reservation
     where cart_id = $1 and consumed_at is null and released_at is null`,
    [cartId],
  );
}

/**
 * Time passed, by winding the row back rather than by waiting — the same move `cart.test.ts`
 * makes for a lifetime measured in days.
 */
async function expire(kobai: TestKobai, cartId: string) {
  await kobai.database.query(
    "update core_cart set expires_at = now() - interval '1 second' where id = $1",
    [cartId],
  );
}

/** What a Merchant says the Store has — through the API, like everything else here. */
async function countStock(
  kobai: TestKobai,
  catalog: TestCatalog,
  onHand: number,
  sku = "POSTER-A2",
) {
  const response = await kobai.request(
    `/admin/variants/${catalog.variant(sku).id}/inventory`,
    {
      method: "PUT",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand }),
    },
  );
  expect(response.status).toBe(200);
}

/** What the Store believes it has, read the way a Merchant reads it. */
async function stockOf(kobai: TestKobai, catalog: TestCatalog, sku = "POSTER-A2") {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  const product = (await response.json()) as {
    variants: readonly {
      sku: string;
      inventory: { onHand: number; reserved: number; available: number } | null;
    }[];
  };
  const found = product.variants.find((variant) => variant.sku === sku)?.inventory;
  return (
    found && {
      onHand: found.onHand,
      reserved: found.reserved,
      available: found.available,
    }
  );
}
