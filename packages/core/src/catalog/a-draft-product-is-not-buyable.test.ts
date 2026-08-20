import { afterEach, describe, expect, it } from "vitest";
import type { LoadedPrices, ResolvedPrice } from "../pricing/resolve-price.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCart,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/**
 * A Product a Merchant has not published, and the one Variant under it.
 *
 * Priced, because an unpriced Variant is refused by a rule that has nothing to do with this
 * one and would make three of the cases below pass for the wrong reason.
 */
async function aDraftProduct(where: TestKobai) {
  return seedTestCatalog(where, {
    title: "A draft mug",
    status: "draft",
    variants: [{ sku: "MUG-DRAFT", prices: [1250] }],
  });
}

describe("a Variant of a draft Product", () => {
  it("is not there, to a storefront holding its identifier", async () => {
    kobai = await createTestKobai();
    const draft = await aDraftProduct(kobai);

    const response = await kobai.request(`/store/variants/${draft.variantId}`, {
      headers: draft.apiKey.headers,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "variant-not-found",
    });
  });

  it("cannot be priced, and is turned back before the Workflow runs", async () => {
    kobai = await createTestKobai();
    const draft = await aDraftProduct(kobai);

    const response = await kobai.request(`/store/variants/${draft.variantId}/price`, {
      headers: draft.apiKey.headers,
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as object;
    expect(body).toMatchObject({ reason: "variant-not-found" });
    // The store surface refused, not a Step — so there is no run to report, and the field
    // saying how far the Workflow got is absent rather than invented. That is the same shape
    // `POST /store/orders` already answers an idempotency refusal in.
    expect(body).not.toHaveProperty("workflow");
  });

  it("cannot be put in a Cart", async () => {
    kobai = await createTestKobai();
    const draft = await aDraftProduct(kobai);

    const started = await kobai.request("/store/carts", {
      method: "POST",
      headers: draft.apiKey.headers,
    });
    const { id } = (await started.json()) as { id: string };

    const added = await kobai.request(`/store/carts/${id}/line-items`, {
      method: "POST",
      headers: { ...draft.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ variantId: draft.variantId }),
    });

    expect(added.status).toBe(404);
    await expect(added.json()).resolves.toMatchObject({
      reason: "variant-not-found",
    });
  });
});

/**
 * A Project's own `select-price`, written to notice what the deployment handed it.
 *
 * It reads two keys Core's own Steps never touch — the hold window and the Payment Provider —
 * and refuses when either is missing, so a route that built a smaller context than the
 * storefront's is a refused request rather than a silently different answer.
 */
const readsTheDeployment = defineStep(
  "select-price",
  (input: LoadedPrices, context): ResolvedPrice => {
    if (context.holdWindowMs === undefined || context.paymentProvider === undefined) {
      throw new StepFailure(
        "deployment-not-on-the-context",
        "This Step was run against a context missing what the deployment wired.",
      );
    }

    const chosen = input.prices[0];
    if (!chosen) throw new StepFailure("price-not-set", "Nothing to choose from.");
    return {
      variant: input.variant,
      price: { id: chosen.id, amount: chosen.amount, currency: chosen.currency },
    };
  },
);

/**
 * The other half of #276: closing the store surface must not close the Admin's preview.
 *
 * Previewing what a storefront would be charged for a Product that is not published yet is the
 * *feature* — it is how a Merchant checks a price before putting it on sale — so a uniform gate
 * that reached `resolve-price` would have taken it away in order to fix a hole somewhere else.
 * The guard therefore sits on the store surface's routes, and this is the deliberate way through
 * on the admin surface (ADR-0010: it is a route of the public API, not a privileged back door).
 */
describe("previewing a price a storefront could not ask for", () => {
  it("answers a draft's price on the admin surface", async () => {
    kobai = await createTestKobai();
    const draft = await aDraftProduct(kobai);

    const response = await kobai.request(`/admin/variants/${draft.variantId}/price`, {
      headers: draft.merchant.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      variant: { sku: "MUG-DRAFT" },
      price: { amount: 1250 },
      workflow: { name: "resolve-price" },
    });
  });

  /**
   * The honesty guard, and the thing that makes the second route worth having at all.
   *
   * A preview is only worth reading if it is the number a storefront would be told, so the two
   * routes must not be two answers. They are one `resolve-price` run by one handler shape, and
   * this is what says so from outside: for a Variant a storefront *can* ask about, the two
   * bodies are equal byte for byte. A second implementation of pricing behind `/admin` would
   * fail here rather than by being wrong in production.
   */
  it("answers exactly what the store surface answers, for a Product on sale", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const asAMerchant = await kobai.request(
      `/admin/variants/${catalog.variantId}/price`,
      { headers: catalog.merchant.headers },
    );
    const asAStorefront = await kobai.request(
      `/store/variants/${catalog.variantId}/price`,
      { headers: catalog.apiKey.headers },
    );

    expect(asAMerchant.status).toBe(200);
    expect(asAStorefront.status).toBe(200);
    await expect(asAMerchant.json()).resolves.toEqual(await asAStorefront.json());
  });

  /**
   * The second half of that guard, and the one an equality over Core's own Steps cannot make.
   *
   * A Step is a Project's to replace and may read anything on the Workflow context — the
   * deployment's hold window, its Payment Provider, its wired Strategies — so two routes that
   * ran the same declaration against **different contexts** would still answer differently the
   * first time a Project's own Step read one of those keys, and Core's Steps read none of them.
   * So the Step here refuses unless it was handed the deployment, and the assertion is that
   * both surfaces answer it.
   */
  it("hands a replaced Step the same deployment on both surfaces", async () => {
    kobai = await createTestKobai({
      workflows: { "resolve-price": { steps: { "select-price": readsTheDeployment } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const asAMerchant = await kobai.request(
      `/admin/variants/${catalog.variantId}/price`,
      { headers: catalog.merchant.headers },
    );
    const asAStorefront = await kobai.request(
      `/store/variants/${catalog.variantId}/price`,
      { headers: catalog.apiKey.headers },
    );

    expect(asAMerchant.status, await asAMerchant.text()).toBe(200);
    expect(asAStorefront.status, await asAStorefront.text()).toBe(200);
  });

  it("has nothing to price for a Variant that is not there", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });

    const unpriced = await kobai.request(`/admin/variants/${catalog.variantId}/price`, {
      headers: catalog.merchant.headers,
    });
    const missing = await kobai.request(
      "/admin/variants/00000000-0000-4000-8000-000000000000/price",
      { headers: catalog.merchant.headers },
    );

    // Both 404, and both from a Step — this route runs the Workflow and reports how far it got,
    // which is the same account the store surface's does.
    expect(unpriced.status).toBe(404);
    await expect(unpriced.json()).resolves.toMatchObject({
      reason: "price-not-set",
      workflow: { failed: "select-price" },
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      reason: "variant-not-found",
      workflow: { failed: "load-prices" },
    });
  });
});

/**
 * Takes the Cart's Product off the storefront under the Shopper who is holding it.
 *
 * `archived` rather than `draft` because it is the case a Merchant actually reaches — a
 * Product nobody could have put in a Cart was never published — and the two are one fact to
 * every reader below: `published` is what the store surface answers, and everything else is
 * everything else.
 */
async function takeOffTheStorefront(where: TestKobai, cart: TestCart): Promise<void> {
  const archived = await where.request(`/admin/products/${cart.catalog.productId}`, {
    method: "PATCH",
    headers: { ...cart.catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ status: "archived" }),
  });
  expect(archived.status).toBe(200);
}

describe("a Cart line whose Product left the storefront", () => {
  /**
   * The mid-checkout case, and the one this ticket had to take a decision about.
   *
   * A Shopper builds a Cart while a Product is on sale, and a Merchant archives it before they
   * press Buy. **The line is refused rather than dropped** — ADR-0059's refuse-rather-than-cascade
   * with a repair the Shopper can carry out — and ADR-0009's snapshot argument is why the
   * alternative is worse: silently removing the line changes what is being bought underneath
   * somebody who did nothing wrong. The cost is acknowledged rather than avoided: a Shopper who
   * did nothing wrong meets a dead end at the last step.
   */
  it("is refused at place-order, by its own reason, naming the Variant", async () => {
    kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    await takeOffTheStorefront(kobai, cart);

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    // 409 beside the Cart that can no longer be placed: the request was fine and the state of
    // the Store refuses it, and retrying changes nothing until somebody changes the Store.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; reason: string };
    expect(body.reason).toBe("variant-unavailable");
    // The Variant, by the SKU a Shopper's own confirmation would show them — a refusal naming
    // only "something in your Cart" leaves a storefront with nothing to point at.
    expect(body.error).toContain("POSTER-A2");
  });

  /**
   * The same word at the other two doors a Cart is claimed or priced through, and the reason
   * they are asserted at all.
   *
   * All three read the Cart through `order/load-cart.ts`, which is the one place the Cart path
   * goes through — so this is not three implementations being checked but one, reached three
   * ways. What it buys the Shopper is that the dead end arrives **before** the bank: a
   * storefront quoting a Cart or holding its stock ahead of a redirect payment (ADR-0070) is
   * told here rather than after the money has moved.
   */
  it("is refused when the Cart is quoted, and when its stock is held", async () => {
    kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    await takeOffTheStorefront(kobai, cart);

    for (const path of [
      `/store/carts/${cart.id}/quote`,
      `/store/carts/${cart.id}/reservations`,
    ]) {
      const response = await kobai.request(path, {
        method: "POST",
        headers: cart.apiKey.headers,
      });

      expect(response.status, path).toBe(409);
      await expect(response.json(), path).resolves.toMatchObject({
        reason: "variant-unavailable",
      });
    }
  });
});
