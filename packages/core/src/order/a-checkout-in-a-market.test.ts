import { describe, expect, it } from "vitest";
import type { PaymentProvider, PaymentRequest } from "../payment/provider.ts";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestApiKey,
  type TestCart,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **What a Store with constrained Prices quotes is what it charges** (#293, #292, ADR-0074).
 *
 * #292 constrained a Price by Region and Channel and taught `GET /store/variants/{id}/price` to
 * ask by both — and left `place-order` reading the Store's default Region and passing no Channel
 * at all. So a Store that had set either kind of Price showed one number on its product page and
 * charged another at checkout, and a marketplace key got storefront prices at the till. This
 * file is that hole closed, asserted from the two ends that must agree: the price a storefront
 * renders, and the money a Payment Provider is actually asked for.
 *
 * **The Payment is where it is asserted rather than the Order's total**, deliberately. The Order
 * records what Core wrote; the `PaymentRequest` is what left kobai for somebody else's system,
 * and ADR-0070 has the *Project* create a PaymentIntent for the quoted figure before any of this
 * — so a Cart quoted in one currency and charged in another is a Shopper paying the right number
 * in the wrong one. Asking the provider what it was handed is the only assertion that can see it
 * (`docs/agents/writing-tests.md`).
 */

/** A Payment Provider that keeps what it was asked for, and takes it. */
function ledger(): { provider: PaymentProvider; taken: PaymentRequest[] } {
  const taken: PaymentRequest[] = [];
  return {
    taken,
    provider: {
      name: "ledger",
      charge: async (request) => {
        taken.push(request);
        return { ok: true, reference: `ledger-${taken.length}` };
      },
      refund: async () => {},
    },
  };
}

/** A Region this Store sells into, selecting a currency it has enabled. */
async function createRegion(
  kobai: TestKobai,
  catalog: TestCatalog,
  name: string,
  currency: string,
): Promise<string> {
  const response = await kobai.request("/admin/regions", {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, currency }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** A Channel this Store sells through. */
async function createChannel(
  kobai: TestKobai,
  catalog: TestCatalog,
  name: string,
): Promise<string> {
  const response = await kobai.request("/admin/channels", {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** Enables the whole set of currencies this Store may price in. */
async function enable(
  kobai: TestKobai,
  catalog: TestCatalog,
  ...codes: readonly string[]
): Promise<void> {
  const response = await kobai.request("/admin/store", {
    method: "PATCH",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ currencies: codes.map((code) => ({ code })) }),
  });
  expect(response.status, `enabling ${codes.join(", ")}`).toBe(200);
}

/** One Price on the catalog's Variant, however it is constrained. */
async function setPrice(
  kobai: TestKobai,
  catalog: TestCatalog,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await kobai.request(`/admin/variants/${catalog.variantId}/prices`, {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, `pricing ${JSON.stringify(body)}`).toBe(201);
}

/** What a storefront renders on the product page, in the market the key and the Region name. */
async function pagePrice(
  kobai: TestKobai,
  catalog: TestCatalog,
  apiKey: TestApiKey,
  regionId?: string,
): Promise<{ amount: number; currency: string }> {
  const query = regionId === undefined ? "" : `?region=${regionId}`;
  const response = await kobai.request(
    `/store/variants/${catalog.variantId}/price${query}`,
    { headers: apiKey.headers },
  );
  const body = (await response.json()) as {
    price?: { amount: number; currency: string };
    error?: string;
  };
  expect(response.status, `pricing the page: ${body.error ?? ""}`).toBe(200);
  // The two figures a Shopper sees, without the Price's identifier: what is being compared here
  // is what the storefront renders against what the bank is asked for, and the row it came from
  // is `pricing/best-match.test.ts`'s subject rather than this file's.
  return {
    amount: body.price?.amount ?? -1,
    currency: body.price?.currency ?? "",
  };
}

/** What this Cart comes to now — the route ADR-0077 added, on the deployment's own Steps. */
async function quote(
  kobai: TestKobai,
  cart: TestCart,
): Promise<{ total: number; currency: string }> {
  const response = await kobai.request(`/store/carts/${cart.id}/quote`, {
    method: "POST",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = (await response.json()) as {
    total?: number;
    currency?: string;
    error?: string;
  };
  expect(response.status, `quoting: ${body.error ?? ""}`).toBe(200);
  return { total: body.total ?? -1, currency: body.currency ?? "" };
}

/** Places the Cart, and answers the Order as the storefront is told about it. */
async function place(
  kobai: TestKobai,
  cart: TestCart,
): Promise<{ total: number; currency: string }> {
  const response = await kobai.request("/store/orders", {
    method: "POST",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId: cart.id }),
  });
  const body = (await response.json()) as {
    total?: number;
    currency?: string;
    error?: string;
  };
  expect(response.status, `placing: ${body.error ?? ""}`).toBe(201);
  return { total: body.total ?? -1, currency: body.currency ?? "" };
}

describe("a Store that prices by Region", () => {
  it("quotes, charges and takes payment for the same number in the Cart's Region", async () => {
    const money = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: money.provider },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 5500, currency: "MYR", regionId: malaysia });

    // A Shopper in Malaysia, moved there the way a storefront moves one: the same Cart, kept.
    const cart = await seedTestCart(kobai, { catalog });
    const switched = await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ regionId: malaysia }),
    });
    expect(switched.status).toBe(200);

    // The three figures a Shopper meets, in order: the product page, the checkout summary, and
    // the money that actually moves.
    expect(await pagePrice(kobai, catalog, catalog.apiKey, malaysia)).toEqual({
      amount: 5500,
      currency: "MYR",
    });
    expect(await quote(kobai, cart)).toEqual({ total: 5500, currency: "MYR" });
    expect(await place(kobai, cart)).toEqual({ total: 5500, currency: "MYR" });
    // **The PaymentIntent is created in the Cart's currency** (story 12): the figure the
    // provider was handed, which is what a bank would have been asked for.
    expect(money.taken).toMatchObject([{ amount: 5500, currency: "MYR" }]);
  });

  it("still charges the Store's default Region for a Cart that names none", async () => {
    // The clause that keeps every existing storefront working: a Cart with no Region of its own
    // is priced for the Store's default, which selects the currency every Price already carried.
    const money = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: money.provider },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 5500, currency: "MYR", regionId: malaysia });
    const cart = await seedTestCart(kobai, { catalog });

    expect(await quote(kobai, cart)).toEqual({ total: 1250, currency: "USD" });
    expect(await place(kobai, cart)).toEqual({ total: 1250, currency: "USD" });
    expect(money.taken).toMatchObject([{ amount: 1250, currency: "USD" }]);
  });
});

describe("a Store that prices by Channel", () => {
  it("charges the marketplace its own Price rather than the storefront's", async () => {
    // Story 7, and the half #292 left open: the Channel comes off the API key, so a placement
    // that could not see one charged the unconstrained Price to every caller — a marketplace
    // key got storefront prices at checkout while being quoted its own on the product page.
    const money = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: money.provider },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const marketplace = await createChannel(kobai, catalog, "Marketplace");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 1450, channelId: marketplace });
    const listing = await createTestApiKey(kobai, catalog.merchant, {
      name: "the marketplace listing",
      channelId: marketplace,
    });
    const cart = await seedTestCart(kobai, { catalog, apiKey: listing });

    expect(await pagePrice(kobai, catalog, listing)).toEqual({
      amount: 1450,
      currency: "USD",
    });
    expect(await quote(kobai, cart)).toEqual({ total: 1450, currency: "USD" });
    expect(await place(kobai, cart)).toEqual({ total: 1450, currency: "USD" });
    expect(money.taken).toMatchObject([{ amount: 1450, currency: "USD" }]);
  });

  it("leaves a key in no Channel on the unconstrained Price", async () => {
    // Every key that existed before Channels did, and every Store with one route to market:
    // unconstrained rather than refused, which is what makes `channel_id` additive.
    const money = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: money.provider },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const marketplace = await createChannel(kobai, catalog, "Marketplace");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 1450, channelId: marketplace });
    const cart = await seedTestCart(kobai, { catalog });

    expect(await quote(kobai, cart)).toEqual({ total: 1250, currency: "USD" });
    expect(await place(kobai, cart)).toEqual({ total: 1250, currency: "USD" });
    expect(money.taken).toMatchObject([{ amount: 1250, currency: "USD" }]);
  });
});

describe("a Cart whose lines could not all be priced where it is", () => {
  it("refuses the placement rather than charging the other market's number", async () => {
    // kobai converts nothing, so a Variant with no Price in the Region's currency has no price
    // there — the same `price-not-set` an unpriced Variant answers, met at the placement
    // because the Cart's own Region is what it is priced in.
    const money = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: money.provider },
    });
    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "POSTER-A2", prices: [1250] },
        { sku: "MUG", prices: [1900] },
      ],
    });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 5500, currency: "MYR", regionId: malaysia });
    const cart = await seedTestCart(kobai, { catalog, lines: [{ sku: "POSTER-A2" }] });

    // Switched while the mug was not in it, and the mug added afterwards — which is the one way
    // to reach a Cart in a Region that cannot price every line, since the switch itself refuses
    // exactly this (`cart/a-cart-switches-region.test.ts`).
    await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ regionId: malaysia }),
    });
    await kobai.request(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ variantId: catalog.variant("MUG").id }),
    });

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "price-not-set" });
    // Nothing was charged, which is the assertion a status code cannot make: `price-lines` runs
    // before `take-payment` precisely so that a Cart that cannot be priced costs nobody money.
    expect(money.taken).toEqual([]);
  });
});
