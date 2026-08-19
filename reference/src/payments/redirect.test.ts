import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import config from "../../kobai.config.ts";
import { createAdminAssets } from "../admin-assets.ts";
import { createProjectFetch, type ProjectFetch } from "../app.ts";
import { createFakeBank, type FakeBank } from "./fake-bank.ts";
import {
  createRedirectPaymentRoutes,
  idempotencyKeyFor,
  PAYMENT_REFERENCE_KEY,
  REDIRECT_CALLBACK_PATH,
  REDIRECT_RETURN_PATH,
  REDIRECT_START_PATH,
} from "./redirect.ts";

/**
 * This Project's redirect payment routes, dispatched at the Project's own `fetch`.
 *
 * The seam is the same one a bank and a browser reach: a `Request` at this process, answered by
 * `src/app.ts` deciding whose path it is. What is asserted is what a Shopper and the books end
 * up with — an Order or no Order, money held or money given back — and never that a callback was
 * reached.
 *
 * `tests/a-storefront-buys-something.test.ts` is where the three cases that *matter* live:
 * abandonment, the race between the return and the callback, and a hold that lapsed while the
 * Shopper was at their bank. This file holds what that one should not have to: the refusals, and
 * the two properties of the kobai call itself that no response body can show — that the
 * reference travels on the request body and never the query string (#138), and that both callers
 * derive one `Idempotency-Key` from it (#102).
 */

/** The Project as the gate boots it: the fake bank starts the payments *and* takes them. */
async function aProjectThatTakesRedirectPayments(): Promise<{
  readonly kobai: TestKobai;
  readonly bank: FakeBank;
  readonly fetch: ProjectFetch;
  /** Every kobai request the Project's routes made, in order, exactly as it was sent. */
  readonly askedKobai: {
    readonly url: string;
    readonly headers: Headers;
    readonly body: string;
  }[];
  readonly cartId: string;
  readonly apiKey: string;
}> {
  const bank = createFakeBank();
  // The one line `kobai.config.ts` moves on the day this Store takes cards (#230): a bank that
  // starts a payment and a Payment Provider that confirms it have to be the same system, or
  // `charge` is confirming somebody else's money.
  const kobai = await createTestKobai({ ...config, payments: { provider: bank } });
  const cart = await seedTestCart(kobai, { quantity: 2 });

  const askedKobai: { url: string; headers: Headers; body: string }[] = [];
  const watched: ProjectFetch = async (request) => {
    // Cloned, because reading a `Request`'s body consumes it and the one below is the one
    // kobai has to be able to read.
    askedKobai.push({
      url: request.url,
      headers: request.headers,
      body: await request.clone().text(),
    });
    return kobai.fetch(request);
  };

  const fetch = createProjectFetch(
    { fetch: kobai.fetch },
    createAdminAssets(),
    createRedirectPaymentRoutes({
      kobai: { fetch: watched },
      payments: bank,
      apiKey: cart.apiKey.key,
    }),
  );

  return { kobai, bank, fetch, askedKobai, cartId: cart.id, apiKey: cart.apiKey.key };
}

/** A `POST` at this Project, the way a storefront, a browser or a bank makes one. */
function post(path: string, body: unknown): Request {
  return new Request(`http://kobai.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The whole flow up to the moment the Shopper is at their bank, with the money authorised. */
async function anAuthorisedPayment(project: {
  readonly fetch: ProjectFetch;
  readonly bank: FakeBank;
  readonly cartId: string;
}): Promise<string> {
  const started = await project.fetch(
    post(REDIRECT_START_PATH, { cartId: project.cartId }),
  );
  const { reference } = (await started.json()) as { reference: string };
  project.bank.authorise(reference);
  return reference;
}

describe("starting a payment the Shopper completes at their bank", () => {
  it("starts it for what kobai says the Cart comes to, not for a figure the caller sent", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using kobai = project.kobai;

    const response = await project.fetch(
      // A storefront naming its own amount is a storefront whose bug the Merchant's books pay
      // for, so the route does not offer the field — and one sent anyway changes nothing.
      post(REDIRECT_START_PATH, { cartId: project.cartId, amount: 1 }),
    );

    expect(response.status).toBe(200);
    const started = (await response.json()) as { reference: string; redirectUrl: string };
    // Two of them at this Project's one cent, in this Project's own currency — the whole point
    // of quoting through the deployment's own Steps rather than reading Prices (ADR-0077).
    expect(project.bank.payment(started.reference)).toMatchObject({
      cartId: project.cartId,
      amount: 2,
      currency: "MYR",
      status: "awaiting-the-shopper",
    });
    expect(started.redirectUrl).toContain(started.reference);
    // Nothing has been bought yet: a payment is started and no Order exists until the bank has
    // answered (ADR-0070).
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("refuses in kobai's own words when the Cart cannot be quoted", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using _kobai = project.kobai;

    const response = await project.fetch(
      post(REDIRECT_START_PATH, { cartId: "31a4f0ae-0000-4000-8000-000000000000" }),
    );

    expect(response.status).toBe(404);
    // kobai has already said what is wrong with this Cart, and saying it again in this
    // Project's words would be a second vocabulary for one fact.
    await expect(response.json()).resolves.toMatchObject({ reason: "cart-not-found" });
  });
});

describe("settling it", () => {
  it("places the Order when the Shopper comes back, and the Order says the bank paid", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using kobai = project.kobai;
    const reference = await anAuthorisedPayment(project);

    const settled = await project.fetch(post(REDIRECT_RETURN_PATH, { reference }));

    expect(settled.status).toBe(200);
    await expect(settled.json()).resolves.toMatchObject({
      settled: "placed",
      reference,
    });
    const [order] = await kobai.database.query<{ id: string }>(
      "select id from core_order",
    );
    expect(order).toBeDefined();
  });

  it("sends the reference on the body and never in the query string", async () => {
    // #138, and it is a credential rather than a preference: a query string is written to
    // access logs, to proxy logs, and to the `Referer` of anything a confirmation page loads.
    const project = await aProjectThatTakesRedirectPayments();
    await using _kobai = project.kobai;
    const reference = await anAuthorisedPayment(project);

    await project.fetch(post(REDIRECT_RETURN_PATH, { reference }));

    // On the body half of the open context, under the key the provider reads it back out of.
    const placing = project.askedKobai.find((asked) =>
      asked.url.endsWith("/store/orders"),
    );
    expect(JSON.parse(placing?.body ?? "{}")).toEqual({
      cartId: project.cartId,
      metadata: { [PAYMENT_REFERENCE_KEY]: reference },
    });
    // And in no query string anywhere — not on the placement, and not on the quote either.
    expect(project.askedKobai.length).toBeGreaterThan(1);
    for (const asked of project.askedKobai) {
      expect(asked.url, `${asked.url} carries the reference`).not.toContain(reference);
      expect(new URL(asked.url).search).toBe("");
    }
  });

  it("derives one Idempotency-Key from the reference, so two callers claim the same one", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using _kobai = project.kobai;
    const reference = await anAuthorisedPayment(project);

    await project.fetch(post(REDIRECT_RETURN_PATH, { reference }));
    await project.fetch(
      post(REDIRECT_CALLBACK_PATH, project.bank.callbackFor(reference)),
    );

    const keys = project.askedKobai
      .filter((asked) => asked.url.endsWith("/store/orders"))
      .map((asked) => asked.headers.get("idempotency-key"));
    // Two calls, one key, and the key is a function of the reference and nothing else — which
    // is what makes the return and the callback one intention rather than two (#102).
    expect(keys).toEqual([idempotencyKeyFor(reference), idempotencyKeyFor(reference)]);
  });

  it("refuses at 402 and writes no Order when the Shopper never authorised", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using kobai = project.kobai;
    // Started, and left at the bank. The Shopper closed the tab *before* authorising, which is
    // a different fact from closing it after — no money moved, so nothing is owed back.
    const started = await project.fetch(
      post(REDIRECT_START_PATH, { cartId: project.cartId }),
    );
    const { reference } = (await started.json()) as { reference: string };

    const settled = await project.fetch(post(REDIRECT_RETURN_PATH, { reference }));

    expect(settled.status).toBe(402);
    await expect(settled.json()).resolves.toMatchObject({ reason: "payment-declined" });
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    // Refunded because kobai refused, and there was nothing to refund: the books say the money
    // never left, which is the fact worth asserting rather than which callback ran.
    expect(project.bank.payment(reference)).toMatchObject({ refunded: 0 });
  });

  it("ignores a callback about a payment it never started", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using kobai = project.kobai;

    const settled = await project.fetch(
      post(REDIRECT_CALLBACK_PATH, { type: "payment.authorised", payment: {} }),
    );

    expect(settled.status).toBe(400);
    await expect(settled.json()).resolves.toMatchObject({ reason: "not-ours" });
    // A Store's payment provider holds payments kobai never started, and guessing at one is how
    // a stranger's money buys somebody's stock.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("tells a storefront that its return carried no reference", async () => {
    // A different mistake from the one above and so a different word for it: this is a
    // storefront's bug rather than an event about somebody else's money, and `not-ours` would
    // send whoever wrote the return page looking at their provider.
    const project = await aProjectThatTakesRedirectPayments();
    await using _kobai = project.kobai;

    const settled = await project.fetch(post(REDIRECT_RETURN_PATH, {}));

    expect(settled.status).toBe(400);
    await expect(settled.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses the reference in a query string, because there is nowhere to put it", async () => {
    const project = await aProjectThatTakesRedirectPayments();
    await using _kobai = project.kobai;
    const reference = await anAuthorisedPayment(project);

    const settled = await project.fetch(
      new Request(
        `http://kobai.test${REDIRECT_RETURN_PATH}?reference=${reference}&cartId=${project.cartId}`,
      ),
    );

    expect(settled.status).toBe(405);
    await expect(settled.json()).resolves.toMatchObject({
      reason: "method-not-allowed",
    });
  });

  it("says so rather than dispatching when this deployment has no store key", async () => {
    const bank = createFakeBank();
    await using kobai = await createTestKobai({
      ...config,
      payments: { provider: bank },
    });
    const cart = await seedTestCart(kobai);
    const fetch = createProjectFetch(
      { fetch: kobai.fetch },
      createAdminAssets(),
      createRedirectPaymentRoutes({ kobai, payments: bank, apiKey: "" }),
    );

    const response = await fetch(post(REDIRECT_START_PATH, { cartId: cart.id }));

    expect(response.status).toBe(503);
    // Naming the variable to set, rather than passing on the 401 kobai would have answered a
    // request with no credential on it.
    await expect(response.json()).resolves.toMatchObject({ reason: "no-store-key" });
  });
});

describe("the context the Shopper was quoted with", () => {
  it("is what the Order is placed with, so the bank took what kobai charged", async () => {
    // **ADR-0077 through a redirect.** This Store makes some of what it sells to order and
    // charges for a short lead time, and that lead time is a number Core has never modelled: it
    // arrives in the open context (ADR-0013) and a Plugin's Step turns it into an Adjustment.
    // A payment started for a quote that saw it, and then placed without it, is a payment for
    // the wrong money. **Watched failing** against a settlement that dropped the context: the
    // route answered 402 `payment-declined` with "This payment is for 3501 MYR and this Order
    // comes to 1 MYR, so it was not taken", refunded, and left the Shopper with no Order — the
    // ADR-0077 disagreement arriving through the redirect.
    const bank = createFakeBank();
    await using kobai = await createTestKobai({
      ...config,
      payments: { provider: bank },
    });
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
    });
    const cart = await seedTestCart(kobai, { catalog });
    const fetch = createProjectFetch(
      { fetch: kobai.fetch },
      createAdminAssets(),
      createRedirectPaymentRoutes({ kobai, payments: bank, apiKey: cart.apiKey.key }),
    );

    const started = await fetch(
      post(REDIRECT_START_PATH, { cartId: cart.id, metadata: { leadTimeDays: 3 } }),
    );
    const { reference, amount } = (await started.json()) as {
      reference: string;
      amount: number;
    };
    bank.authorise(reference);
    const settled = await fetch(post(REDIRECT_RETURN_PATH, { reference }));

    // A penny for the goods and 3500 for the hurry — the figure the Shopper authorised.
    expect(amount).toBe(3501);
    expect(settled.status, await settled.text().catch(() => "")).toBe(200);
    const [order] = await kobai.database.query<{ total: string }>(
      "select total from core_order",
    );
    // And the Order kobai wrote is for the same money, which it can only be if the placement
    // ran with the context the quote ran with.
    expect(Number(order?.total)).toBe(amount);
  });
});

describe("the fake bank itself", () => {
  it("declines an order that carries no reference at all", async () => {
    // The provider is reached the way a Developer reaches it — booted, over `POST
    // /store/orders` — because whether a decline becomes a 402 with no Order is Core's reading
    // of this provider rather than anything the object can be asked.
    const bank = createFakeBank();
    await using kobai = await createTestKobai({
      ...config,
      payments: { provider: bank },
    });
    const cart = await seedTestCart(kobai);

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ reason: "payment-declined" });
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("declines a payment for an amount other than what the Order comes to", async () => {
    // ADR-0077's half, in this Project's own fake: the Cart is mutable by design, so a line
    // added while the Shopper was away is an ordinary thing that happens — and an expensive
    // Cart bought with a cheap payment is money that never arrived.
    const project = await aProjectThatTakesRedirectPayments();
    await using kobai = project.kobai;
    const reference = await anAuthorisedPayment(project);

    const [line] = await kobai.database.query<{ id: string }>(
      "select id from core_cart_line_item",
    );
    const grew = await kobai.request(
      `/store/carts/${project.cartId}/line-items/${line?.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${project.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ quantity: 5 }),
      },
    );
    expect(grew.status).toBe(200);

    const settled = await project.fetch(post(REDIRECT_RETURN_PATH, { reference }));

    expect(settled.status).toBe(402);
    // And the money goes back, because the Shopper authorised it at their bank and kobai wrote
    // nothing for it.
    expect(project.bank.payment(reference)).toMatchObject({
      status: "refunded",
      refunded: 2,
      refusal: "payment-declined",
    });
  });
});
