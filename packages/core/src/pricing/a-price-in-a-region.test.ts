import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import type { LoadedPrices, ResolvedPrice } from "./resolve-price.ts";

/**
 * **Asking what something costs *somewhere*** — `?region=`, the fallback, and the currency rule
 * (#292, ADR-0074).
 *
 * A storefront names a Region and is answered in that Region's currency, or is not answered at
 * all: kobai converts nothing, ever, so a Variant with no Price denominated in what the Region
 * prices in has no price there. That is one rule with an order — **the currency first, and best
 * match inside it** — and the case worth reading twice is the one where an unconstrained Price
 * exists and still does not win.
 *
 * `best-match.test.ts` is the grid; this file is the route: what the parameter means, what its
 * absence means, what an unknown value means, and that a Project's own Step is handed the same
 * Region.
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
async function enableMyr(kobai: TestKobai, catalog: TestCatalog): Promise<void> {
  const response = await kobai.request("/admin/store", {
    method: "PATCH",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ currencies: [{ code: "USD" }, { code: "MYR" }] }),
  });
  expect(response.status, "enabling MYR").toBe(200);
}

/** One Price on a Variant, however it is constrained. */
async function setPrice(
  kobai: TestKobai,
  catalog: TestCatalog,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await kobai.request(`/admin/variants/${catalog.variantId}/prices`, {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, `pricing ${JSON.stringify(body)}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("GET /store/variants/{id}/price?region=", () => {
  it("answers the Price set for the Region that was named", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const named = await createRegion(kobai, catalog, "The Midwest", "USD");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 1900, regionId: named });

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${named}`,
      { headers: catalog.apiKey.headers },
    );

    expect(response.status).toBe(200);
    // The answer says which market it is for as well as what the number is — which is the only
    // way a storefront that sent nothing could tell what it was answered about.
    await expect(response.json()).resolves.toMatchObject({
      region: { id: named, name: "The Midwest", currency: "USD" },
      channel: null,
      price: { amount: 1900, currency: "USD" },
    });
  });

  it("answers for the Store's default Region when the parameter is absent", async () => {
    // **The clause that keeps this additive** (ADR-0060): a storefront written before this
    // parameter existed sends nothing and is answered exactly as it was. The two requests below
    // are the same question asked two ways, and they answer the same amount.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const elsewhere = await createRegion(kobai, catalog, "Elsewhere", "USD");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 1900, regionId: elsewhere });

    const sending = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });

    expect(sending.status).toBe(200);
    const body = (await sending.json()) as {
      region: { id: string; name: string };
      price: { amount: number };
    };
    // The Region a boot seeded, named from the currency this Store prices in — and the
    // unconstrained Price, because the one for Elsewhere applies to Elsewhere.
    expect(body.region.name).toBe("USD");
    expect(body.price.amount).toBe(1250);

    const naming = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${body.region.id}`,
      { headers: catalog.apiKey.headers },
    );
    await expect(naming.json()).resolves.toEqual(body);
  });

  it("refuses a Region this Store has not got rather than answering for the default", async () => {
    // Story 15: a storefront interpolating the wrong variable into its URL finds out. Silently
    // falling back would hand it a plausible number in a currency it did not ask about, which
    // is the failure that looks like success.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=2f1b8a5e-0000-4000-8000-000000000000`,
      { headers: catalog.apiKey.headers },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses a `region` that is not an identifier at all with the same word", async () => {
    // `IdParam`'s judgement one parameter along: an identifier nothing carries and a string
    // that could never be one are the same answer to the caller, so they get the same one.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=malaysia`,
      { headers: catalog.apiKey.headers },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("is not part of the open context a Step reads, because the route models it", async () => {
    // ADR-0013's openness runs on everything Core has *not* claimed, so a parameter a route
    // reads has to leave the open half — or the openness would quietly become a schema and a
    // Project's Step would find a key it never sent (`workflow/context.ts`).
    const reportsTheContext = defineStep(
      "reports-the-context",
      (_input: LoadedPrices, context): ResolvedPrice => {
        // Refused rather than priced, because what this case is about is a set of **names** and
        // a resolved price has nowhere to put one — a count in the amount would pass just as
        // happily against a context carrying `region` and nothing else.
        throw new StepFailure(
          "the-open-context",
          Object.keys(context.metadata).sort().join(" "),
        );
      },
    );
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": reportsTheContext } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const region = await createRegion(kobai, catalog, "The Midwest", "USD");

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${region}&leadTimeDays=3`,
      { headers: catalog.apiKey.headers },
    );

    // One key, and it is the lead time by name: `region` is Core's now and `leadTimeDays` is
    // still nobody's, which is exactly the division the open context rests on.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "the-open-context",
      error: "leadTimeDays",
    });
  });
});

describe("a Region that prices in another currency", () => {
  it("has no price where the Variant carries none in that currency, whatever else it carries", async () => {
    // **Best match never beats the currency rule**, which is the order the two rules are asked
    // in. An unconstrained Price is the fallback *within* a currency: it applies in every
    // Region that prices in what it is denominated in, and in none of the others. Converting
    // it would be kobai inventing a rate it has no source for (ADR-0074).
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enableMyr(kobai, catalog);
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${malaysia}`,
      { headers: catalog.apiKey.headers },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "price-not-set" });
    // And the same Variant is priced in the Store's own Region, so this is the currency rule
    // rather than a Variant nobody has priced.
    const athome = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    await expect(athome.json()).resolves.toMatchObject({ price: { amount: 1250 } });
  });

  it("answers in its own currency once a Price is set in it", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enableMyr(kobai, catalog);
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 5900, currency: "MYR" });

    const response = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${malaysia}`,
      { headers: catalog.apiKey.headers },
    );

    expect(response.status).toBe(200);
    // Unconstrained and in ringgit: the currency is what makes it apply here, and no Region
    // had to be named on the Price at all — which is what a Store selling one catalog into two
    // currencies actually writes.
    await expect(response.json()).resolves.toMatchObject({
      region: { name: "Malaysia", currency: "MYR" },
      price: { amount: 5900, currency: "MYR" },
    });
  });
});

describe("the Channel a Price is resolved against", () => {
  it("comes from the API key, and a key bound to none is answered the fallback", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const marketplace = await kobai.request("/admin/channels", {
      method: "POST",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Marketplace" }),
    });
    const channelId = ((await marketplace.json()) as { id: string }).id;
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 1450, channelId });

    const listing = await createTestApiKey(kobai, catalog.merchant, {
      name: "the marketplace listing",
      channelId,
    });

    // Nothing about the request says which Channel it is in: the credential does, which is what
    // spares a storefront threading one through every call and stops it claiming one it was not
    // issued for (ADR-0020).
    const throughTheMarketplace = await kobai.request(
      `/store/variants/${catalog.variantId}/price`,
      { headers: listing.headers },
    );
    await expect(throughTheMarketplace.json()).resolves.toMatchObject({
      channel: { id: channelId, name: "Marketplace" },
      price: { amount: 1450 },
    });

    // The catalog's own key names no Channel — every key that existed before Channels did — and
    // is answered the unconstrained Price rather than refused.
    const ownStorefront = await kobai.request(
      `/store/variants/${catalog.variantId}/price`,
      { headers: catalog.apiKey.headers },
    );
    await expect(ownStorefront.json()).resolves.toMatchObject({
      channel: null,
      price: { amount: 1250 },
    });
  });
});

describe("GET /admin/variants/{id}/price?region=", () => {
  it("takes the Region the same way, so a Merchant previews what each market is charged", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enableMyr(kobai, catalog);
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 5900, currency: "MYR", regionId: malaysia });

    const preview = await kobai.request(
      `/admin/variants/${catalog.variantId}/price?region=${malaysia}`,
      { headers: catalog.merchant.headers },
    );

    expect(preview.status).toBe(200);
    // Read once and asserted twice, because a `Response` body may only be consumed once.
    const previewed = await preview.text();
    expect(JSON.parse(previewed)).toMatchObject({
      region: { id: malaysia, currency: "MYR" },
      // Always `null` here: a Channel is decided by an API key and this route is opened by a
      // session, so there is no credential to read one off.
      channel: null,
      price: { amount: 5900, currency: "MYR" },
    });

    // Byte for byte what the storefront is told, which is the property that makes a preview
    // worth having — `catalog/a-draft-product-is-not-buyable.test.ts` holds the same pair for a
    // request that names no Region.
    const storefront = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${malaysia}`,
      { headers: catalog.apiKey.headers },
    );
    await expect(storefront.text()).resolves.toEqual(previewed);
  });

  it("refuses a Region this Store has not got, exactly as the store surface does", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const response = await kobai.request(
      `/admin/variants/${catalog.variantId}/price?region=2f1b8a5e-0000-4000-8000-000000000000`,
      { headers: catalog.merchant.headers },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});

describe("deleting the Region a Price applies to", () => {
  it("takes that Price with it and leaves every other one alone", async () => {
    // **The one place `core_price` departs from ADR-0059's refuse-rather-than-cascade**, and
    // the argument is the test ADR-0059 actually applies: the repair a refusal would demand —
    // find and delete the Prices for this Region — is the very deletion this performs, one row
    // at a time and with no route that does it in bulk. #292 argued it on nothing listing those
    // rows; `GET /admin/prices?region=` lists them since #310, which is why the argument was
    // restated rather than left standing — see `catalog/the-prices-entered-for-a-market.test.ts`, where
    // reading them before the deletion is what this case's other half asserts. `set null` is
    // still the worse third answer, since a Price entered for one market would silently become
    // the fallback for every market.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const midwest = await createRegion(kobai, catalog, "The Midwest", "USD");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 1900, regionId: midwest });

    const deleted = await kobai.request(`/admin/regions/${midwest}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });

    expect(deleted.status).toBe(204);
    const detail = (await (
      await kobai.request(`/admin/products/${catalog.productId}`, {
        headers: catalog.merchant.headers,
      })
    ).json()) as { variants: { prices: { amount: number }[] }[] };
    // The unconstrained Price is untouched, so this is the constraint being deleted rather than
    // the Variant being emptied — and the storefront is answered from it as it was before the
    // Region existed at all.
    expect(detail.variants[0]?.prices.map((one) => one.amount)).toEqual([1250]);
    const response = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    await expect(response.json()).resolves.toMatchObject({ price: { amount: 1250 } });
  });
});

describe("a Project whose own Step prices on the Region", () => {
  /**
   * A rule Core has never heard of, reading the Region it was handed.
   *
   * This is the half of the promise that no assertion about a declaration can carry: that
   * `select-price` *receives* the Region is a fact about the Workflow's types, held in
   * `workflow.test.ts`; what a Project **does** with it is a fact about a running deployment,
   * and it is asserted here by booting one.
   */
  const halfPriceInMalaysia = defineStep(
    "half-price-in-malaysia",
    (input: LoadedPrices): ResolvedPrice => {
      const chosen = input.prices.find((one) => one.currency === input.region.currency);
      if (!chosen) throw new StepFailure("price-not-set", "Nothing priced here.");

      return {
        variant: input.variant,
        region: input.region,
        channel: input.channel,
        price: {
          id: chosen.id,
          amount: input.region.name === "Malaysia" ? chosen.amount / 2 : chosen.amount,
          currency: chosen.currency,
        },
      };
    },
  );

  it("is handed the Region the request named, and prices on it", async () => {
    await using kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": halfPriceInMalaysia } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    await enableMyr(kobai, catalog);
    const malaysia = await createRegion(kobai, catalog, "Malaysia", "MYR");
    await setPrice(kobai, catalog, { amount: 1250 });
    await setPrice(kobai, catalog, { amount: 5900, currency: "MYR" });

    const there = await kobai.request(
      `/store/variants/${catalog.variantId}/price?region=${malaysia}`,
      { headers: catalog.apiKey.headers },
    );
    await expect(there.json()).resolves.toMatchObject({
      region: { name: "Malaysia" },
      price: { amount: 2950, currency: "MYR" },
      workflow: {
        steps: [
          { step: "load-prices", implementation: "load-prices" },
          { step: "select-price", implementation: "half-price-in-malaysia" },
        ],
      },
    });

    // The same deployment, the same Step, another Region: the difference in the answer is the
    // Region and nothing else, which is what makes the first assertion mean something.
    const here = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    await expect(here.json()).resolves.toMatchObject({
      region: { name: "USD" },
      price: { amount: 1250, currency: "USD" },
    });
  });
});
