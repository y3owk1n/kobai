import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  signInTestMerchant,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import type { LoadedPrices, ResolvedPrice } from "./resolve-price.ts";

/**
 * Replacing a Step, through the seam a Developer actually experiences it at.
 *
 * The promise ADR-0003 calls kobai's flagship is not "a Workflow object can be rewired" — it
 * is "I changed one line of my Project's config and the API answers differently". So these
 * boot the application with a config that swaps a Step and ask the store surface for a price,
 * exactly as `reference/kobai.config.ts` does with a real one.
 *
 * Nothing here is Core knowing about a particular override. Core is handed a Step it has
 * never seen, runs it in the slot it was given, and reports what filled that slot.
 */

/** A Step that ignores every Price a Merchant entered and charges the same for everything. */
const flatRate = defineStep(
  "flat-rate",
  (input: LoadedPrices): ResolvedPrice => ({
    variant: input.variant,
    price: { id: "flat-rate", amount: 4200, currency: "XTS" },
  }),
);

type Priced = {
  readonly variantId: string;
  /** A key's headers, ready to ask the store surface with. */
  readonly headers: Record<string, string>;
};

/** A Store holding one Variant at one Price, created entirely through the public API. */
async function priced(instance: TestKobai, amount: number): Promise<Priced> {
  const merchant = await signInTestMerchant(instance);
  const json = { ...merchant.headers, "content-type": "application/json" };

  const product = (await (
    await instance.request("/admin/products", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "A poster", variants: [{ sku: "POSTER-A2" }] }),
    })
  ).json()) as { variants: { id: string }[] };
  const variantId = product.variants[0]?.id ?? "";

  await instance.request(`/admin/variants/${variantId}/prices`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ amount }),
  });

  const key = await createTestApiKey(instance, merchant, { name: "storefront" });

  return { variantId, headers: key.headers };
}

describe("a Project that replaces a Step in the price-resolution Workflow", () => {
  it("serves the replacement's price instead of the Price the Merchant entered", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": flatRate } } },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      // Not the 1250 that is in the database. The Merchant's Price row is untouched; the
      // rule that reads it is the Project's now.
      price: { id: "flat-rate", amount: 4200, currency: "XTS" },
    });
  });

  it("reports the replacement in the slot the original filled", async () => {
    // `step` is the slot and `implementation` is what filled it, and this is the first time
    // they differ. It is what lets a Developer see in the response that *their* Step ran
    // (spec story 33) rather than take it on trust.
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": flatRate } } },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      workflow: {
        name: "resolve-price",
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "flat-rate" },
        ],
      },
    });
  });

  it("leaves the Steps it did not name alone", async () => {
    // `load-prices` still loads, which is the point of replacing one Step rather than the
    // Workflow: the replacement inherits everything it did not ask to own.
    await using kobai = await createTestKobai({
      workflows: {
        "resolve-price": {
          steps: {
            "select-price": defineStep(
              "reads-what-load-prices-loaded",
              (input: LoadedPrices): ResolvedPrice => ({
                variant: input.variant,
                price: {
                  id: String(input.prices.length),
                  amount: input.prices[0]?.amount ?? 0,
                  currency: "USD",
                },
              }),
            ),
          },
        },
      },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      price: { id: "1", amount: 1250 },
    });
  });

  it("changes nothing for a deployment that overrides nothing", async () => {
    // The override belongs to the Project that declared it and to no other instance —
    // including one booted in the same process a moment later.
    await using kobai = await createTestKobai();
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      price: { amount: 1250, currency: "USD" },
      workflow: {
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "select-price" },
        ],
      },
    });
  });

  it("lets a replacement refuse in a way Core has never heard of", async () => {
    // Core maps its own refusals to statuses and answers 422 for anything else. A Project's
    // Step is free to refuse for its own reasons, and does not have to teach Core what they
    // mean.
    await using kobai = await createTestKobai({
      workflows: {
        "resolve-price": {
          steps: {
            "select-price": defineStep(
              "closed-on-sundays",
              (_input: LoadedPrices): ResolvedPrice => {
                throw new StepFailure(
                  "closed-on-sundays",
                  "This Store does not quote prices on a Sunday.",
                );
              },
            ),
          },
        },
      },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "closed-on-sundays",
      workflow: { failed: "select-price", steps: [{ step: "load-prices" }] },
    });
  });
});
