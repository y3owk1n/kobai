import type { PaymentRequest } from "@kobai/core";
import { createTestKobai } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { paymentIntentIdOfEvent } from "./events.ts";
import { cartIdOfPaymentIntent, STRIPE_PAYMENT_INTENT_KEY } from "./metadata.ts";
import { stripeMigrationSet } from "./migration-set.ts";
import { stripePayments } from "./payments.ts";

/**
 * **Nothing in this file reaches Stripe**, and that is a decision rather than an
 * optimisation (ADR-0070). A real call needs a secret, is flaky, and is not reproducible, so
 * `devbox run ci` would be three things it is not. The whole of the network is one option —
 * `fetch` — and the stub below is what fills it.
 *
 * The stub is a router rather than a queue: a test says what `POST /v1/refunds` answers, not
 * what the third call answers, so adding a call to the implementation cannot silently shift
 * another test's canned reply onto the wrong request. A route nothing stubbed throws naming
 * both what was stubbed and what was called, which is what makes "this reached the network"
 * impossible to mistake for a pass.
 */

type StripeAnswer = {
  /** Defaults to 200. Stripe reports a decline and a misuse alike as a 4xx with an `error`. */
  readonly status?: number;
  readonly body: unknown;
};

/** One call this Plugin made, in the terms an assertion wants to be written in. */
type StripeCall = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  /** Stripe's own retry-safety header, or `null` for a call this Plugin sends without one. */
  readonly idempotencyKey: string | null;
  /** The form-encoded body, decoded — `{}` for a GET, which carries none. */
  readonly form: Record<string, string>;
};

function stripeStub(routes: Record<string, StripeAnswer>) {
  const calls: StripeCall[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    const body = await request.text();

    calls.push({
      method: request.method,
      path: pathname,
      authorization: request.headers.get("authorization"),
      idempotencyKey: request.headers.get("idempotency-key"),
      form: Object.fromEntries(new URLSearchParams(body)),
    });

    const route = `${request.method} ${pathname}`;
    const answer = routes[route];
    if (answer === undefined) {
      // Named both ways round, because the two ways this fires are "the implementation
      // called something new" and "this test named a route it does not reach".
      throw new Error(
        `This test stubbed ${Object.keys(routes).join(", ") || "nothing"} and the Plugin called ${route}.`,
      );
    }

    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
}

/** What `place-order` sends a provider, with whatever the storefront put in the open context. */
function asked(metadata: Record<string, unknown>): PaymentRequest {
  return { amount: 2500, currency: "MYR", shopper: null, metadata };
}

/** A PaymentIntent as Stripe reports one, in the fields this Plugin reads. */
function intent(status: string, fields: Record<string, unknown> = {}) {
  return { id: "pi_redirect", status, amount: 2500, currency: "myr", ...fields };
}

describe("finding the Cart a payment belongs to", () => {
  it("reads it off the PaymentIntent Stripe hands a webhook", () => {
    // The reason the identifier is in the intent's metadata at all: a webhook arrives with
    // the intent and nothing else, and the Cart is the only thing that says which purchase
    // this payment was for. This is what turns `payment_intent.succeeded` into a
    // `POST /store/orders` for a particular Cart (ADR-0070).
    expect(
      cartIdOfPaymentIntent({
        id: "pi_redirect",
        metadata: { kobaiCartId: "cart-abcdef" },
      }),
    ).toBe("cart-abcdef");
  });

  it("answers null for a payment kobai did not start", () => {
    // A Store's Stripe account has payments in it that kobai knows nothing about, and a
    // webhook is told about all of them. `null` is what lets a Project ignore one rather
    // than have to guess at a Cart.
    expect(cartIdOfPaymentIntent({ id: "pi_elsewhere", metadata: {} })).toBeNull();
    expect(cartIdOfPaymentIntent(undefined)).toBeNull();
  });
});

describe("starting a payment the Shopper completes at their bank", () => {
  it("creates a PaymentIntent offering whatever the currency allows, carrying the Cart", async () => {
    const stripe = stripeStub({
      "POST /v1/payment_intents": {
        body: {
          id: "pi_redirect",
          client_secret: "pi_redirect_secret_abc",
          status: "requires_payment_method",
        },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const started = await payments.startPayment({
      cartId: "cart-abcdef",
      amount: 2500,
      currency: "MYR",
    });

    // `client_secret` is what Elements is handed in the storefront, and the `reference` is
    // what comes back on `POST /store/orders` once the bank has answered.
    expect(started).toEqual({
      reference: "pi_redirect",
      clientSecret: "pi_redirect_secret_abc",
      status: "requires_payment_method",
    });
    // `automatic_payment_methods` is the whole of "FPX only for MYR needs no kobai code":
    // the currency decides what Stripe offers, and adding a method is a dashboard setting.
    // `metadata[kobaiCartId]` is what lets a webhook find the Cart this payment belongs to.
    expect(stripe.calls).toEqual([
      {
        method: "POST",
        path: "/v1/payment_intents",
        authorization: "Bearer sk_test_123",
        idempotencyKey: null,
        form: {
          amount: "2500",
          currency: "myr",
          "automatic_payment_methods[enabled]": "true",
          "metadata[kobaiCartId]": "cart-abcdef",
        },
      },
    ]);
  });

  it("carries the open context the storefront sent, as one JSON value", async () => {
    // ADR-0013's context is whatever the storefront sent that Core does not model, and a
    // deployment's Steps may price on it — so the payment has to be *placed* with the
    // context it was *quoted* with or the two figures are for two different purchases
    // (ADR-0077). Stripe's metadata values are strings and the context is not, so it
    // travels as JSON under one key rather than as a key per field: a bag Core never
    // interprets cannot be flattened into Stripe's forty-character keys without inventing
    // rules for nesting, and one value is one thing to read back.
    const stripe = stripeStub({
      "POST /v1/payment_intents": {
        body: { id: "pi_redirect", client_secret: "pi_redirect_secret_abc" },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await payments.startPayment({
      cartId: "cart-abcdef",
      amount: 2500,
      currency: "MYR",
      metadata: { leadTimeDays: 3, tier: "trade" },
    });

    expect(stripe.calls[0]?.form).toEqual({
      amount: "2500",
      currency: "myr",
      "automatic_payment_methods[enabled]": "true",
      "metadata[kobaiCartId]": "cart-abcdef",
      "metadata[kobaiContext]": '{"leadTimeDays":3,"tier":"trade"}',
    });
  });

  it("sends no context key at all when the storefront sent nothing", async () => {
    // An empty bag and no bag are the same fact, and writing `{}` onto every intent a Store
    // ever takes would put a value in a Merchant's Stripe dashboard that says nothing.
    const stripe = stripeStub({
      "POST /v1/payment_intents": {
        body: { id: "pi_redirect", client_secret: "pi_redirect_secret_abc" },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await payments.startPayment({ cartId: "cart-abcdef", amount: 2500, currency: "MYR" });

    expect(stripe.calls[0]?.form).not.toHaveProperty("metadata[kobaiContext]");
  });

  it("refuses to start a payment whose context Stripe would not carry back", async () => {
    // **A truncated context is worse than no payment**, and this is the one place that can
    // say so. Stripe holds 500 characters per metadata value; a context that does not fit
    // would be quoted with and placed without, so a Step pricing on it would work out two
    // figures for one purchase — and the Shopper would already have authorised the first.
    // Nothing is sent to Stripe at all: the throw happens before the intent exists.
    const stripe = stripeStub({});
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.startPayment({
        cartId: "cart-abcdef",
        amount: 2500,
        currency: "MYR",
        metadata: { note: "x".repeat(600) },
      }),
    ).rejects.toThrow(/500/);
    expect(stripe.calls).toEqual([]);
  });
});

describe("reading a payment back by its reference", () => {
  it("answers the Cart and the context it was started with", async () => {
    // What settling needs, and the provider is the only thing that has it: the Shopper's
    // returning browser sends a reference and nothing else, and the webhook could not send
    // more, so both settle from here and their two requests are one (ADR-0070).
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("succeeded", {
          metadata: {
            kobaiCartId: "cart-abcdef",
            kobaiContext: '{"leadTimeDays":3}',
          },
        }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(payments.paymentOf("pi_redirect")).resolves.toEqual({
      cartId: "cart-abcdef",
      metadata: { leadTimeDays: 3 },
    });
    // A read, so no idempotency key: Stripe replays the first answer for a repeated one,
    // which is the whole point for a refund and a trap for anything that has moved on.
    expect(stripe.calls[0]?.idempotencyKey).toBeNull();
  });

  it("answers null for a reference Stripe has never heard of", async () => {
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_nothing": {
        status: 404,
        body: { error: { code: "resource_missing", message: "No such payment_intent." } },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(payments.paymentOf("pi_nothing")).resolves.toBeNull();
  });

  it("answers null for a payment in this Store's Stripe account that kobai never started", async () => {
    // A Merchant's Stripe account holds payments kobai knows nothing about — a subscription,
    // a payment link, an invoice — and `null` is what lets the Project's route turn one back
    // rather than guess at a Cart for it.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_elsewhere": {
        body: intent("succeeded", { metadata: {} }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(payments.paymentOf("pi_elsewhere")).resolves.toBeNull();
  });

  it("throws rather than answering null when Stripe will not say", async () => {
    // The same distinction `charge` draws, and for the same reason: a mistyped key, a
    // revoked one or an outage answered as "no such payment" would settle nothing and say
    // the payment was a stranger's, leaving a Shopper's money at the bank with nothing
    // anywhere reporting it.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        status: 401,
        body: { error: { type: "invalid_request_error", message: "Invalid API Key." } },
      },
    });
    const payments = stripePayments({ secretKey: "sk_wrong", fetch: stripe.fetch });

    await expect(payments.paymentOf("pi_redirect")).rejects.toThrow(/Invalid API Key/);
  });

  it("reads a context nobody can parse as none, and lets the amount answer for it", async () => {
    // Only reachable by somebody editing the intent in Stripe's dashboard, since this
    // Plugin is what writes that value. Settling with the context kobai can actually read
    // is safe because it is not the last check: a Step that priced on what is missing works
    // out a different total, and `charge` declines a payment for a figure that disagrees
    // with the Order (ADR-0077), so the money goes back rather than buying at a price
    // nobody authorised.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("succeeded", {
          metadata: { kobaiCartId: "cart-abcdef", kobaiContext: "not json" },
        }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(payments.paymentOf("pi_redirect")).resolves.toEqual({
      cartId: "cart-abcdef",
      metadata: {},
    });
  });
});

describe("which payment a webhook is about", () => {
  it("reads the PaymentIntent off an event that says the bank answered", () => {
    expect(
      paymentIntentIdOfEvent({
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_redirect", metadata: { kobaiCartId: "cart-abcdef" } } },
      }),
    ).toBe("pi_redirect");
  });

  it("answers null for an event about somebody else's money, and for one that settles nothing", () => {
    // A Store's endpoint is told about every event it subscribed to — a payment kobai never
    // started, an intent that has only just been created — and `null` is what lets the
    // Project's webhook acknowledge one without settling anything.
    expect(
      paymentIntentIdOfEvent({
        type: "payment_intent.succeeded",
        data: { object: { id: "pi_elsewhere", metadata: {} } },
      }),
    ).toBeNull();
    expect(
      paymentIntentIdOfEvent({
        type: "payment_intent.created",
        data: { object: { id: "pi_redirect", metadata: { kobaiCartId: "cart-abcdef" } } },
      }),
    ).toBeNull();
    expect(paymentIntentIdOfEvent("not an event")).toBeNull();
  });
});

describe("charging a payment the bank has already answered", () => {
  it("takes an intent the Shopper completed, and confirms nothing", async () => {
    // The ordinary FPX case, and what makes `charge` a *confirmation* rather than a start:
    // the funds left when the Shopper authorised at their bank, so by the time kobai is
    // called the intent has already succeeded. Confirming it again is a 400 from Stripe,
    // which is why this Plugin asks before it acts.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": { body: intent("succeeded") },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const outcome = await payments.charge(
      asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" }),
    );

    expect(outcome).toEqual({ ok: true, reference: "pi_redirect", received: true });
    expect(stripe.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/payment_intents/pi_redirect",
    ]);
  });

  it("confirms an intent still waiting to be confirmed, and answers on what that produced", async () => {
    // The other half of the same integration: a card entered in Elements without a redirect
    // leaves the intent at `requires_confirmation`, and here `charge` really does confirm —
    // once, with a key derived from the intent so a retried placement cannot take twice.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": { body: intent("requires_confirmation") },
      "POST /v1/payment_intents/pi_redirect/confirm": { body: intent("succeeded") },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const outcome = await payments.charge(
      asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" }),
    );

    expect(outcome).toEqual({ ok: true, reference: "pi_redirect", received: true });
    expect(stripe.calls[1]).toEqual({
      method: "POST",
      path: "/v1/payment_intents/pi_redirect/confirm",
      authorization: "Bearer sk_test_123",
      idempotencyKey: "kobai-confirm-pi_redirect",
      form: {},
    });
  });

  it("says the money is only on its way when Stripe says the payment is processing", async () => {
    // `received: false` is not a state kobai will move this through (ADR-0056) — it is the
    // fact that the Order is real and the money has not landed, which is what the field has
    // meant since it shipped. Saying nothing here would default to `true` and every such
    // Order would read in the Admin as a completed sale.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": { body: intent("processing") },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.charge(asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" })),
    ).resolves.toEqual({ ok: true, reference: "pi_redirect", received: false });
  });

  it("declines with what Stripe told the Shopper when the bank refused", async () => {
    // A decline is a value, not a throw: Core turns it into `payment-declined` at 402 and
    // writes no Order. A provider that threw would report an outage every time a Shopper's
    // bank said no.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("requires_payment_method", {
          last_payment_error: { message: "Your bank declined this payment." },
        }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.charge(asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" })),
    ).resolves.toEqual({ ok: false, detail: "Your bank declined this payment." });
  });

  it("declines a payment Stripe has never heard of", async () => {
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        status: 404,
        body: {
          error: {
            type: "invalid_request_error",
            code: "resource_missing",
            message: "No such payment_intent: 'pi_redirect'.",
          },
        },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.charge(asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" })),
    ).resolves.toMatchObject({ ok: false });
  });

  it("throws rather than declines when the key is wrong, so a Store hears about it", async () => {
    // The difference this draws is the interface's own: a decline is an ordinary answer a
    // storefront acts on, and a provider that *throws* is reporting that it is broken or
    // unreachable. A deployment with a mistyped secret key is the second one — and answering
    // it as a decline would turn a misconfiguration into every Shopper being told their bank
    // said no, with nothing anywhere saying otherwise.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        status: 401,
        body: {
          error: { type: "invalid_request_error", message: "Invalid API Key provided." },
        },
      },
    });
    const payments = stripePayments({ secretKey: "sk_wrong", fetch: stripe.fetch });

    await expect(
      payments.charge(asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" })),
    ).rejects.toThrow(/Invalid API Key/);
  });

  it("declines an intent for a different amount from the one kobai is about to charge", async () => {
    // The loop ADR-0077 closes. The intent is created by a Project's route *before* the Shopper
    // is sent to their bank, and `place-order` works out the total at Capture from the lines,
    // their Adjustments and the tax — so a storefront that quoted wrong, or that started the
    // payment and then let the Cart change, sends the Shopper to pay 20.00 for a 25.00 basket.
    // Core would record the Order at its own total, and the books would balance against money
    // that never arrived.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("succeeded", { amount: 2000 }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const outcome = await payments.charge(
      asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" }),
    );

    expect(outcome).toEqual({
      ok: false,
      detail:
        "This payment is for 2000 MYR and this Order comes to 2500 MYR, so it was not taken. Ask `POST /store/carts/{id}/quote` for what the Cart comes to and start the payment for that.",
    });
  });

  it("declines an intent in a different currency, however right the number looks", async () => {
    // 2500 of one currency is not 2500 of another, and a comparison that only looked at the
    // number would take a payment in the wrong money and record the Order in kobai's.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("succeeded", { currency: "usd" }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.charge(asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" })),
    ).resolves.toEqual({
      ok: false,
      detail:
        "This payment is for 2500 USD and this Order comes to 2500 MYR, so it was not taken. Ask `POST /store/carts/{id}/quote` for what the Cart comes to and start the payment for that.",
    });
  });

  it("refuses before it confirms, so a mismatched card payment is never taken at all", async () => {
    // The check sits in front of the confirm rather than after it, which is the half that
    // decides whether this is a guard or a report: an intent still at `requires_confirmation`
    // is one whose money has *not* moved, so declining here leaves the Shopper unbilled instead
    // of billed and refunded.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("requires_confirmation", { amount: 9900 }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const outcome = await payments.charge(
      asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" }),
    );

    expect(outcome).toMatchObject({ ok: false });
    // Nothing was confirmed. The stub throws for a route no test named, so reaching the confirm
    // would have failed this differently — the assertion is here to say which fact is meant.
    expect(stripe.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /v1/payment_intents/pi_redirect",
    ]);
  });

  it("declines an intent Stripe described without an amount, rather than taking it on trust", async () => {
    // Not a shape Stripe produces, and that is the point: something answering for Stripe that
    // this Plugin cannot check is not something to confirm a payment against.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: { id: "pi_redirect", status: "succeeded" },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.charge(asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" })),
    ).resolves.toMatchObject({ ok: false });
  });

  it("declines when the order carried no PaymentIntent at all", async () => {
    const stripe = stripeStub({});
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const outcome = await payments.charge(asked({ somethingElse: "nope" }));

    // Named, because the person who has to act on this one is the Developer wiring the
    // storefront. And nothing was asked of Stripe: there was nothing to ask about.
    expect(outcome).toEqual({
      ok: false,
      detail:
        "This payment could not be found: no stripePaymentIntent was sent with the order.",
    });
    expect(stripe.calls).toEqual([]);
  });
});

describe("giving a payment back", () => {
  it("reverses the intent for what Core says was taken, once however often it is asked", async () => {
    // `refund` is called by `take-payment`'s compensation, which unwinds when a later Step
    // fails — and a compensation can be reached more than once for one purchase across a
    // retry. Stripe's `Idempotency-Key` is what makes the second ask return the first refund
    // rather than a second one, and it is derived from the payment so two different payments
    // can never share it.
    const stripe = stripeStub({
      "POST /v1/refunds": {
        body: { id: "re_1", amount: 2500, currency: "myr", status: "succeeded" },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await payments.refund({ reference: "pi_redirect", amount: 2500, currency: "MYR" });

    expect(stripe.calls).toEqual([
      {
        method: "POST",
        path: "/v1/refunds",
        authorization: "Bearer sk_test_123",
        idempotencyKey: "kobai-refund-pi_redirect",
        form: { payment_intent: "pi_redirect", amount: "2500" },
      },
    ]);
  });

  it("throws when Stripe will not give it back, so the failure travels as uncompensated", async () => {
    // The interface says `refund` throws if it could not refund, and ADR-0036 says that throw
    // is reported beside whatever stopped the run rather than in place of it. Swallowing it
    // would leave a Merchant holding money nobody knows about — which is the one thing this
    // Plugin's own table exists to make visible in the case Core cannot see.
    const stripe = stripeStub({
      "POST /v1/refunds": {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            code: "charge_already_refunded",
            message: "Charge ch_1 has already been refunded.",
          },
        },
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.refund({ reference: "pi_redirect", amount: 2500, currency: "MYR" }),
    ).rejects.toThrow(/already been refunded/);
  });
});

/**
 * The case this Plugin owns a table for, and the one ADR-0070 says to watch hardest: a hold
 * lapsed while the Shopper was in a banking app, the money left anyway, and kobai refused the
 * placement. Core answered that refusal and wrote nothing, so there is no Payment, no Order and
 * nothing of Core's to unwind — the whole account of that money is this Plugin's.
 *
 * The assertion is on the books rather than on the call. "The refund ran" and "the Shopper got
 * their money back, and a Merchant can find the row saying so" are two facts.
 */
const REFUNDED = {
  body: { id: "re_lapsed", amount: 2500, currency: "myr", status: "succeeded" },
};

describe("a confirmed payment whose placement was refused", () => {
  it("gives back the whole payment and records what it did in this Plugin's own table", async () => {
    const stripe = stripeStub({ "POST /v1/refunds": REFUNDED });
    await using kobai = await createTestKobai({ migrationSets: [stripeMigrationSet] });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await payments.refundUnplacedPayment({
      db: kobai.db,
      reference: "pi_lapsed",
      cartId: "cart-abcdef",
      refusal: "insufficient-stock",
    });

    // The books, asked of Postgres — a Merchant's account of money that arrived and produced
    // no Order, which lives here and in Stripe and nowhere else in kobai (ADR-0070).
    await expect(
      kobai.database.query(
        "select cart_id, payment_intent_id, refund_id, amount, currency, refusal from stripe_unplaced_refund",
      ),
    ).resolves.toEqual([
      {
        cart_id: "cart-abcdef",
        payment_intent_id: "pi_lapsed",
        refund_id: "re_lapsed",
        amount: 2500,
        currency: "MYR",
        refusal: "insufficient-stock",
      },
    ]);
    // No `amount` on the wire: the whole payment goes back, and what it came to is Stripe's
    // to say rather than a figure kobai would be guessing at — Core never took this one.
    expect(stripe.calls).toEqual([
      {
        method: "POST",
        path: "/v1/refunds",
        authorization: "Bearer sk_test_123",
        idempotencyKey: "kobai-unplaced-refund-pi_lapsed",
        form: {
          payment_intent: "pi_lapsed",
          "metadata[kobaiCartId]": "cart-abcdef",
          "metadata[kobaiRefusal]": "insufficient-stock",
        },
      },
    ]);
  });

  it("leaves one row and one refund when the return and the webhook both ask", async () => {
    // Both callers make the same kobai call and both can meet the same refusal (ADR-0070), so
    // both can arrive here — genuinely at once, which is why they are dispatched together
    // rather than one after the other. Stripe's idempotency key answers the second ask with
    // the first refund; the unique constraint and `onConflictDoNothing` keep the second from
    // becoming a second row claiming the same money went back twice. Either alone would leave
    // the books wrong.
    //
    // **Watched failing first**, the way this repository requires of anything that dispatches
    // at once: with `onConflictDoNothing` taken off the insert, this run failed on Postgres
    // `23505`, `duplicate key value violates unique constraint
    // "stripe_unplaced_refund_payment_intent_id_unique"`, `Key (payment_intent_id)=(pi_lapsed)
    // already exists` — so the two writes really did overlap and the second really did reach
    // the constraint. That recorded run is the whole of the proof: with the fix in, a request
    // that landed in the window and one that arrived after the other committed now answer
    // identically, so a green run can no longer show the window was reached. Changing how
    // these are dispatched obliges you to watch it fail again rather than to trust that it
    // still would.
    const stripe = stripeStub({ "POST /v1/refunds": REFUNDED });
    await using kobai = await createTestKobai({ migrationSets: [stripeMigrationSet] });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });
    const asking = {
      db: kobai.db,
      reference: "pi_lapsed",
      cartId: "cart-abcdef",
      refusal: "insufficient-stock",
    };

    const [first, second] = await Promise.all([
      payments.refundUnplacedPayment(asking),
      payments.refundUnplacedPayment(asking),
    ]);

    // Said as a defined string rather than as `first?.id === second?.id`, which two undefineds
    // would satisfy just as happily — the same non-assertion the empty-bag rule is about.
    expect(first.id).toEqual(expect.any(String));
    expect(second.id).toBe(first.id);
    await expect(
      kobai.database.query("select count(*)::int as rows from stripe_unplaced_refund"),
    ).resolves.toEqual([{ rows: 1 }]);
    expect(new Set(stripe.calls.map((call) => call.idempotencyKey))).toEqual(
      new Set(["kobai-unplaced-refund-pi_lapsed"]),
    );
  });

  it("writes nothing when Stripe would not give the money back", async () => {
    // A row here means the money went back. Writing one for a refund that failed would put a
    // Merchant's books further from Stripe's than having no row at all, which is the opposite
    // of what this table is for.
    const stripe = stripeStub({
      "POST /v1/refunds": {
        status: 402,
        body: {
          error: { type: "card_error", message: "This charge cannot be refunded." },
        },
      },
    });
    await using kobai = await createTestKobai({ migrationSets: [stripeMigrationSet] });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    await expect(
      payments.refundUnplacedPayment({
        db: kobai.db,
        reference: "pi_lapsed",
        cartId: "cart-abcdef",
        refusal: "insufficient-stock",
      }),
    ).rejects.toThrow(/cannot be refunded/);

    await expect(
      kobai.database.query("select count(*)::int as rows from stripe_unplaced_refund"),
    ).resolves.toEqual([{ rows: 0 }]);
  });
});
