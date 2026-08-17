import { describe, expect, it } from "vitest";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import { type LoadedCart, type PricedLines, placeOrderWorkflow } from "./place-order.ts";

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
      steps: [{ slot: "load-cart" }, { slot: "price-lines" }, { slot: "capture-order" }],
    });
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
              defineStep(
                "no-orders-over-a-tenner",
                (_priced: PricedLines): PricedLines => {
                  throw new StepFailure(
                    "over-the-limit",
                    "This Store does not take an Order for more than a tenner.",
                  );
                },
              ),
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
        steps: [{ step: "load-cart" }, { step: "price-lines" }],
      },
    });
    // And nothing was captured: the refusal came before the point of no return, which is where
    // everything that can fail belongs.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });
});
