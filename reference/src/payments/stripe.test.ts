import { createTestKobai, seedTestCart } from "@kobai/core/testing";
import { stripePayments } from "@kobai/plugin-stripe";
import { describe, expect, it } from "vitest";
import config from "../../kobai.config.ts";
import { createAdminAssets } from "../admin-assets.ts";
import { createProjectFetch } from "../app.ts";
import { createRedirectPaymentRoutes, REDIRECT_START_PATH } from "./redirect.ts";
import { stripeConfiguration, stripeRedirectPayments } from "./stripe.ts";

/**
 * This Project's half of `@kobai/plugin-stripe` — the four calls
 * {@link ../payments/redirect.ts | the redirect routes} make, answered by the Plugin.
 *
 * **Nothing here reaches Stripe**, and that is the same decision the Plugin's own tests take
 * (ADR-0070): a real call needs a secret, is flaky and is not reproducible, so the whole of the
 * network is the one option `stripePayments` takes and the stub below fills it. The gate has no
 * Stripe secret and must never acquire one.
 */

type StripeAnswer = { readonly status?: number; readonly body: unknown };

/** Stripe, as a router rather than a queue — see `packages/plugin-stripe/src/payments.test.ts`. */
function stripeStub(routes: Record<string, StripeAnswer>) {
  const calls: { method: string; path: string; form: Record<string, string> }[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({
      method: request.method,
      path: pathname,
      form: Object.fromEntries(new URLSearchParams(await request.text())),
    });

    const answer = routes[`${request.method} ${pathname}`];
    if (answer === undefined) {
      throw new Error(
        `This test stubbed ${Object.keys(routes).join(", ") || "nothing"} and the Plugin called ${request.method} ${pathname}.`,
      );
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
}

const PAYMENT_PAGE = "https://storefront.test/checkout/pay";

/** Everything set, as a deployment that takes payments at a bank has it. */
const CONFIGURED = {
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_test_123",
  STRIPE_PAYMENT_PAGE_URL: PAYMENT_PAGE,
} as const;

/** A logger that keeps what it was told, because what a half-configured boot *says* is the subject. */
function loggerThatRemembers() {
  const errors: { message: string; detail: unknown }[] = [];
  return {
    errors,
    logger: {
      info: () => {},
      error: (message: string, detail?: Record<string, unknown>) => {
        errors.push({ message, detail });
      },
    },
  };
}

describe("whether this deployment takes payments at a bank", () => {
  it("is configured when it has been given all three of Stripe's settings", () => {
    expect(stripeConfiguration(CONFIGURED)).toEqual({
      secretKey: "sk_test_123",
      webhookSecret: "whsec_test_123",
      paymentPageUrl: PAYMENT_PAGE,
    });
  });

  it("is not, and says nothing about it, on a deployment given none of them", () => {
    // The ordinary case, and it is not a misconfiguration: this Store settles out of band
    // through `src/payments/manual.ts`, which is what a deployment gets until somebody fills
    // these in. A complaint here would make every `pnpm run up` look broken.
    const { logger, errors } = loggerThatRemembers();

    expect(stripeConfiguration({}, logger)).toBeNull();
    expect(errors).toEqual([]);
  });

  it("says which half is missing when a deployment set some of them and not others", () => {
    // The same shape `KOBAI_INITIAL_MERCHANT_*` already has: set both or neither, and with
    // one of them the boot names the one that is missing rather than half-working. It boots
    // and it serves — misconfiguring payments must not take a Store down (ADR-0053).
    const { logger, errors } = loggerThatRemembers();

    expect(stripeConfiguration({ STRIPE_SECRET_KEY: "sk_test_123" }, logger)).toBeNull();
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors[0])).toContain("STRIPE_WEBHOOK_SECRET");
    expect(JSON.stringify(errors[0])).toContain("STRIPE_PAYMENT_PAGE_URL");
  });

  it("reads a variable set to nothing as one that was not set", () => {
    // `compose.yaml` forwards bare names, and a shell that exports an empty one is the same
    // fact as a shell that exports none. A blank secret key would otherwise wire a provider
    // that authenticates against nothing and declines every purchase.
    const { logger, errors } = loggerThatRemembers();

    expect(
      stripeConfiguration(
        { ...CONFIGURED, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" },
        logger,
      ),
    ).toBeNull();
    expect(JSON.stringify(errors)).toContain("STRIPE_SECRET_KEY");
    expect(JSON.stringify(errors)).toContain("STRIPE_WEBHOOK_SECRET");
    expect(JSON.stringify(errors)).not.toContain("STRIPE_PAYMENT_PAGE_URL");
  });
});

describe("the Plugin, as this Project's redirect payments", () => {
  it("starts a payment for what kobai quoted and sends the Shopper to this Store's payment page", async () => {
    // `startPayment` is where the two halves meet: kobai says what the Cart comes to, the
    // Plugin creates the PaymentIntent for exactly that, and the Shopper is sent somewhere
    // that can finish it. For Stripe that is the storefront's own page with Elements on it —
    // `payment_intent_client_secret` is the name Stripe's own redirects use — rather than a
    // bank's URL, because which bank it is has not been chosen yet at this point.
    await using kobai = await createTestKobai(config);
    const stripe = stripeStub({
      "POST /v1/payment_intents": {
        body: { id: "pi_redirect", client_secret: "pi_redirect_secret_abc" },
      },
    });
    const payments = stripeRedirectPayments({
      stripe: stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch }),
      db: kobai.db,
      paymentPageUrl: PAYMENT_PAGE,
    });

    const started = await payments.startPayment({
      cartId: "cart-abcdef",
      metadata: { leadTimeDays: 3 },
      amount: 2500,
      currency: "MYR",
    });

    expect(started).toEqual({
      reference: "pi_redirect",
      redirectUrl: `${PAYMENT_PAGE}?payment_intent_client_secret=pi_redirect_secret_abc`,
    });
    expect(stripe.calls[0]?.form).toMatchObject({
      amount: "2500",
      currency: "myr",
      "metadata[kobaiCartId]": "cart-abcdef",
      "metadata[kobaiContext]": '{"leadTimeDays":3}',
    });
  });

  it("refuses the storefront's call, rather than breaking, when the payment cannot be started", async () => {
    // The route seam for the one refusal this adapter adds: an open context Stripe would not
    // carry back is a payment the Plugin will not start, and what a storefront gets for it is
    // a named reason rather than an unexplained 500 out of this Project. Nothing was started,
    // so nothing has to be given back — which is why refusing here is worth having at all.
    await using kobai = await createTestKobai(config);
    const cart = await seedTestCart(kobai);
    const stripe = stripeStub({});
    const fetch = createProjectFetch(
      { fetch: kobai.fetch },
      createAdminAssets(),
      createRedirectPaymentRoutes({
        kobai: { fetch: kobai.fetch },
        apiKey: cart.apiKey.key,
        payments: stripeRedirectPayments({
          stripe: stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch }),
          db: kobai.db,
          paymentPageUrl: PAYMENT_PAGE,
        }),
      }),
    );

    const response = await fetch(
      new Request(`http://kobai.test${REDIRECT_START_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cartId: cart.id, metadata: { note: "x".repeat(600) } }),
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      reason: "payment-not-started",
    });
    // And Stripe was never asked to create anything, so there is no intent anywhere for a
    // Shopper to be sent to.
    expect(stripe.calls).toEqual([]);
  });

  it("reads a payment back by its reference, with the context it was started with", async () => {
    await using kobai = await createTestKobai(config);
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: {
          id: "pi_redirect",
          status: "succeeded",
          metadata: { kobaiCartId: "cart-abcdef", kobaiContext: '{"leadTimeDays":3}' },
        },
      },
    });
    const payments = stripeRedirectPayments({
      stripe: stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch }),
      db: kobai.db,
      paymentPageUrl: PAYMENT_PAGE,
    });

    await expect(payments.paymentOf("pi_redirect")).resolves.toEqual({
      cartId: "cart-abcdef",
      metadata: { leadTimeDays: 3 },
    });
  });

  it("recognises the events Stripe sends about a payment it started, and no others", async () => {
    await using kobai = await createTestKobai(config);
    const payments = stripeRedirectPayments({
      stripe: stripePayments({ secretKey: "sk_test_123", fetch: stripeStub({}).fetch }),
      db: kobai.db,
      paymentPageUrl: PAYMENT_PAGE,
    });

    expect(
      payments.referenceOfCallback({
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_redirect", metadata: { kobaiCartId: "cart-abcdef" } } },
      }),
    ).toBe("pi_redirect");
    // A payment somebody else's system started, in the same Stripe account.
    expect(
      payments.referenceOfCallback({
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_elsewhere", metadata: {} } },
      }),
    ).toBeNull();
  });

  it("gives a payment back when kobai would not place it, and the Plugin writes down that it did", async () => {
    // The one path that would otherwise take money and give no goods (ADR-0070). What is
    // asserted is the Merchant's books rather than that a callback ran: the row is what a
    // Merchant reconciles against Stripe, and it is the Plugin's own table.
    await using kobai = await createTestKobai(config);
    const stripe = stripeStub({
      "POST /v1/refunds": {
        body: { id: "re_1", amount: 2500, currency: "myr", status: "succeeded" },
      },
    });
    const payments = stripeRedirectPayments({
      stripe: stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch }),
      db: kobai.db,
      paymentPageUrl: PAYMENT_PAGE,
    });

    await payments.refundUnplacedPayment({
      reference: "pi_redirect",
      cartId: "cart-abcdef",
      refusal: "insufficient-inventory",
    });

    expect(stripe.calls[0]?.form).toMatchObject({ payment_intent: "pi_redirect" });
    await expect(
      kobai.database.query(
        "select cart_id, payment_intent_id, refund_id, amount, currency, refusal from stripe_unplaced_refund",
      ),
    ).resolves.toEqual([
      {
        cart_id: "cart-abcdef",
        payment_intent_id: "pi_redirect",
        refund_id: "re_1",
        amount: 2500,
        currency: "MYR",
        refusal: "insufficient-inventory",
      },
    ]);
  });
});
