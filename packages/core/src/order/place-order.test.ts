import { describe, expect, it } from "vitest";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import {
  type AdjustedLines,
  type LoadedCart,
  type PricedLines,
  placeOrderWorkflow,
  type TaxedLines,
} from "./place-order.ts";

/**
 * `place-order` as a **declaration**, and as the thing a Project rewires.
 *
 * Two kinds of assertion, and both are about promises no response body can carry. The
 * declaration is read directly, because a declared Workflow is one of ADR-0003's five Extension
 * Points and `describe()` naming its Steps in order is the interface. What an override *does*
 * is asserted through the running application, by booting with the same `kobai.config.ts` shape
 * a Developer writes — because "I changed one line of my config and the API answers
 * differently" is the promise, not "a Workflow object can be rewired".
 */

async function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

describe("the declaration", () => {
  it("names its Steps in order, without opening Core", async () => {
    expect(placeOrderWorkflow.describe()).toEqual({
      name: "place-order",
      steps: [
        { slot: "load-cart" },
        { slot: "price-lines" },
        { slot: "apply-adjustments" },
        { slot: "calculate-tax" },
        { slot: "capture-order" },
      ],
    });
  });

  /**
   * Adjustments are applied before tax is calculated, and that is arithmetic rather than taste.
   *
   * ADR-0022 says an Adjustment changes what "line total" means in every Order snapshot, **tax
   * base** and refund — so a discount that arrived after tax had been worked out would leave the
   * Order taxed on a figure nobody was charged. The slot order is the only place that fact is
   * written down in a form the runner obeys.
   */
  it("adjusts a line before it taxes it, because tax is charged on the adjusted figure", () => {
    const slots = placeOrderWorkflow.steps.map((step) => step.slot);

    expect(slots.indexOf("apply-adjustments")).toBeLessThan(
      slots.indexOf("calculate-tax"),
    );
  });

  /**
   * ADR-0009's point of no return, as a property of the declaration.
   *
   * An Order is never edited, so no compensation could undo the Order write — which makes the
   * Order write the last thing that can fail. Two halves, and both have to hold: `capture-order`
   * is last, and it declares no compensation. A later slot, or a compensation here, would be a
   * promise to undo something that cannot be undone.
   *
   * The Steps that arrive later — holding Reservations, taking Payment — go *before* this one,
   * and this is what fails if one is appended after it instead.
   */
  it("ends at the Step nothing can undo, and offers no way to undo it", () => {
    const last = placeOrderWorkflow.steps.at(-1);

    expect(last?.slot).toBe("capture-order");
    expect(last?.step.compensate).toBeUndefined();
  });
});

/**
 * A Step invoking another Workflow, at the seam ADR-0054 was written for.
 *
 * `price-lines` runs `resolve-price`, so the rule a storefront is quoted by is the rule the
 * Order is charged by. The Project below wires one Step, in one place, and it applies to a
 * route it never mentioned — which is the whole promise, and the thing that fails if the store
 * surface stops passing the deployment's registry into the context (#113).
 */
describe("a Project that replaced the pricing Step", () => {
  /** Everything at double what the Merchant entered. Core has never heard of this rule. */
  const doubled = defineStep("double-the-price", (input: LoadedPrices): ResolvedPrice => {
    const [chosen] = input.prices;
    if (!chosen) throw new StepFailure("price-not-set", "This Variant carries no Price.");
    return {
      variant: input.variant,
      price: {
        id: chosen.id,
        amount: chosen.amount * 2,
        currency: chosen.currency,
      },
    };
  });

  it("charges its own prices at Capture, having wired nothing twice", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": doubled } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      // 2500 would be the Merchant's Price, which is still the row in the database. The rule
      // that reads it is the Project's, and it applies here because `price-lines` resolves the
      // deployment's `resolve-price` rather than Core's.
      total: 5000,
      lineItems: [{ unitAmount: 2500, quantity: 2, total: 5000 }],
    });
  });

  it("quotes the same price the storefront was shown", async () => {
    // The two halves of story 45 in one test: the price a storefront reads and the price an
    // Order is charged come from the same declaration, so they cannot drift apart.
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": doubled } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    const quoted = (await (
      await kobai.request(`/store/variants/${catalog.variantId}/price`, {
        headers: catalog.apiKey.headers,
      })
    ).json()) as { price: { amount: number } };
    const placed = (await (await place(kobai, cart.apiKey.headers, cart.id)).json()) as {
      lineItems: readonly { unitAmount: number }[];
    };

    expect(placed.lineItems[0]?.unitAmount).toBe(quoted.price.amount);
  });

  it("leaves a deployment that overrode nothing charging the Merchant's Price", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      total: 1250,
      lineItems: [{ unitAmount: 1250 }],
    });
  });
});

describe("a Project that replaced a Step of place-order itself", () => {
  it("reports the replacement in the slot the original filled", async () => {
    // `step` is the slot and `implementation` is what filled it. This is what lets a Developer
    // see in the response that *their* Step ran rather than take it on trust.
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          steps: {
            "price-lines": defineStep(
              "everything-is-a-penny",
              (input: LoadedCart): PricedLines => ({
                cart: input.cart,
                lines: input.lines.map((line) => ({
                  ...line,
                  unitAmount: 1,
                  currency: "USD",
                })),
              }),
            ),
          },
        },
      },
    });
    const cart = await seedTestCart(kobai, { quantity: 3 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      total: 3,
      workflow: {
        name: "place-order",
        steps: [
          { step: "load-cart", implementation: "load-cart" },
          { step: "price-lines", implementation: "everything-is-a-penny" },
          { step: "apply-adjustments", implementation: "apply-adjustments" },
          { step: "calculate-tax", implementation: "calculate-tax" },
          { step: "capture-order", implementation: "capture-order" },
        ],
      },
    });
  });

  it("lets a Step of its own decline a purchase in a way Core has never heard of", async () => {
    // Core maps its own refusals to statuses and answers 422 for anything else, so a Project's
    // rule can decline a purchase without teaching Core what its reason means.
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          before: {
            "capture-order": [
              defineStep("no-orders-over-a-tenner", (_taxed: TaxedLines): TaxedLines => {
                throw new StepFailure(
                  "over-the-limit",
                  "This Store does not take an Order for more than a tenner.",
                );
              }),
            ],
          },
        },
      },
    });
    const cart = await seedTestCart(kobai, { quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "over-the-limit",
      workflow: {
        name: "place-order",
        failed: "no-orders-over-a-tenner",
        steps: [
          { step: "load-cart" },
          { step: "price-lines" },
          { step: "apply-adjustments" },
          { step: "calculate-tax" },
        ],
      },
    });
    // And nothing was captured: the refusal came before the point of no return, which is where
    // everything that can fail belongs.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });
});

/**
 * Adjustments — a discount or a surcharge, held as **its own line** (ADR-0022).
 *
 * Core attaches none of its own, so every test here boots with the Step that would: that is what
 * a Plugin does, and it is the only way to see the mechanism at all. The assertions are about
 * two things and no others — that the Adjustment survives Capture as a line rather than being
 * folded into an amount, and that the total is the figure that was charged.
 */
describe("Adjustments on an Order", () => {
  /**
   * A surcharge on the line and a discount on the Order — both directions, in one Step.
   *
   * Nothing about it is Core's: the codes are the Step's own, and the negative amount is the
   * whole of what makes one a discount.
   */
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

  /** One Variant at 1250, `quantity` of it, placed — the arrangement all three tests want. */
  async function placeAdjusted(kobai: TestKobai, quantity: number) {
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity });
    return { catalog, response: await place(kobai, cart.apiKey.headers, cart.id) };
  }

  it("reports each one as a line rather than folding it into an amount", async () => {
    await using kobai = await createTestKobai({
      workflows: { "place-order": { steps: { "apply-adjustments": adjust } } },
    });

    const { response } = await placeAdjusted(kobai, 2);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      // The Order-level Adjustment, which belongs to no single line.
      adjustments: [
        {
          id: expect.any(String),
          code: "voucher",
          description: "Welcome voucher",
          amount: -500,
          metadata: {},
        },
      ],
      lineItems: [
        {
          // Untouched, which is the point: what a Variant cost is still what a Variant cost.
          unitAmount: 1250,
          quantity: 2,
          adjustments: [
            {
              id: expect.any(String),
              code: "handling",
              description: "Handling",
              amount: 200,
              metadata: { because: "it is fragile" },
            },
          ],
        },
      ],
    });
  });

  it("charges a total that accounts for every one of them", async () => {
    await using kobai = await createTestKobai({
      workflows: { "place-order": { steps: { "apply-adjustments": adjust } } },
    });

    const { response } = await placeAdjusted(kobai, 2);
    const order = (await response.json()) as {
      total: number;
      lineItems: readonly { total: number }[];
    };

    // 1250 × 2, plus 200 of handling on the line, less the 500 voucher on the Order.
    expect(order.lineItems[0]?.total).toBe(2700);
    expect(order.total).toBe(2200);
  });

  it("reads the same Adjustments back after Capture, because they are rows", async () => {
    // The half a single response cannot show. An Adjustment that was only ever a number in a
    // sum would be gone by the time a Merchant answered a Shopper's question about it.
    await using kobai = await createTestKobai({
      workflows: { "place-order": { steps: { "apply-adjustments": adjust } } },
    });

    const { catalog, response } = await placeAdjusted(kobai, 1);
    const order = (await response.json()) as { id: string; workflow: unknown };

    const read = await kobai.request(`/store/orders/${order.id}`, {
      headers: catalog.apiKey.headers,
    });

    expect(read.status).toBe(200);
    const { workflow: _ran, ...record } = order;
    await expect(read.json()).resolves.toEqual(record);
  });

  it("leaves a deployment that adjusts nothing reporting no Adjustments at all", async () => {
    // Core's own Step, unreplaced: the slot is there and adds nothing, so an Order nobody
    // adjusted says so with an empty list rather than an absent field.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      adjustments: [],
      lineItems: [{ adjustments: [] }],
    });
  });
});

/**
 * `calculate-tax`, and the fact that it returns zero.
 *
 * The zero is the deliverable: ADR-0009 has the snapshot carry the tax as at Capture, so the
 * figure exists from the first Order and adding a real tax rule later is a Step replacement
 * rather than a change to what an Order means. Both halves are asserted — that Core charges
 * none, and that a Project replacing the slot is what charges some.
 */
describe("the tax Step", () => {
  it("charges none, and says so on the snapshot", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      total: 2500,
      lineItems: [{ tax: 0, total: 2500 }],
    });
  });

  it("is replaceable, and a Project's own rule is what the Order is charged", async () => {
    // Ten per cent, made up. Core has no jurisdiction and never will, which is the whole
    // reason this is a slot rather than a tax table.
    const tenPerCent = defineStep(
      "ten-per-cent",
      (input: AdjustedLines): TaxedLines => ({
        cart: input.cart,
        lines: input.lines.map((line) => ({
          ...line,
          tax: Math.round(line.unitAmount * line.quantity * 0.1),
        })),
        adjustments: input.adjustments,
      }),
    );
    await using kobai = await createTestKobai({
      workflows: { "place-order": { steps: { "calculate-tax": tenPerCent } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      // 2500 of goods and 250 of tax, and the total is what was charged for both.
      total: 2750,
      lineItems: [{ tax: 250, total: 2750 }],
      workflow: {
        steps: [
          { step: "load-cart", implementation: "load-cart" },
          { step: "price-lines", implementation: "price-lines" },
          { step: "apply-adjustments", implementation: "apply-adjustments" },
          { step: "calculate-tax", implementation: "ten-per-cent" },
          { step: "capture-order", implementation: "capture-order" },
        ],
      },
    });
  });

  it("taxes the adjusted figure, which is why it runs after the Adjustments", async () => {
    // The slot order, observed through the API rather than read off the declaration. A rule
    // that taxed the unadjusted line would charge tax on money the Shopper did not spend.
    const halfOff = defineStep(
      "half-off",
      (input: PricedLines): AdjustedLines => ({
        cart: input.cart,
        lines: input.lines.map((line) => ({
          ...line,
          adjustments: [
            {
              code: "half-off",
              description: "Half off",
              amount: -(line.unitAmount * line.quantity) / 2,
            },
          ],
        })),
        adjustments: [],
      }),
    );
    /** Ten per cent of whatever the line actually came to, Adjustments included. */
    const onWhatWasCharged = defineStep(
      "ten-per-cent-of-the-adjusted-line",
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
        adjustments: input.adjustments,
      }),
    );
    await using kobai = await createTestKobai({
      workflows: {
        "place-order": {
          steps: { "apply-adjustments": halfOff, "calculate-tax": onWhatWasCharged },
        },
      },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      // 2500 of goods, halved to 1250, taxed at 125 — and not the 250 an unadjusted base
      // would have produced.
      lineItems: [{ tax: 125, total: 1375 }],
      total: 1375,
    });
  });
});
