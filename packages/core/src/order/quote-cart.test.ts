import { describe, expect, it } from "vitest";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import type {
  AdjustedLines,
  PricedLines,
  ShippedLines,
  TaxedLines,
} from "./place-order.ts";

/**
 * **What a Cart comes to, asked before anything is bought** — `POST /store/carts/{id}/quote`
 * (ADR-0077).
 *
 * Tested through the HTTP seam, because the promise is a storefront's: it asks one route and
 * gets the figure the placement will charge. The two assertions that carry the ticket are the
 * ones nothing smaller can make — that a quote and a placement of the same unchanged Cart
 * *agree*, run against a deployment that replaced every pricing Step, and that quoting leaves
 * the Store exactly as it found it.
 */

async function quote(
  kobai: TestKobai,
  headers: Record<string, string>,
  cartId: string,
  body?: unknown,
) {
  // No `content-type` when there is no body: this route's body is optional, and a storefront
  // that has nothing to say about the open context sends nothing at all.
  return body === undefined
    ? kobai.request(`/store/carts/${cartId}/quote`, { method: "POST", headers })
    : kobai.request(`/store/carts/${cartId}/quote`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
}

async function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

/** What the Store believes it has, read the way a Merchant reads it. */
async function stockOf(kobai: TestKobai, catalog: TestCatalog, variantId: string) {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  const product = (await response.json()) as {
    variants: readonly {
      id: string;
      inventory: { onHand: number; reserved: number; available: number } | null;
    }[];
  };
  const found = product.variants.find((variant) => variant.id === variantId)?.inventory;
  // The three numbers, without the identifier the test already named — so a failure reads as
  // what the Store has rather than as a uuid nobody was asking about.
  return found == null
    ? found
    : { onHand: found.onHand, reserved: found.reserved, available: found.available };
}

describe("quoting a Cart", () => {
  it("answers what it comes to now — the lines, and the total they add up to", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await quote(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cartId: cart.id,
      currency: "USD",
      total: 2500,
      lineItems: [
        {
          lineItemId: cart.lineItem("POSTER-A2").id,
          variantId: catalog.variantId,
          sku: "POSTER-A2",
          quantity: 2,
          unitAmount: 1250,
          tax: 0,
          adjustments: [],
          total: 2500,
        },
      ],
      adjustments: [],
    });
  });

  it("says when it was worked out, and hands back nothing that could be quoted at kobai", async () => {
    // The whole of what makes this an answer rather than an offer. `quotedAt` is the moment;
    // there is no deadline beside it, because a quote that expired would be one that was good
    // until it did — and there is no identifier, because a handle a storefront could present at
    // `POST /store/orders` would be the pending Order ADR-0009 refuses, reached from behind.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const before = Date.now();

    const answered = (await (
      await quote(kobai, cart.apiKey.headers, cart.id)
    ).json()) as Record<string, unknown>;

    expect(Date.parse(answered.quotedAt as string)).toBeGreaterThanOrEqual(before);
    expect(Object.keys(answered).sort()).toEqual([
      "adjustments",
      "cartId",
      "currency",
      "lineItems",
      "quotedAt",
      "total",
      "workflow",
    ]);
  });

  it("names the Steps that worked it out, and stops before the one that claims stock", async () => {
    // The same field, and the same reason, as a resolved price: a Developer who replaced a
    // pricing Step sees theirs here. And the tail of the list is the load-bearing half — a
    // quote that ran `hold-reservations` would have claimed stock for a question.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const answered = (await (
      await quote(kobai, cart.apiKey.headers, cart.id)
    ).json()) as { workflow: { name: string; steps: readonly { step: string }[] } };

    expect(answered.workflow.name).toBe("place-order");
    expect(answered.workflow.steps.map((step) => step.step)).toEqual([
      "load-cart",
      "price-lines",
      "select-shipping",
      "apply-adjustments",
      "calculate-tax",
    ]);
  });

  it("is open to the browser's key, because it claims nothing a public credential could exhaust", async () => {
    // The decision ADR-0055 asks for, and it lands on the other side of the line from holding
    // and placing: this claims no stock and moves no money, and everything it answers is derived
    // from a Cart the browser already holds the identifier for and prices its key already
    // resolves. A checkout page rendering a total is the ordinary caller.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      kind: "publishable",
    });
    const cart = await seedTestCart(kobai, { catalog, apiKey: publishable });

    const response = await quote(kobai, publishable.headers, cart.id);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ total: 1250 });
  });
});

/**
 * The criterion the whole ticket turns on: **the quote and the placement agree**.
 *
 * Asserted against a deployment that replaced *every* pricing Step, because that is the only
 * arrangement where the two could disagree — a quote that priced through Core's own declaration
 * would look right on a stock deployment and be wrong on the first Project that customised
 * anything, which is the bug wearing a route's clothes.
 */
describe("a Project that replaced the pricing Steps", () => {
  /** Everything at double what the Merchant entered. Core has never heard of this rule. */
  const doubled = defineStep("double-the-price", (input: LoadedPrices): ResolvedPrice => {
    const [chosen] = input.prices;
    if (!chosen) throw new StepFailure("price-not-set", "This Variant carries no Price.");
    return {
      variant: input.variant,
      region: input.region,
      channel: input.channel,
      price: { id: chosen.id, amount: chosen.amount * 2, currency: chosen.currency },
    };
  });

  /** A surcharge on the line and a discount on the Cart — both directions, in one Step. */
  const adjust = defineStep(
    "handling-and-a-voucher",
    (input: PricedLines): AdjustedLines => ({
      cart: input.cart,
      lines: input.lines.map((line) => ({
        ...line,
        adjustments: [
          {
            code: "handling",
            description: "Handling",
            amount: 200,
            metadata: { because: "it is fragile" },
          },
        ],
      })),
      adjustments: [{ code: "voucher", description: "Welcome voucher", amount: -500 }],
    }),
  );

  /** A tenth of the adjusted figure, rounded — a real tax Step's shape, at its smallest. */
  const tenPercent = defineStep(
    "ten-percent",
    (input: AdjustedLines): TaxedLines => ({
      cart: input.cart,
      lines: input.lines.map((line) => ({
        ...line,
        tax: Math.round(
          (line.unitAmount * line.quantity +
            line.adjustments.reduce((sum, one) => sum + one.amount, 0)) *
            0.1,
        ),
      })),
      adjustments: input.adjustments.map((adjustment) => ({
        ...adjustment,
        tax: Math.round(adjustment.amount * 0.1),
      })),
    }),
  );

  async function customised() {
    return createTestKobai({
      workflows: {
        "resolve-price": { steps: { "select-price": doubled } },
        "place-order": {
          steps: { "apply-adjustments": adjust, "calculate-tax": tenPercent },
        },
      },
    });
  }

  it("quotes the figure a placement of the same unchanged Cart then charges", async () => {
    await using kobai = await customised();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const quoted = (await (await quote(kobai, cart.apiKey.headers, cart.id)).json()) as {
      total: number;
      currency: string;
      lineItems: readonly {
        sku: string;
        unitAmount: number;
        tax: number;
        total: number;
      }[];
      adjustments: readonly { code: string; amount: number; tax: number }[];
    };
    const placed = (await (await place(kobai, cart.apiKey.headers, cart.id)).json()) as {
      total: number;
      currency: string;
      lineItems: readonly {
        sku: string;
        unitAmount: number;
        tax: number;
        total: number;
      }[];
      adjustments: readonly { code: string; amount: number; tax: number }[];
    };

    // Named rather than only compared, because two derivations of the same wrong number agree
    // just as happily as two of the right one: 2 × 2500 of goods at the Project's doubled price,
    // 200 of handling, 520 of tax on the adjusted line, less a 500 voucher and the 50 of tax
    // that comes off with it.
    expect(quoted.total).toBe(5170);
    expect(quoted.total).toBe(placed.total);
    expect(quoted.currency).toBe(placed.currency);
    // By SKU, never by position: a quote reports the Cart's order and an Order reports SKU
    // order, so a comparison by index would agree by luck on a Cart of one line.
    expect(
      quoted.lineItems.map(({ sku, unitAmount, tax, total }) => ({
        sku,
        unitAmount,
        tax,
        total,
      })),
    ).toEqual(
      placed.lineItems.map(({ sku, unitAmount, tax, total }) => ({
        sku,
        unitAmount,
        tax,
        total,
      })),
    );
    expect(
      quoted.adjustments.map(({ code, amount, tax }) => ({ code, amount, tax })),
    ).toEqual(placed.adjustments.map(({ code, amount, tax }) => ({ code, amount, tax })));
  });

  it("shows the Project its own Steps ran, rather than Core's", async () => {
    await using kobai = await customised();
    const cart = await seedTestCart(kobai);

    const answered = (await (
      await quote(kobai, cart.apiKey.headers, cart.id)
    ).json()) as {
      workflow: { steps: readonly { step: string; implementation: string }[] };
    };

    expect(answered.workflow.steps).toEqual([
      { step: "load-cart", implementation: "load-cart" },
      { step: "price-lines", implementation: "price-lines" },
      { step: "select-shipping", implementation: "select-shipping" },
      { step: "apply-adjustments", implementation: "handling-and-a-voucher" },
      { step: "calculate-tax", implementation: "ten-percent" },
    ]);
  });

  it("carries a Step inserted into the pricing half rather than counting four Steps", async () => {
    // The reason the prefix is expressed as "before the Step that acts" rather than as a count.
    // An inserted Step sits at a position of its own, so a quote that took the first four would
    // stop short of the tax the moment a Project watched a slot.
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          steps: { "calculate-tax": tenPercent },
          after: {
            "price-lines": [
              defineStep(
                "round-up-to-the-nearest-pound",
                (priced: PricedLines): PricedLines => ({
                  cart: priced.cart,
                  lines: priced.lines.map((line) => ({
                    ...line,
                    unitAmount: Math.ceil(line.unitAmount / 100) * 100,
                  })),
                }),
              ),
            ],
          },
        },
      },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    const answered = (await (
      await quote(kobai, cart.apiKey.headers, cart.id)
    ).json()) as {
      total: number;
      workflow: { steps: readonly { step: string }[] };
    };

    expect(answered.workflow.steps.map((step) => step.step)).toEqual([
      "load-cart",
      "price-lines",
      "round-up-to-the-nearest-pound",
      "select-shipping",
      "apply-adjustments",
      "calculate-tax",
    ]);
    // 1300 rounded up, plus 130 of tax — so the inserted Step ran *and* the tax Step after it
    // did, which is the half a count would have dropped.
    expect(answered.total).toBe(1430);
  });
});

describe("what a quote leaves behind", () => {
  it("holds no stock, so the units are still on the shelf afterwards", async () => {
    // The reason this is not the total ADR-0009 refuses *and* the reason it is not a hold: a
    // quote claims nothing, so `POST /store/carts/{id}/reservations` is still the route that
    // stops a Cart being oversold while a Shopper is at their bank (ADR-0070).
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
      method: "PUT",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ onHand: 3 }),
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    await quote(kobai, cart.apiKey.headers, cart.id);

    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 0,
      available: 3,
    });
  });

  it("charges nothing and writes no Order, however often it is asked", async () => {
    // Ask the provider what it is holding, never whether a callback was reached. A quote that
    // had reached `take-payment` would have taken money for a question — and the Cart would be
    // spent, which is the one thing a storefront about to send a Shopper to their bank cannot
    // recover from.
    const charges: number[] = [];
    await using kobai = await createTestKobai({
      payments: {
        provider: {
          name: "counting",
          charge: async (request) => {
            charges.push(request.amount);
            return { ok: true, reference: `ref-${charges.length}` };
          },
          refund: async () => {},
        },
      },
    });
    const cart = await seedTestCart(kobai);

    await quote(kobai, cart.apiKey.headers, cart.id);
    await quote(kobai, cart.apiKey.headers, cart.id);

    expect(charges).toEqual([]);
    const read = (await (
      await kobai.request(`/store/carts/${cart.id}`, { headers: cart.apiKey.headers })
    ).json()) as { placed: boolean };
    expect(read.placed).toBe(false);
    // And the Cart is still placeable afterwards, which is the fact a storefront depends on.
    expect((await place(kobai, cart.apiKey.headers, cart.id)).status).toBe(201);
    expect(charges).toEqual([1250]);
  });
});

describe("a quote refused", () => {
  it("answers 404 for a Cart that is not there", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await quote(
      kobai,
      cart.apiKey.headers,
      "00000000-0000-4000-8000-000000000000",
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-not-found" });
  });

  it("answers 422 for a Cart with nothing in it", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { lines: [] });

    const response = await quote(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "cart-empty",
      workflow: { failed: "load-cart" },
    });
  });

  it("answers 409 for a Cart that has already been placed", async () => {
    // The same word at the same status as reading, holding and placing answer it with — which
    // is the property that makes `reason` the thing a storefront branches on.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    await place(kobai, cart.apiKey.headers, cart.id);

    const response = await quote(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-placed" });
  });

  it("answers 422 for a line whose Variant has since lost its Price", async () => {
    // A Cart may only take a line for a Variant that is priced, so this is reached the one way
    // it is reachable: a Merchant deletes the Price afterwards. It is `resolve-price`'s refusal
    // travelling out of `price-lines` as itself, which is what makes a Plugin's pricing Step
    // able to refuse a quote in its own words too. 422 rather than the price route's 404,
    // because the path here names the **Cart**, and the Cart is still there.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });
    const price = catalog.variants[0]?.prices[0];
    if (price === undefined) throw new Error("the seeded Variant should carry a Price");
    const removed = await kobai.request(
      `/admin/variants/${catalog.variantId}/prices/${price.id}`,
      { method: "DELETE", headers: catalog.merchant.headers },
    );
    expect(removed.status).toBe(204);

    const response = await quote(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "price-not-set",
      workflow: { name: "place-order", failed: "price-lines" },
    });
  });

  it("answers 422 in a Step's own words when a Project's Step declines", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          before: {
            "apply-adjustments": [
              defineStep("no-quotes-today", (_shipped: ShippedLines): ShippedLines => {
                throw new StepFailure("closed-for-stocktake", "Ask again tomorrow.");
              }),
            ],
          },
        },
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await quote(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "closed-for-stocktake",
      error: "Ask again tomorrow.",
      workflow: { failed: "no-quotes-today" },
    });
  });
});

describe("the open context a quote runs with", () => {
  /** A Step that surcharges by whatever the caller asked for, spelled either way (ADR-0013). */
  const leadTime = defineStep(
    "lead-time-surcharge",
    (input: PricedLines, context): AdjustedLines => {
      const asked = context.metadata.leadTimeDays;
      const days = typeof asked === "number" ? asked : Number(asked);
      return {
        cart: input.cart,
        lines: input.lines.map((line) => ({ ...line, adjustments: [] })),
        adjustments: Number.isFinite(days)
          ? [{ code: "lead-time", description: "Sooner", amount: days * 100 }]
          : [],
      };
    },
  );

  async function boot() {
    return createTestKobai({
      workflows: { "place-order": { steps: { "apply-adjustments": leadTime } } },
    });
  }

  it("reads it from the query string and from the body alike", async () => {
    // Both halves, because the placement takes both (#138) — a quote that could only be asked
    // one way would answer a different question from the one that gets charged for any Project
    // whose Step reads a key the storefront sends the other way.
    await using kobai = await boot();
    const cart = await seedTestCart(kobai);

    const fromQuery = await kobai.request(
      `/store/carts/${cart.id}/quote?leadTimeDays=3`,
      { method: "POST", headers: cart.apiKey.headers },
    );
    const fromBody = await quote(kobai, cart.apiKey.headers, cart.id, {
      metadata: { leadTimeDays: 3 },
    });

    await expect(fromQuery.json()).resolves.toMatchObject({ total: 1550 });
    await expect(fromBody.json()).resolves.toMatchObject({ total: 1550 });
  });

  it("refuses a key that arrived in both, rather than choosing one", async () => {
    await using kobai = await boot();
    const cart = await seedTestCart(kobai);

    const response = await kobai.request(`/store/carts/${cart.id}/quote?leadTimeDays=3`, {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { leadTimeDays: 5 } }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "metadata-in-both" });
  });
});
