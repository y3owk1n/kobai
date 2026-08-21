import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  inspectSchema,
  MIXED_ORDER_DIGITAL_SKU,
  MIXED_ORDER_PHYSICAL_SKU,
  seedTestCart,
  seedTestCatalog,
  seedTestMixedOrder,
  signInTestMerchant,
  type TestCart,
  type TestCatalog,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";
import type { PricedLines } from "./place-order.ts";
import { SHIPPING_ADJUSTMENT_CODE, type ShippedLines } from "./select-shipping.ts";

/**
 * **What it costs to deliver an Order, and where that figure lives** (#321).
 *
 * Everything is asserted at the HTTP seam, because every one of these is a promise about a
 * request and a response: what a Cart is offered, what a quote says it comes to, what Capture
 * charges, and what a Cart with nowhere to be sent is told. The one exception is the last
 * `describe`, which asks Postgres a question no response body can answer — that `core_order`
 * gained no `shipping_total` while all of this was being built.
 *
 * **The charge is an Order-level Adjustment and never a column**, and that decision is doing
 * more work than it looks like: an Order-level Adjustment already carries its own tax, which is
 * exactly what carriage needs and what no Line Item's tax could hold, and refunds already know
 * what an Adjustment is. A `shipping_total` would have needed a special case in tax, in refunds
 * and in every place money is totted up, forever (ADR-0022).
 *
 * **The quote and the charge are asserted against *one* Cart**, deliberately. Two Carts agreeing
 * proves nothing a coincidence could not: what ADR-0077 promises is that the figure a storefront
 * starts a payment for is the figure kobai then takes, and the only way to say that is to quote a
 * Cart and then place *that* Cart.
 */

/** What this Store charges to deliver, named here because every assertion below counts in it. */
const STANDARD = 500;
const NEXT_DAY = 1500;

/** What `seedTestCatalog` prices a Variant at, named because the totals are arithmetic on it. */
const THE_PRICE = 1250;

/** An address no postal authority would check, which is the whole of what Core asks (ADR-0072). */
const AN_ADDRESS = {
  country: "MY",
  lines: ["12 Jalan Ampang"],
  postalCode: "50450",
};

type ShippingOption = {
  readonly id: string;
  readonly name: string;
  readonly amount: number;
};

type Quoted = {
  readonly total: number;
  readonly lineItems: readonly { readonly sku: string; readonly total: number }[];
  readonly adjustments: readonly {
    readonly code: string;
    readonly description: string;
    readonly amount: number;
    readonly tax: number;
  }[];
};

type Placed = {
  readonly id: string;
  readonly total: number;
  readonly lineItems: readonly { readonly sku: string; readonly total: number }[];
  readonly adjustments: readonly {
    readonly code: string;
    readonly description: string;
    readonly amount: number;
    readonly tax: number;
    readonly metadata: Record<string, unknown>;
  }[];
};

/** The Region a Cart that names none is bought in — the one a boot seeded (#292). */
async function defaultRegionOf(kobai: TestKobai, merchant: TestSession): Promise<string> {
  const store = (await (
    await kobai.request("/admin/store", { headers: merchant.headers })
  ).json()) as { defaultRegion: { id: string } | null };
  const region = store.defaultRegion?.id;
  if (region === undefined) throw new Error("this deployment seeded no default Region");
  return region;
}

/**
 * Prices delivery into a Region, through the route a Merchant uses.
 *
 * Arrangement in the open, like every other one in this repository: a Store that has not said
 * what carriage costs charges none, so a test about a shipping charge has to say it — and saying
 * it here is what makes *this Store prices no delivery* an arrangement rather than a default
 * some helper hid.
 */
async function priceDeliveryInto(
  kobai: TestKobai,
  merchant: TestSession,
  regionId: string,
  methods: readonly {
    readonly name: string;
    readonly amount: number;
    readonly metadata?: Record<string, unknown>;
  }[],
): Promise<readonly ShippingOption[]> {
  const response = await kobai.request(`/admin/regions/${regionId}`, {
    method: "PATCH",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ shippingMethods: methods }),
  });
  if (response.status !== 200) {
    throw new Error(
      `pricing delivery answered ${response.status}: ${JSON.stringify(await response.json())}`,
    );
  }
  const region = (await response.json()) as {
    shippingMethods: readonly ShippingOption[];
  };
  return region.shippingMethods;
}

/** What a storefront sends when the Shopper has said where it goes and how it should get there. */
async function tell(
  kobai: TestKobai,
  cart: TestCart,
  body: Record<string, unknown>,
): Promise<Response> {
  return kobai.request(`/store/carts/${cart.id}`, {
    method: "PATCH",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function optionsFor(kobai: TestKobai, cart: TestCart): Promise<Response> {
  return kobai.request(`/store/carts/${cart.id}/shipping-options`, {
    headers: cart.apiKey.headers,
  });
}

async function quote(kobai: TestKobai, cart: TestCart): Promise<Response> {
  return kobai.request(`/store/carts/${cart.id}/quote`, {
    method: "POST",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function place(kobai: TestKobai, cart: TestCart): Promise<Response> {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId: cart.id }),
  });
}

/**
 * A Store that delivers, a Cart of something physical, and the rates it may be delivered by.
 *
 * The arrangement most of the cases below want, and it is deliberately not a helper in
 * `@kobai/core/testing`: whether a Store prices delivery at all is the thing half of these cases
 * are about, so it stays visible in the file that is about it.
 */
async function aStoreThatDelivers(kobai: TestKobai): Promise<{
  readonly catalog: TestCatalog;
  readonly cart: TestCart;
  readonly methods: readonly ShippingOption[];
}> {
  const catalog = await seedTestCatalog(kobai, { prices: [THE_PRICE] });
  const region = await defaultRegionOf(kobai, catalog.merchant);
  const methods = await priceDeliveryInto(kobai, catalog.merchant, region, [
    { name: "Standard", amount: STANDARD },
    { name: "Next day", amount: NEXT_DAY },
  ]);
  const cart = await seedTestCart(kobai, { catalog });
  return { catalog, cart, methods };
}

describe("what a Cart may be shipped by", () => {
  it("offers the Region's rates, in the Merchant's order, on the browser's key", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [THE_PRICE] });
    const region = await defaultRegionOf(kobai, catalog.merchant);
    const methods = await priceDeliveryInto(kobai, catalog.merchant, region, [
      // A rate carrying the Merchant's own bag, so the assertion below says something: this
      // route is opened by a publishable key and #207's split is what keeps `metadata` off it.
      { name: "Standard", amount: STANDARD, metadata: { carrier: "poslaju" } },
      { name: "Next day", amount: NEXT_DAY },
    ]);
    const cart = await seedTestCart(kobai, { catalog });
    // A **publishable** key, asked for by name because the kind is the subject: a delivery step
    // is rendered in a browser, so gating this would push every one through a Project's own
    // server for no boundary in return (ADR-0055, ADR-0077).
    const browser = await createTestApiKey(kobai, catalog.merchant, {
      kind: "publishable",
    });

    const response = await kobai.request(`/store/carts/${cart.id}/shipping-options`, {
      headers: browser.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cartId: cart.id,
      requiresShipping: true,
      // The Cart's own stamp rather than the Region's, which is what a Merchant moving a Region
      // onto another currency must not reprice (ADR-0074).
      currency: "USD",
      // **Three fields and not the Merchant's bag** (#207): a rate really does carry one here,
      // and what a browser is offered names the fields one by one rather than by omission.
      options: methods.map((one) => ({
        id: one.id,
        name: one.name,
        amount: one.amount,
      })),
    });
  });

  /**
   * A Cart of downloads: nothing to choose, nothing to say, nothing to pay.
   *
   * **Asserted against the mixed-Order catalog rather than a convenient all-digital one** (#321).
   * The Store here really does sell something physical, and really does price delivery for it —
   * so a build that answered "requires shipping" per *Store* rather than per Cart would be green
   * against a catalog with nothing physical in it, and is red against this one.
   */
  it("offers nothing to a Cart nothing in which ships, and asks it for no Address", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const catalog = await seedTestCatalog(kobai, {
      merchant,
      variants: [
        { sku: MIXED_ORDER_PHYSICAL_SKU, prices: [THE_PRICE] },
        {
          sku: MIXED_ORDER_DIGITAL_SKU,
          fulfilmentStrategy: "digital",
          prices: [THE_PRICE],
        },
      ],
    });
    const region = await defaultRegionOf(kobai, merchant);
    await priceDeliveryInto(kobai, merchant, region, [
      { name: "Standard", amount: STANDARD },
    ]);
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: MIXED_ORDER_DIGITAL_SKU }],
    });

    const response = await optionsFor(kobai, cart);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      cartId: cart.id,
      requiresShipping: false,
      currency: "USD",
      options: [],
    });

    // And it places, with no Address and no choice, in one step — which is story 20.
    const placed = await place(kobai, cart);
    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.adjustments).toEqual([]);
    expect(order.total).toBe(THE_PRICE);
  });

  it("offers nothing where this Store prices no delivery into the Cart's Region", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [THE_PRICE] });
    const cart = await seedTestCart(kobai, { catalog });

    const response = await optionsFor(kobai, cart);

    expect(response.status).toBe(200);
    // `requiresShipping` is true — a poster is shipped whatever this Store charges for it — and
    // the empty list is the Store, which is the distinction a storefront needs to render
    // *delivery included* rather than *choose a method*.
    await expect(response.json()).resolves.toMatchObject({
      requiresShipping: true,
      options: [],
    });

    // And such a Cart places, charging nothing for carriage: kobai sold physical things this way
    // before shipping existed, and a Store that has not priced delivery is not one that has to.
    const placed = await place(kobai, cart);
    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.adjustments).toEqual([]);
  });

  /**
   * A Cart that names no Region is offered — and charged — the **Store's default** Region's
   * rates, which is exactly what such a Cart is already *priced* for (`marketOfCart`).
   *
   * Two readers that disagreed here would leave a real Cart unplaceable: one offering a method
   * the other would then refuse `shipping-method-not-found`, and the placement refusing
   * `shipping-method-required` for ever. It is reachable without anybody doing anything wrong —
   * `core_cart.region_id` is `set null`, so deleting a Region empties it under a Shopper who is
   * holding a basket — and this is the case that walks that whole path.
   */
  it("offers the Store's default Region's rates to a Cart whose Region has gone", async () => {
    await using kobai = await createTestKobai();
    const { catalog, cart, methods } = await aStoreThatDelivers(kobai);
    const elsewhere = (await (
      await kobai.request("/admin/regions", {
        method: "POST",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Elsewhere", currency: "USD" }),
      })
    ).json()) as { id: string };
    expect((await tell(kobai, cart, { regionId: elsewhere.id })).status).toBe(200);
    const removed = await kobai.request(`/admin/regions/${elsewhere.id}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    expect(removed.status).toBe(204);

    const response = await optionsFor(kobai, cart);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requiresShipping: true,
      options: methods.map((one) => ({ id: one.id, name: one.name, amount: one.amount })),
    });

    // And the offer is one the Cart can act on: choosing it is taken, and placing charges it.
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: methods[0]?.id });
    const placed = await place(kobai, cart);
    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.adjustments.map((one) => one.amount)).toEqual([STANDARD]);
  });

  it("refuses the same words the quote and the placement do", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [THE_PRICE] });
    const empty = await seedTestCart(kobai, { catalog, lines: [] });

    const response = await optionsFor(kobai, empty);

    // The Cart is read through the one function a hold, a quote and a placement read it through,
    // so `cart-empty` is 422 here exactly as it is there — a storefront branches on `reason` and
    // is never told which route it was on.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-empty" });
  });
});

describe("a Cart with something to deliver and nowhere to send it", () => {
  it("is refused with a named reason, from the quote and from the placement alike", async () => {
    await using kobai = await createTestKobai();
    const { cart } = await aStoreThatDelivers(kobai);

    const quoted = await quote(kobai, cart);
    expect(quoted.status).toBe(422);
    await expect(quoted.json()).resolves.toMatchObject({
      reason: "shipping-address-required",
      workflow: { name: "place-order", failed: "select-shipping" },
    });

    // **Reachable from both**, which is what ADR-0077's promise means here: a storefront meets
    // this before it sends a Shopper to a bank rather than after.
    const placed = await place(kobai, cart);
    expect(placed.status).toBe(422);
    await expect(placed.json()).resolves.toMatchObject({
      reason: "shipping-address-required",
    });
  });

  it("is refused for having chosen no way of delivering it, once it has an Address", async () => {
    await using kobai = await createTestKobai();
    const { cart } = await aStoreThatDelivers(kobai);
    expect((await tell(kobai, cart, { address: AN_ADDRESS })).status).toBe(200);

    const quoted = await quote(kobai, cart);

    // Refusing beats charging zero: an Order that shipped for nothing because a storefront
    // skipped a step is a Merchant paying for carriage. The refusal names what is on offer.
    expect(quoted.status).toBe(422);
    const body = (await quoted.json()) as { reason: string; error: string };
    expect(body.reason).toBe("shipping-method-required");
    expect(body.error).toContain("Standard");
    expect((await place(kobai, cart)).status).toBe(422);
  });
});

describe("the shipping charge", () => {
  /**
   * The figure the storefront was quoted is the figure the Shopper is charged — **one Cart**.
   *
   * That is the property ADR-0077 exists for, and two Carts agreeing would prove nothing a
   * coincidence could not. So this quotes a Cart, then places *that* Cart, and holds the second
   * answer to the first.
   */
  it("is quoted and then charged, as an Adjustment on the Order, against one Cart", async () => {
    await using kobai = await createTestKobai();
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const nextDay = methods.find((one) => one.name === "Next day");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: nextDay?.id });

    const quoted = (await (await quote(kobai, cart)).json()) as Quoted;

    // An Adjustment on the Cart as a whole rather than a figure of its own, carrying the tax
    // slot from the day it ships — `calculate-tax` returns zero, which is spec 7's to change.
    expect(quoted.adjustments).toEqual([
      {
        code: SHIPPING_ADJUSTMENT_CODE,
        description: "Next day",
        amount: NEXT_DAY,
        tax: 0,
        metadata: {
          shippingMethodId: nextDay?.id,
          shippingMethodName: "Next day",
        },
      },
    ]);
    expect(quoted.total).toBe(THE_PRICE + NEXT_DAY);

    const placed = await place(kobai, cart);

    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    // **The same figure**, which is the whole assertion: the quote runs the deployment's own
    // `place-order` as far as the tax, and the placement runs the rest of it.
    expect(order.total).toBe(quoted.total);
    expect(order.adjustments).toEqual([
      {
        id: expect.any(String),
        code: SHIPPING_ADJUSTMENT_CODE,
        description: "Next day",
        amount: NEXT_DAY,
        tax: 0,
        metadata: {
          shippingMethodId: nextDay?.id,
          shippingMethodName: "Next day",
        },
      },
    ]);
    // And the total is still the sum of the lines and the Adjustments, computed by the same
    // expression it always was — which is what putting the charge in an Adjustment bought.
    expect(order.total).toBe(
      order.lineItems.reduce((sum, line) => sum + line.total, 0) +
        order.adjustments.reduce((sum, one) => sum + one.amount + one.tax, 0),
    );
  });

  /**
   * A mixed Cart takes **exactly one** charge, and the digital part contributes nothing.
   *
   * The rate is the Region's rather than a sum over lines, which is the whole of what a flat rate
   * means — so the assertion is that a Cart with a download in it costs the same to deliver as
   * one without, and that there is one Adjustment rather than one per shipped line.
   */
  it("is one charge on a mixed Cart, and the download adds nothing to it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const catalog = await seedTestCatalog(kobai, {
      merchant,
      variants: [
        { sku: MIXED_ORDER_PHYSICAL_SKU, prices: [THE_PRICE] },
        {
          sku: MIXED_ORDER_DIGITAL_SKU,
          fulfilmentStrategy: "digital",
          prices: [THE_PRICE],
        },
      ],
    });
    const region = await defaultRegionOf(kobai, merchant);
    const [standard] = await priceDeliveryInto(kobai, merchant, region, [
      { name: "Standard", amount: STANDARD },
    ]);

    const mixed = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: MIXED_ORDER_PHYSICAL_SKU }, { sku: MIXED_ORDER_DIGITAL_SKU }],
    });
    await tell(kobai, mixed, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    const placed = await place(kobai, mixed);

    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.adjustments.map((one) => one.amount)).toEqual([STANDARD]);
    // Two lines of goods and one charge to deliver both.
    expect(order.lineItems).toHaveLength(2);
    expect(order.total).toBe(THE_PRICE * 2 + STANDARD);
  });

  it("is unchosen when the Cart moves to another Region, because a rate belongs to one", async () => {
    await using kobai = await createTestKobai();
    const { catalog, cart, methods } = await aStoreThatDelivers(kobai);
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: methods[0]?.id });

    const elsewhere = (await (
      await kobai.request("/admin/regions", {
        method: "POST",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "Elsewhere", currency: "USD" }),
      })
    ).json()) as { id: string };

    const moved = await tell(kobai, cart, { regionId: elsewhere.id });

    expect(moved.status).toBe(200);
    // The Shopper chooses again rather than being charged a rate denominated for somewhere else.
    await expect(moved.json()).resolves.toMatchObject({ shippingMethod: null });
  });

  it("cannot be a rate belonging to another Region", async () => {
    await using kobai = await createTestKobai();
    const { catalog, cart } = await aStoreThatDelivers(kobai);
    const elsewhere = (await (
      await kobai.request("/admin/regions", {
        method: "POST",
        headers: { ...catalog.merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Elsewhere",
          currency: "USD",
          shippingMethods: [{ name: "Air freight", amount: 9900 }],
        }),
      })
    ).json()) as { id: string; shippingMethods: readonly ShippingOption[] };

    const refused = await tell(kobai, cart, {
      shippingMethodId: elsewhere.shippingMethods[0]?.id,
    });

    // 422 and the word the admin surface answers for the same fact, because it is one fact —
    // this Store has no such method *for this Cart* — reached from the other end (ADR-0060).
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toMatchObject({
      reason: "shipping-method-not-found",
    });
  });

  it("is given back when the Merchant withdraws the rate, and the Cart chooses again", async () => {
    await using kobai = await createTestKobai();
    const { catalog, cart, methods } = await aStoreThatDelivers(kobai);
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: methods[0]?.id });
    const region = await defaultRegionOf(kobai, catalog.merchant);

    await priceDeliveryInto(kobai, catalog.merchant, region, [
      { name: "Next day", amount: NEXT_DAY },
    ]);

    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });
    // `set null` rather than a Cart nothing can read: withdrawing a rate leaves the Shopper
    // choosing again, and the placement then says so rather than charging a figure nobody offers.
    await expect(read.json()).resolves.toMatchObject({ shippingMethod: null });
    expect((await quote(kobai, cart)).status).toBe(422);
  });
});

/**
 * **Extension Point 2, proved rather than asserted** (ADR-0017, ADR-0077).
 *
 * A deployment replaces `select-shipping` in the same `kobai.config.ts` shape a Developer writes,
 * and the property being held is the one that matters: the replacement's figure is what the quote
 * says *and* what Capture charges. A build where only one of the two ran the deployment's own
 * declaration would pass half of this.
 *
 * The replacement is a rate Core could never have worked out — a charge per line, out of nothing
 * the Region carries — so a green run cannot be Core's own implementation answering by accident.
 */
describe("a Project that replaced select-shipping", () => {
  /** A flat charge per shipped line. Core has never heard of this rule. */
  const PER_LINE = 333;

  const perLine = defineStep(
    "a-charge-per-parcel",
    (input: PricedLines): ShippedLines => {
      const parcels = input.lines.filter((line) => line.fulfilment.requiresShipping);
      return {
        ...input,
        adjustments:
          parcels.length === 0
            ? []
            : [
                {
                  code: "carriage",
                  description: `${parcels.length} parcel(s)`,
                  amount: PER_LINE * parcels.length,
                },
              ],
      };
    },
  );

  it("quotes and charges its own figure, and asks for no Address kobai would have asked for", async () => {
    await using kobai = await createTestKobai({
      workflows: { "place-order": { steps: { "select-shipping": perLine } } },
    });
    // No shipping method on the Region and no Address on the Cart: this deployment's rule needs
    // neither, and Core's refusals are Core's Step's rather than the slot's.
    const catalog = await seedTestCatalog(kobai, { prices: [THE_PRICE] });
    const cart = await seedTestCart(kobai, { catalog });

    const quoted = (await (await quote(kobai, cart)).json()) as Quoted;

    expect(quoted.adjustments).toEqual([
      {
        code: "carriage",
        description: "1 parcel(s)",
        amount: PER_LINE,
        tax: 0,
        metadata: {},
      },
    ]);
    expect(quoted.total).toBe(THE_PRICE + PER_LINE);

    const placed = await place(kobai, cart);

    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.total).toBe(quoted.total);
    expect(order.adjustments.map((one) => one.code)).toEqual(["carriage"]);
  });
});

/**
 * **`core_order` gained no `shipping_total`, and that is asked of Postgres** (#321, ADR-0022).
 *
 * A promise about what is *not* in the schema is one nothing else notices going missing, so it is
 * asked as a sweep for anything that looks like a delivery total rather than for the one column
 * name somebody might have reached for first — `a-fulfilment-moves.test.ts`'s shape, one noun
 * along, and for its reason: the cheap answer arrives spelled `delivery_total` at least as often.
 *
 * Paired with the positive half in the same case, because an emptiness assertion nobody has seen
 * fail is not yet known to be able to: the charge really is on `core_order_adjustment`, so the
 * sweep is looking for a column on the wrong table rather than for one nothing has.
 */
describe("what was charged for carriage is an Adjustment and never a column", () => {
  /** What a delivery total would be called, whichever way somebody reached for one. */
  const LOOKS_LIKE_A_DELIVERY_TOTAL = /ship|delivery|carriage|freight|postage/i;

  it("puts it on core_order_adjustment and leaves core_order without one", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    // The qualified refs `tables()` hands back rather than bare names: a bare name resolves to
    // `public`, so a sweep aimed at the wrong schema finds no columns and reports the rule holds.
    const tables = await schema.tables();
    const refFor = (name: string) => {
      const found = tables.find((table) => table.name === name);
      if (!found) throw new Error(`this database has no ${name}`);
      return found;
    };

    // The positive half first, so the sweep below is not vacuously green against a build where
    // carriage is not recorded anywhere at all.
    const adjustmentColumns = (
      await schema.columnsOf(refFor("core_order_adjustment"))
    ).map((column) => column.name);
    expect(adjustmentColumns).toContain("amount");
    expect(adjustmentColumns).toContain("tax");

    const orderColumns = (await schema.columnsOf(refFor("core_order"))).map(
      (column) => column.name,
    );
    const totals = orderColumns.filter((name) => LOOKS_LIKE_A_DELIVERY_TOTAL.test(name));

    expect(
      totals,
      `core_order carries ${totals.join(", ")}. What delivery cost is an Order-level Adjustment (ADR-0022) — it carries its own tax, refunds already know what one is, and an Order's total is still the sum of its lines and its Adjustments.`,
    ).toEqual([]);
  });

  it("charges nothing extra for the delivery of an Order nobody asked to be delivered", async () => {
    // The mixed-Order fixture, placed exactly as `seedTestMixedOrder` places it: no Address, no
    // chosen method, and a Store that prices no delivery. That is where every deployment starts,
    // and it is what says shipping did not become mandatory the day it was built.
    await using kobai = await createTestKobai();
    const order = await seedTestMixedOrder(kobai);

    const read = await kobai.request(`/admin/orders/${order.id}`, {
      headers: order.catalog.merchant.headers,
    });

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ adjustments: [] });
  });
});
