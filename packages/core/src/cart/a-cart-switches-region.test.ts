import { describe, expect, it } from "vitest";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  type TestCart,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";

/**
 * **A Shopper moves from one market to another and keeps their basket** (#293, ADR-0074's
 * amendment).
 *
 * `PATCH /store/carts/{id}` takes a Region: the Cart keeps its identifier and every Line Item,
 * is re-denominated in the new Region's currency, and re-prices there on the next read. That is
 * affordable precisely because a Cart's Line Items carry **no price snapshot** — ADR-0009's
 * deliberate asymmetry with an Order — so there is nothing on the Cart to migrate. The record
 * used to say the Region was fixed at creation and switching meant a *new* Cart; the amendment
 * is what this file holds.
 *
 * Two things refuse it and each has its own case below: something already denominated against
 * the Cart, and a line the new Region could not price. Both are refusals rather than repairs
 * kobai takes on the Shopper's behalf — releasing a hold by hand is what kobai has decided never
 * to offer, and a Cart moved into a market it cannot be priced in is one whose quote and whose
 * placement both refuse at the last step instead of at the moment the Shopper chose.
 */

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

/** Enables a second currency on the Store — the whole set, as `PATCH /admin/store` reads it. */
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

/** One Price on a Variant, however it is constrained. */
async function setPrice(
  kobai: TestKobai,
  catalog: TestCatalog,
  body: Record<string, unknown>,
  sku?: string,
): Promise<void> {
  const variantId = sku === undefined ? catalog.variantId : catalog.variant(sku).id;
  const response = await kobai.request(`/admin/variants/${variantId}/prices`, {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, `pricing ${JSON.stringify(body)}`).toBe(201);
}

/** What a storefront sends to move a Cart, and what kobai answered. */
async function switchTo(
  kobai: TestKobai,
  cart: TestCart,
  regionId: string,
): Promise<Response> {
  return kobai.request(`/store/carts/${cart.id}`, {
    method: "PATCH",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ regionId }),
  });
}

/** A Store selling in two currencies, with a Cart of one poster started in the first. */
async function aStoreInTwoMarkets(kobai: TestKobai): Promise<{
  catalog: TestCatalog;
  cart: TestCart;
  malaysia: string;
}> {
  const catalog = await seedTestCatalog(kobai, { prices: [] });
  await enable(kobai, catalog, "USD", "MYR");
  const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
  await setPrice(kobai, catalog, { amount: 1250 });
  await setPrice(kobai, catalog, { amount: 5500, currency: "MYR", regionId: malaysia });
  const cart = await seedTestCart(kobai, { catalog });

  return { catalog, cart, malaysia };
}

describe("a Cart moves to another Region", () => {
  it("keeps the same Cart, the same id and every Line Item on it", async () => {
    await using kobai = await createTestKobai();
    const { cart, malaysia } = await aStoreInTwoMarkets(kobai);
    const before = (await (
      await kobai.request(`/store/carts/${cart.id}`, { headers: cart.apiKey.headers })
    ).json()) as { lineItems: { id: string }[] };

    const switched = await switchTo(kobai, cart, malaysia);

    expect(switched.status).toBe(200);
    // The Cart itself, not a copy of it: a storefront holding this identifier goes on holding
    // it, which is the whole of what the amendment buys — "make a new Cart" put the burden of
    // not losing a Shopper's basket on every storefront that integrates.
    await expect(switched.json()).resolves.toMatchObject({
      id: cart.id,
      currency: "MYR",
      region: { id: malaysia, name: "Malaysia", currency: "MYR" },
      lineItems: [{ id: before.lineItems[0]?.id, quantity: 1 }],
    });
  });

  it("re-prices its lines in the new Region on the next read", async () => {
    await using kobai = await createTestKobai();
    const { cart, malaysia } = await aStoreInTwoMarkets(kobai);

    // What the Cart came to before the switch, and after it — asked of the route that answers
    // it, because a Cart carries no total (ADR-0009, ADR-0077).
    const inUsd = await quote(kobai, cart);
    await expect(switchTo(kobai, cart, malaysia)).resolves.toMatchObject({ status: 200 });
    const inMyr = await quote(kobai, cart);

    expect(inUsd).toEqual({ total: 1250, currency: "USD" });
    // No price snapshot anywhere to migrate: the line was re-priced by being read about, which
    // is what a Cart's Line Items already do on every read.
    expect(inMyr).toEqual({ total: 5500, currency: "MYR" });
  });

  it("stays in the currency it was stamped with when the Region moves onto another", async () => {
    // **The duplication ADR-0074 asks for, and the case that justifies it.** A Region's
    // currency is a Merchant's to change; a Cart's is not, or a Shopper mid-checkout is
    // repriced in a currency nobody offered them.
    await using kobai = await createTestKobai();
    const { catalog, cart, malaysia } = await aStoreInTwoMarkets(kobai);
    await switchTo(kobai, cart, malaysia);

    const moved = await kobai.request(`/admin/regions/${malaysia}`, {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currency: "USD" }),
    });
    expect(moved.status).toBe(200);

    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });
    // The Cart's own column still says MYR although the Region it names now selects USD — and
    // that is the answer, not a staleness: this Cart was denominated when it was moved here.
    await expect(read.json()).resolves.toMatchObject({
      currency: "MYR",
      region: { id: malaysia, currency: "USD" },
    });
    await expect(quote(kobai, cart)).resolves.toEqual({ total: 5500, currency: "MYR" });
  });

  it("takes the Region it is already in as the no-op it is", async () => {
    // A storefront submitting the whole state it is holding sends the Region it last read, and
    // refusing that would make an idempotent request fail — including once the Cart is holding
    // stock, where it would look exactly like the guard below firing for a real switch.
    await using kobai = await createTestKobai();
    const { cart, malaysia } = await aStoreInTwoMarkets(kobai);
    await switchTo(kobai, cart, malaysia);
    await hold(kobai, cart);

    const again = await switchTo(kobai, cart, malaysia);

    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ currency: "MYR" });
  });

  it("refuses a Region this Store has not got", async () => {
    await using kobai = await createTestKobai();
    const { cart } = await aStoreInTwoMarkets(kobai);

    const response = await switchTo(kobai, cart, "2f1b8a5e-0000-4000-8000-000000000000");

    // The word the admin surface answers for the same fact, because one fact gets one word
    // whichever end asks it (ADR-0060) — and 422 rather than 400 on
    // `unknown-fulfilment-strategy`'s distinction: the body is well formed and the state of the
    // Store is what refuses it.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "region-not-found",
    });
  });
});

describe("a Cart with something denominated against it", () => {
  it("refuses the switch while it is holding stock, and says the hold is what is holding it", async () => {
    // ADR-0070's case, caused on purpose: stock claimed in the currency the Cart was in, with a
    // Shopper about to be sent to their bank for a figure in that currency.
    await using kobai = await createTestKobai();
    const { catalog, cart, malaysia } = await aStoreInTwoMarkets(kobai);
    await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
      method: "PUT",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand: 5 }),
    });
    await hold(kobai, cart);

    const response = await switchTo(kobai, cart, malaysia);

    expect(response.status).toBe(409);
    const refusal = (await response.json()) as { reason: string; error: string };
    expect(refusal.reason).toBe("cart-is-denominated");
    // It names which of the two is holding it, so a storefront can say something true — and it
    // says the hold lapses by itself, because kobai serves no way to give one back.
    expect(refusal.error).toMatch(/holding stock/);

    // And the Cart really was left where it was, which is the half a status code cannot say.
    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });
    await expect(read.json()).resolves.toMatchObject({ currency: "USD" });
  });

  it("refuses the switch once it has been placed, and that is where a Payment is refused", async () => {
    // **The other half of the guard, and it is `cart-placed` rather than a word of its own.**
    // Core writes `core_payment` inside the transaction that writes the Order (ADR-0009), so a
    // Cart with a Payment against it is a Cart that has been placed — one fact, and the word
    // this surface already has for it. Two facts, two words, each naming which is holding it.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });
    const order = await seedTestOrder(kobai, { catalog });

    const response = await kobai.request(`/store/carts/${order.cart.id}`, {
      method: "PATCH",
      headers: { ...order.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ regionId: malaysia }),
    });

    expect(response.status).toBe(409);
    const refusal = (await response.json()) as { reason: string; error: string };
    expect(refusal.reason).toBe("cart-placed");
    expect(refusal.error).toMatch(/already been placed/);
  });
});

describe("a Region that could not price what is in the Cart", () => {
  it("refuses the switch naming the lines, rather than leaving a Cart nothing can quote", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "POSTER-A2", prices: [1250] },
        { sku: "MUG", prices: [1900] },
      ],
    });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    // The poster is priced in Malaysia and the mug is not — kobai converts nothing, so the mug
    // has no price there at all.
    await setPrice(kobai, catalog, { amount: 5500, currency: "MYR", regionId: malaysia });
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG" }],
    });

    const response = await switchTo(kobai, cart, malaysia);

    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { reason: string; error: string };
    expect(refusal.reason).toBe("variant-not-priced-in-region");
    // The lines, by the SKU a Shopper is looking at — a storefront can only act on the list,
    // and it can act on it: take that line off, or ask a Merchant to price it there.
    expect(refusal.error).toContain("MUG");
    expect(refusal.error).not.toContain("POSTER-A2");

    // Refused rather than half-done: the Cart is still readable and still quotable, which is
    // the whole reason this is refused at the switch rather than met at checkout.
    await expect(quote(kobai, cart)).resolves.toEqual({ total: 3150, currency: "USD" });
  });

  it("judges the lines against the Channel the key is in as well as the Region", async () => {
    // A market is a Region *and* a Channel (ADR-0020, #292), so a line priced only for the
    // storefront Channel is unpriceable to a marketplace key even where the Region has a Price.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    const web = await createChannel(kobai, catalog, "Web");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, {
      amount: 5500,
      currency: "MYR",
      regionId: malaysia,
      channelId: web,
    });

    const throughTheWeb = await createTestApiKey(kobai, catalog.merchant, {
      name: "the storefront",
      channelId: web,
    });
    const marketplace = await seedTestCart(kobai, { catalog });
    const storefront = await seedTestCart(kobai, { catalog, apiKey: throughTheWeb });

    // The key in no Channel cannot be priced in Malaysia at all: the only MYR Price there is
    // the Web one, and a Price constrained to a Channel applies in no other.
    await expect(switchTo(kobai, marketplace, malaysia)).resolves.toMatchObject({
      status: 422,
    });
    await expect(switchTo(kobai, storefront, malaysia)).resolves.toMatchObject({
      status: 200,
    });
  });

  it("asks this deployment's own pricing Step rather than reading the Prices", async () => {
    // **The line the module draws** (ADR-0017): a Project that replaced `select-price` decides
    // what it can price, so a switch is judged by the deployment's own rule. This Store has no
    // MYR Price at all and its Step prices everything, so the switch is allowed — where a query
    // over `core_price` would have refused a Cart this deployment quotes perfectly well.
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": everythingIsFree } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    await enable(kobai, catalog, "USD", "MYR");
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    const cart = await seedTestCart(kobai, { catalog });

    const response = await switchTo(kobai, cart, malaysia);

    expect(response.status).toBe(200);
    await expect(quote(kobai, cart)).resolves.toEqual({ total: 0, currency: "MYR" });
  });
});

/**
 * A Project's own pricing rule, which prices in any Region whether or not a row says so.
 *
 * Deliberately more generous than Core's: what it demonstrates is that the switch asks the
 * *deployment's* declaration, so a Store whose Step invents a price is not refused a market on
 * the strength of rows Core would have read.
 */
const everythingIsFree = defineStep(
  "everything-is-free",
  (input: LoadedPrices): ResolvedPrice => ({
    variant: input.variant,
    region: input.region,
    channel: input.channel,
    price: {
      // A real row's identifier where there is one, so the answer points at something a
      // Merchant can find; the amount and the currency are this Step's own.
      id: input.prices[0]?.id ?? "00000000-0000-4000-8000-000000000000",
      amount: 0,
      currency: input.region.currency,
    },
  }),
);

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

/** What this Cart comes to now, through the route that runs the deployment's own pricing. */
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

/** Holds this Cart's stock, the way a storefront does before a bank redirect (ADR-0070). */
async function hold(kobai: TestKobai, cart: TestCart): Promise<void> {
  const response = await kobai.request(`/store/carts/${cart.id}/reservations`, {
    method: "POST",
    headers: cart.apiKey.headers,
  });
  expect(response.status, "holding this Cart's stock").toBe(200);
}
