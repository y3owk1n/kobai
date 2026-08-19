import { createTestKobai, seedTestCart, type TestKobai } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { STRIPE_PAYMENT_INTENT_KEY } from "./metadata.ts";
import { stripePayments } from "./payments.ts";

/**
 * This Plugin at the seam a Developer actually reaches it through: a deployment booted with
 * it wired, and an Order placed over `POST /store/orders`.
 *
 * `payments.test.ts` beside this file asks the adapter what it answers. That is the smaller
 * question, and on its own it proves nothing about the thing a Merchant sees — whether
 * `name: "stripe"` reaches the Payment record, whether `received: false` survives onto the
 * Order body, whether a decline becomes a 402 and no Order at all. Those are facts about
 * Core reading this provider, and only a request can settle them. `createTestKobai({
 * payments: { provider } })` is the same `kobai.config.ts` shape a Project writes, so this
 * is a test of what a Developer does rather than of what this package exports.
 *
 * The network is still nobody's: the provider is built on a stubbed `fetch`, so nothing here
 * reaches Stripe either.
 */

/** A PaymentIntent as Stripe reports one, in the fields this Plugin reads. */
function intent(status: string, amount: number) {
  return { id: "pi_redirect", status, amount, currency: "usd" };
}

/** Stripe, answering one canned reply per route and nothing else. */
function stripeStub(routes: Record<string, unknown>) {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const route = `${request.method} ${new URL(request.url).pathname}`;
    const body = routes[route];
    if (body === undefined) {
      throw new Error(`Nothing stubbed ${route}, and this Plugin called it.`);
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  };
  return fetch;
}

/** The storefront's own call, carrying the reference on the body half of the open context. */
async function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      cartId,
      metadata: { [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" },
    }),
  });
}

/** Nothing was written, which is the assertion behind every refusal here. */
async function ordersIn(kobai: TestKobai) {
  return kobai.database.query("select id from core_order");
}

describe("an Order placed through this Plugin", () => {
  it("records the money as Stripe's, by the name a Merchant reconciles against", async () => {
    await using kobai = await createTestKobai({
      payments: {
        provider: stripePayments({
          secretKey: "sk_test_123",
          fetch: stripeStub({
            "GET /v1/payment_intents/pi_redirect": intent("succeeded", 1250),
          }),
        }),
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // `provider` is this Plugin's `name` and `reference` is Stripe's own handle, stored and
    // never parsed — which is what a Merchant quotes to find this money in the dashboard.
    await expect(response.json()).resolves.toMatchObject({
      total: 1250,
      payment: {
        provider: "stripe",
        reference: "pi_redirect",
        amount: 1250,
        received: true,
      },
    });
  });

  it("says the money has not landed when Stripe is still processing it", async () => {
    // The one place `received: false` is worth asserting through HTTP: an Order whose payment
    // is `processing` is real and unpaid, and without this it reads in the Admin exactly like
    // a completed sale. Nothing ever updates it — it is a fact, not a state (ADR-0056).
    await using kobai = await createTestKobai({
      payments: {
        provider: stripePayments({
          secretKey: "sk_test_123",
          fetch: stripeStub({
            "GET /v1/payment_intents/pi_redirect": intent("processing", 1250),
          }),
        }),
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      payment: { provider: "stripe", received: false },
    });
  });

  it("refuses at 402 and writes no Order when the bank said no", async () => {
    // A decline is a value rather than a throw, and this is what that buys: Core turns it
    // into `payment-declined` at 402 and writes nothing. The Shopper is told, and there is no
    // Order to unwind.
    await using kobai = await createTestKobai({
      payments: {
        provider: stripePayments({
          secretKey: "sk_test_123",
          fetch: stripeStub({
            "GET /v1/payment_intents/pi_redirect": {
              ...intent("requires_payment_method", 1250),
              last_payment_error: { message: "Your bank declined this payment." },
            },
          }),
        }),
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      reason: "payment-declined",
      error: "Your bank declined this payment.",
    });
    await expect(ordersIn(kobai)).resolves.toEqual([]);
  });
});

/**
 * **The loop ADR-0077 closes, at the only seam where both halves are visible at once.**
 *
 * `payments.test.ts` asks the adapter what it answers when the figures disagree, and
 * `quote-cart.test.ts` in Core asks what a quote comes to. Neither says the two fit together:
 * that a storefront which starts a payment for the figure kobai quoted is *not* refused, and
 * that one whose Cart moved underneath it *is*, are facts about the pair.
 */
describe("a payment started for what kobai quoted", () => {
  /** What a storefront asks before it sends a Shopper to their bank. */
  async function quote(
    kobai: TestKobai,
    headers: Record<string, string>,
    cartId: string,
  ) {
    const response = await kobai.request(`/store/carts/${cartId}/quote`, {
      method: "POST",
      headers,
    });
    return (await response.json()) as { total: number; currency: string };
  }

  it("is taken, because the intent was started for the figure the route answered", async () => {
    const stripe = stripeStub({
      "POST /v1/payment_intents": {
        id: "pi_redirect",
        client_secret: "pi_redirect_secret",
        status: "requires_payment_method",
      },
      // The intent as Stripe reports it once the Shopper has authorised at their bank, for the
      // amount it was created with.
      "GET /v1/payment_intents/pi_redirect": intent("succeeded", 1250),
    });
    const provider = stripePayments({ secretKey: "sk_test_123", fetch: stripe });
    await using kobai = await createTestKobai({ payments: { provider } });
    const cart = await seedTestCart(kobai);

    const quoted = await quote(kobai, cart.apiKey.headers, cart.id);
    await provider.startPayment({
      cartId: cart.id,
      amount: quoted.total,
      currency: quoted.currency,
    });
    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(quoted.total).toBe(1250);
    expect(response.status).toBe(201);
  });

  it("is refused when the Cart moved after the Shopper left, and no Order is written", async () => {
    // The failure the whole ticket exists for, and it is an ordinary sequence rather than a
    // contrived one: a Cart is mutable by design (ADR-0009), so a second tab adding a line
    // while the Shopper is in a banking app is a thing that happens. Without the check the
    // Shopper pays for one poster, Core records an Order for two, and the books balance
    // against money that never arrived.
    const stripe = stripeStub({
      "POST /v1/payment_intents": {
        id: "pi_redirect",
        client_secret: "pi_redirect_secret",
        status: "requires_payment_method",
      },
      "GET /v1/payment_intents/pi_redirect": intent("succeeded", 1250),
    });
    const provider = stripePayments({ secretKey: "sk_test_123", fetch: stripe });
    await using kobai = await createTestKobai({ payments: { provider } });
    const cart = await seedTestCart(kobai);
    const quoted = await quote(kobai, cart.apiKey.headers, cart.id);
    await provider.startPayment({
      cartId: cart.id,
      amount: quoted.total,
      currency: quoted.currency,
    });

    // A second of the same Variant, after the payment was started.
    await kobai.request(
      `/store/carts/${cart.id}/line-items/${cart.lineItem("POSTER-A2").id}`,
      {
        method: "PATCH",
        headers: { ...cart.apiKey.headers, "content-type": "application/json" },
        body: JSON.stringify({ quantity: 2 }),
      },
    );
    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      reason: "payment-declined",
      // The words are the Plugin's, and they name both figures because the person who can act
      // on this is the Developer wiring the storefront.
      error: expect.stringContaining("this Order comes to 2500 USD"),
    });
    await expect(ordersIn(kobai)).resolves.toEqual([]);
  });
});
