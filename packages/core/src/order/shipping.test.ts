import { describe, expect, it } from "vitest";
import type { Logger } from "../config.ts";
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
import { defineStep, type Step } from "../workflow/step.ts";
import {
  type AdjustedLines,
  oneCurrency,
  orderTotalOf,
  type PaidOrder,
  type PricedLines,
  type ReservedLines,
  type TaxedLines,
} from "./place-order.ts";
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
async function aStoreThatDelivers(
  kobai: TestKobai,
  /** How many of the one Variant — named, for the cases whose subject is what the goods come to. */
  { quantity = 1 }: { readonly quantity?: number } = {},
): Promise<{
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
  const cart = await seedTestCart(kobai, { catalog, quantity });
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
 * A `Logger` that keeps every reason Core reported, so a guard's message can be read back.
 *
 * The message is half of what a guard is for and no response body carries it: a 500 says the
 * deployment is broken and only the log says which Adjustment went missing. Asking the `Logger`
 * a deployment supplied is the same move as asking a Payment Provider what it is holding.
 *
 * Shared by the two `describe`s below, because both slots now carry the same guard and reading
 * what it said is the same act at either of them.
 */
const collectingReasons = (logged: string[]): Logger => ({
  info: () => {},
  error: (_message, fields) => {
    logged.push(String(fields?.reason));
  },
});

/**
 * **A Step filling `apply-adjustments` has to pass the carriage on, and the slot is what asks**
 * (#339).
 *
 * The hazard is the one #321 reported rather than fixed. A Step declaring the **narrower**
 * {@link PricedLines} is still assignable to a slot handed a {@link ShippedLines} — TypeScript
 * accepts a function that asks for less than it is given — so a replacement written before
 * shipping existed compiles, answers `adjustments: []`, and the Shopper's delivery charge is
 * gone. The Order totals correctly for the wrong figure, with no error, no log line and no
 * refusal.
 *
 * So the slot carries a guard of its own, and the two cases below are the pair that makes it
 * worth having: the drop is stopped **whatever the Step declared**, and the deployment that adds
 * its own Adjustments beside the carriage is untouched. A guard that made the honest case painful
 * would be worse than the bug.
 */
describe("a Project that replaced apply-adjustments", () => {
  /** What this Store gives free delivery over. Made up, and Core has never heard of it. */
  const FREE_DELIVERY_OVER = 5000;

  /** The code the discount below carries — the Project's to choose, like every other one. */
  const FREE_DELIVERY_CODE = "free-delivery";

  /**
   * *Free delivery over fifty*, written the way ADR-0022 says to write it: **a discount of its
   * own**, beside the charge it cancels, rather than the charge edited away.
   *
   * This is the honest replacement, and it is the reason `select-shipping` runs in front of this
   * slot at all — the rule can *see* what delivery cost, so it is an ordinary Adjustment rather
   * than a special case Core would have had to model. Both lines reach the Order, which is what
   * keeps the record able to say what was charged for carriage and what was given back.
   */
  const freeDeliveryOverFifty = defineStep(
    "free-delivery-over-fifty",
    (input: ShippedLines): AdjustedLines => {
      const goods = input.lines.reduce(
        (sum, line) => sum + line.unitAmount * line.quantity,
        0,
      );
      const carriage = input.adjustments.filter(
        (one) => one.code === SHIPPING_ADJUSTMENT_CODE,
      );

      return {
        cart: input.cart,
        lines: input.lines.map((line) => ({ ...line, adjustments: [] })),
        adjustments: [
          // Carried forward, always — this rule adds, it does not decide what carriage cost.
          ...input.adjustments,
          ...(goods >= FREE_DELIVERY_OVER
            ? carriage.map((one) => ({
                code: FREE_DELIVERY_CODE,
                description: "Free delivery over 50",
                amount: -one.amount,
              }))
            : []),
        ],
      };
    },
  );

  /**
   * The bug, written exactly as somebody would arrive at it: against the shape this slot had
   * before #321, so it never learned there was anything to carry forward.
   */
  const adjustsNothing = defineStep(
    "adjusts-nothing",
    (input: PricedLines): AdjustedLines => ({
      cart: input.cart,
      lines: input.lines.map((line) => ({ ...line, adjustments: [] })),
      adjustments: [],
    }),
  );

  /** The same loss, quieter: the carriage keeps its name and comes back at half the figure. */
  const halvesTheCarriage = defineStep(
    "halves-the-carriage",
    (input: ShippedLines): AdjustedLines => ({
      cart: input.cart,
      lines: input.lines.map((line) => ({ ...line, adjustments: [] })),
      adjustments: input.adjustments.map((one) =>
        one.code === SHIPPING_ADJUSTMENT_CODE ? { ...one, amount: one.amount / 2 } : one,
      ),
    }),
  );

  /** A deployment with this slot filled by the Step given, and somewhere to keep what it logged. */
  const replacing = (
    step: Step<string, ShippedLines, AdjustedLines>,
    logged: string[],
  ) => ({
    logger: collectingReasons(logged),
    workflows: { "place-order": { steps: { "apply-adjustments": step } } },
  });

  it("is stopped, naming the charge it dropped, from the quote and the placement alike", async () => {
    const logged: string[] = [];
    await using kobai = await createTestKobai(replacing(adjustsNothing, logged));
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    // A bug rather than a refusal, on `inWholeMinorUnits`' distinction: the request was fine and
    // this deployment is wired to lose a delivery charge, which is not something a storefront
    // can act on. Reachable from the quote too, because ADR-0077 slices this same declaration —
    // so a storefront finds out before it creates a payment for the wrong figure.
    expect((await quote(kobai, cart)).status).toBe(500);

    expect((await place(kobai, cart)).status).toBe(500);
    // Named, and named by what it was: the code, the figure and the description a Merchant
    // reads — enough to find the Step and to see what the Shopper was about to be under-charged.
    expect(logged).toHaveLength(2);
    for (const reason of logged) {
      expect(reason).toContain(`"${SHIPPING_ADJUSTMENT_CODE}"`);
      expect(reason).toContain(String(STANDARD));
      expect(reason).toContain('"Standard"');
      expect(reason).toContain("apply-adjustments");
      expect(reason).toContain("did not come back at all");
    }
    // And nothing was written, which is the half a status cannot say: the Order this deployment
    // would have under-charged for does not exist.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    await expect(
      kobai.database.query("select id from core_order_adjustment"),
    ).resolves.toEqual([]);
  });

  it("is stopped for repricing the carriage too, and told apart from dropping it", async () => {
    // The other half of the same promise, and the reason the message has two shapes: a Step that
    // kept the line and halved the figure has still taken money off the Order, and reporting it
    // as *missing* would send a reader hunting for a line that is right there. The repair is the
    // one the case above is refused with — a discount of its own, or replace `select-shipping`.
    const logged: string[] = [];
    await using kobai = await createTestKobai(replacing(halvesTheCarriage, logged));
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    expect((await place(kobai, cart)).status).toBe(500);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`"${SHIPPING_ADJUSTMENT_CODE}" of ${STANDARD}`);
    expect(logged[0]).toContain(`came back at ${STANDARD / 2}`);
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("still adds its own Adjustments beside the carriage, and both reach the Order", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": { steps: { "apply-adjustments": freeDeliveryOverFifty } },
      },
    });
    // Five of them, so the goods are over the threshold and this Store's own rule fires — which
    // is what makes the case about a replacement that *adds* rather than one that passes through.
    const { cart, methods } = await aStoreThatDelivers(kobai, { quantity: 5 });
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    const quoted = (await (await quote(kobai, cart)).json()) as Quoted;

    expect(quoted.adjustments.map((one) => [one.code, one.amount])).toEqual([
      [SHIPPING_ADJUSTMENT_CODE, STANDARD],
      [FREE_DELIVERY_CODE, -STANDARD],
    ]);
    // The carriage and the discount cancel, so the Shopper pays for the goods and nothing else —
    // and the Order still says both, which is what an Adjustment being its own line buys.
    expect(quoted.total).toBe(THE_PRICE * 5);

    const placed = await place(kobai, cart);

    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.total).toBe(quoted.total);
    expect(order.adjustments.map((one) => [one.code, one.amount])).toEqual([
      [SHIPPING_ADJUSTMENT_CODE, STANDARD],
      [FREE_DELIVERY_CODE, -STANDARD],
    ]);
  });
});

/**
 * **A Step filling `calculate-tax` has to pass the carriage on too, and the same guard asks**
 * (#339).
 *
 * The neighbour's hazard one slot along, and it was open until this was written. `TaxedLines`
 * makes every Adjustment state its own `tax`, which stops a Step handing the list through
 * *untaxed* — `place-order.test.ts` pins that with a `@ts-expect-error`, and it is a different
 * mistake from this one. What a type cannot ask is for a list to be **non-empty**: `[]` satisfies
 * `readonly TaxedAdjustment[]` trivially, so a replacement answering `adjustments: []` compiles,
 * and the Shopper's delivery charge is off the Order exactly as it was at `apply-adjustments`
 * before the guard existed. The Order totals correctly for the wrong figure.
 *
 * So this slot carries the same postcondition, and the pair below is the pair above one slot
 * along: the drop is stopped whatever the Step declared, and the Step that taxes every
 * Adjustment honestly is untouched.
 */
describe("a Project that replaced calculate-tax", () => {
  /**
   * The bug, written the way somebody arrives at it: a rule that taxes **lines**, because lines
   * are what tax is about, and rebuilds the value without the Order's own Adjustments.
   *
   * Every `TaxedAdjustment` it returns does state its own tax — vacuously, because it returns
   * none. That is precisely the gap the return type leaves open.
   */
  const taxesTheLinesAndForgetsTheOrder = defineStep(
    "taxes-the-lines-and-forgets-the-order",
    (input: AdjustedLines): TaxedLines => ({
      cart: input.cart,
      lines: input.lines.map((line) => ({ ...line, tax: 0 })),
      adjustments: [],
    }),
  );

  /**
   * The honest replacement: a made-up ten per cent, stated for the carriage as well as the lines.
   *
   * Core has no jurisdiction and never will, which is why this is a slot rather than a tax table
   * — and taxing an Order-level Adjustment is the case that field exists for (#117), a delivery
   * surcharge belonging to no line whose tax could carry it.
   *
   * `place-order.test.ts` has a Step of this shape already, and this one is not it: that case
   * hands the carriage to itself through a replaced `apply-adjustments`, so it says nothing about
   * the guard. This Adjustment comes from **Core's own `select-shipping`**, through a Store that
   * really prices delivery, so what it shows is that the guard accepts an honest Step rather than
   * only that the arithmetic adds up. A guard nobody has watched accept is as untested as one
   * nobody has watched refuse.
   */
  const taxesTheCarriageToo = defineStep(
    "taxes-the-carriage-too",
    (input: AdjustedLines): TaxedLines => ({
      cart: input.cart,
      lines: input.lines.map((line) => ({
        ...line,
        tax: Math.round(line.unitAmount * line.quantity * 0.1),
      })),
      adjustments: input.adjustments.map((one) => ({
        ...one,
        tax: Math.round(one.amount * 0.1),
      })),
    }),
  );

  /** A deployment with this slot filled by the Step given, and somewhere to keep what it logged. */
  const replacing = (
    step: Step<string, AdjustedLines, TaxedLines>,
    logged: string[],
  ) => ({
    logger: collectingReasons(logged),
    workflows: { "place-order": { steps: { "calculate-tax": step } } },
  });

  it("is stopped for dropping the carriage, which its return type could not refuse", async () => {
    const logged: string[] = [];
    await using kobai = await createTestKobai(
      replacing(taxesTheLinesAndForgetsTheOrder, logged),
    );
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    // A bug rather than a refusal, and reachable from the quote as well: ADR-0077 slices this
    // same declaration, and `calculate-tax` is inside the slice — so a storefront finds out
    // before it sends a Shopper to a bank for a figure missing the delivery charge.
    expect((await quote(kobai, cart)).status).toBe(500);

    expect((await place(kobai, cart)).status).toBe(500);
    expect(logged).toHaveLength(2);
    for (const reason of logged) {
      expect(reason).toContain(`"${SHIPPING_ADJUSTMENT_CODE}"`);
      expect(reason).toContain(String(STANDARD));
      expect(reason).toContain('"Standard"');
      // The slot, not the Step: what a reader needs is the position to look at in their config.
      expect(reason).toContain("calculate-tax");
      expect(reason).toContain("did not come back at all");
    }
    // And nothing was written, which is the half a status cannot say.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    await expect(
      kobai.database.query("select id from core_order_adjustment"),
    ).resolves.toEqual([]);
  });

  it("still taxes the carriage it was given, and the Order carries both figures", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": { steps: { "calculate-tax": taxesTheCarriageToo } },
      },
    });
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    const placed = await place(kobai, cart);

    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    expect(order.adjustments.map((one) => [one.code, one.amount, one.tax])).toEqual([
      [SHIPPING_ADJUSTMENT_CODE, STANDARD, STANDARD / 10],
    ]);
    // 1250 of goods and 125 of tax on them; 500 of carriage and 50 of tax on that.
    expect(order.total).toBe(1925);
  });
});

/**
 * **The two slots that *act* carry the guard too, and there the quote cannot help** (#339).
 *
 * `hold-reservations` and `take-payment` are handed the Order's Adjustments — already taxed by
 * now — and each returns a value of its own: `ReservedLines` and `PaidOrder` are both
 * `TaxedLines &` extensions, so `adjustments: []` satisfies either and a replacement that
 * rebuilds the value rather than spreading it drops the carriage exactly as the two slots in
 * front of it could. Nothing about these types says otherwise, and neither does the compiler.
 *
 * **What is different here is the notice, not the loss.** ADR-0077 slices the declaration before
 * `hold-reservations`, so a quote never reaches either slot: a storefront is told the right
 * figure and the placement then fails. That is asserted below rather than glossed, because it is
 * the honest limit of a postcondition at a position the quote does not run.
 *
 * **And `take-payment` is the sharpest of the four.** Its own input is what the total is computed
 * from, so a Step there charges the Shopper for the carriage and hands back a value without it —
 * money taken for a figure `capture-order` would then not record. The guard stops the run before
 * the Order exists; giving the money back is the replacement Step\'s own compensation, because a
 * replacement brings its own (ADR-0036).
 */
describe("a Project that replaced a slot after the quote", () => {
  /** What a Step at either position needs to say about money, for the cases that get that far. */
  const anInvoice = (input: ReservedLines, reference: string) => ({
    provider: "on-account",
    reference,
    amount: orderTotalOf(input),
    currency: oneCurrency(input.lines),
    // Arranged rather than taken, which is what an invoice is — and the flag `TakenPayment`
    // grew for exactly this kind of provider.
    received: false,
  });

  /**
   * The bug at `hold-reservations`: a deployment whose stock lives elsewhere, so the Step claims
   * nothing — and builds its answer from the fields it knew about rather than from what it was
   * handed.
   */
  const holdsNothingAndRebuildsTheValue = defineStep(
    "holds-nothing-and-rebuilds-the-value",
    (input: TaxedLines): ReservedLines => ({
      cart: input.cart,
      lines: input.lines,
      adjustments: [],
      reservations: [],
    }),
  );

  /** The honest one at the same slot: claims nothing, and hands on everything it was given. */
  const holdsNothingAndHandsItOn = defineStep(
    "holds-nothing-and-hands-it-on",
    (input: TaxedLines): ReservedLines => ({ ...input, reservations: [] }),
  );

  /** The bug at `take-payment`: bills the full total, then answers without what it billed for. */
  const chargesAndRebuildsTheValue = defineStep(
    "charges-and-rebuilds-the-value",
    (input: ReservedLines): PaidOrder => ({
      cart: input.cart,
      lines: input.lines,
      adjustments: [],
      reservations: input.reservations,
      payment: anInvoice(input, "invoice-that-billed-for-carriage"),
    }),
  );

  /** The honest one at the same slot: a Store that invoices rather than charging a card. */
  const takesItOnAccount = defineStep(
    "takes-it-on-account",
    (input: ReservedLines): PaidOrder => ({
      ...input,
      payment: anInvoice(input, "invoice-0001"),
    }),
  );

  it("is stopped at hold-reservations, after a quote that could not have caught it", async () => {
    const logged: string[] = [];
    await using kobai = await createTestKobai({
      logger: collectingReasons(logged),
      workflows: {
        "place-order": {
          steps: { "hold-reservations": holdsNothingAndRebuildsTheValue },
        },
      },
    });
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    // **The quote is fine**, and that is the limit rather than an oversight: ADR-0077 stops the
    // slice at the first slot that acts, so nothing before the placement runs this Step at all.
    const quoted = await quote(kobai, cart);
    expect(quoted.status).toBe(200);
    expect(((await quoted.json()) as Quoted).total).toBe(THE_PRICE + STANDARD);

    expect((await place(kobai, cart)).status).toBe(500);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`"${SHIPPING_ADJUSTMENT_CODE}"`);
    expect(logged[0]).toContain(String(STANDARD));
    expect(logged[0]).toContain("hold-reservations");
    expect(logged[0]).toContain("did not come back at all");
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("is stopped at take-payment, which had already billed for what it dropped", async () => {
    const logged: string[] = [];
    await using kobai = await createTestKobai({
      logger: collectingReasons(logged),
      workflows: {
        "place-order": { steps: { "take-payment": chargesAndRebuildsTheValue } },
      },
    });
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    expect((await place(kobai, cart)).status).toBe(500);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(`"${SHIPPING_ADJUSTMENT_CODE}"`);
    expect(logged[0]).toContain("take-payment");
    expect(logged[0]).toContain("did not come back at all");
    // No Order and no payment row — the write is one transaction, so the money this Step says it
    // took is recorded nowhere, which is the state its own compensation exists to repair.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    await expect(kobai.database.query("select id from core_payment")).resolves.toEqual(
      [],
    );
  });

  it("leaves an honest replacement of either slot placing an Order, carriage and all", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          steps: {
            "hold-reservations": holdsNothingAndHandsItOn,
            "take-payment": takesItOnAccount,
          },
        },
      },
    });
    const { cart, methods } = await aStoreThatDelivers(kobai);
    const standard = methods.find((one) => one.name === "Standard");
    await tell(kobai, cart, { address: AN_ADDRESS, shippingMethodId: standard?.id });

    const placed = await place(kobai, cart);

    expect(placed.status).toBe(201);
    const order = (await placed.json()) as Placed;
    // Both replaced at once, on purpose: the guard is at each position, so a Project that owns
    // the whole back half of the Workflow is the case that would notice a guard that only
    // tolerated one honest Step at a time.
    expect(order.adjustments.map((one) => [one.code, one.amount])).toEqual([
      [SHIPPING_ADJUSTMENT_CODE, STANDARD],
    ]);
    expect(order.total).toBe(THE_PRICE + STANDARD);
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
