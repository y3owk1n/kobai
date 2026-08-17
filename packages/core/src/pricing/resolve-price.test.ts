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

describe("a Project that inserts a Step without replacing one", () => {
  /** Watches what `select-price` produced and hands it straight back. */
  const watching = defineStep(
    "watching-the-price",
    (resolved: ResolvedPrice): ResolvedPrice => resolved,
  );

  it("runs the inserted Step and leaves the answer as it was", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { after: { "select-price": [watching] } } },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      // The Merchant's Price, untouched. Observation is not ownership: an inserted Step
      // cannot alter the output contract, so nothing it does can change the price served.
      price: { amount: 1250, currency: "USD" },
      workflow: {
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "select-price" },
          { step: "watching-the-price", implementation: "watching-the-price" },
        ],
      },
    });
  });

  it("runs one before and one after the same Step, and Core's Step still runs", async () => {
    await using kobai = await createTestKobai({
      workflows: {
        "resolve-price": {
          before: {
            "select-price": [
              defineStep("watching-the-candidates", (loaded: LoadedPrices) => loaded),
            ],
          },
          after: { "select-price": [watching] },
        },
      },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      price: { amount: 1250 },
      workflow: {
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "watching-the-candidates", implementation: "watching-the-candidates" },
          { step: "select-price", implementation: "select-price" },
          { step: "watching-the-price", implementation: "watching-the-price" },
        ],
      },
    });
  });
});

/**
 * ADR-0013, at the seam it was written for.
 *
 * Lead-time pricing is the case that ADR names, and Core does not know what a lead time is.
 * A storefront sends one anyway — as a query parameter on a Core route that models nothing in
 * the query string — and a Project's Step reads it out of the Workflow's open context. No
 * route changed, no Core type learned a field, and nothing in Core reads the key: `metadata`
 * is written at the edge and read only by whoever put a Step there.
 */
describe("a Step reading an input Core does not model", () => {
  /** A surcharge for wanting it sooner. Core has never heard of any of this. */
  const leadTimeSurcharge = defineStep(
    "surcharge-by-lead-time",
    (input: LoadedPrices, context): ResolvedPrice => {
      const [chosen] = input.prices;
      if (!chosen)
        throw new StepFailure("price-not-set", "This Variant carries no Price.");

      // Whatever arrived under this key, in whatever shape. Core never parsed it, because
      // parsing implies a shape and this is not Core's field to have an opinion about.
      const days = Number(context.metadata.leadTimeDays ?? 0);
      const surcharge = Number.isFinite(days) ? Math.max(0, days) * 100 : 0;

      return {
        variant: input.variant,
        price: {
          id: chosen.id,
          amount: chosen.amount + surcharge,
          currency: chosen.currency,
        },
      };
    },
  );

  it("prices a rush order from a parameter no Core route declares", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": leadTimeSurcharge } } },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(
      `/store/variants/${store.variantId}/price?leadTimeDays=3`,
      { headers: store.headers },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      price: { amount: 1550, currency: "USD" },
    });
  });

  it("prices the same Variant without one at the Merchant's Price", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": leadTimeSurcharge } } },
    });
    const store = await priced(kobai, 1250);

    const response = await kobai.request(`/store/variants/${store.variantId}/price`, {
      headers: store.headers,
    });

    await expect(response.json()).resolves.toMatchObject({
      price: { amount: 1250, currency: "USD" },
    });
  });

  it("ignores the parameter entirely for a deployment with no Step that reads it", async () => {
    // The other half of "Core requires no knowledge of its shape": stock kobai is handed the
    // same request and does nothing with it, because nothing in Core reads a key out of the
    // open half of a context.
    await using kobai = await createTestKobai();
    const store = await priced(kobai, 1250);

    const response = await kobai.request(
      `/store/variants/${store.variantId}/price?leadTimeDays=3`,
      { headers: store.headers },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ price: { amount: 1250 } });
  });
});
