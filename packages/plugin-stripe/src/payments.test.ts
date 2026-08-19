import type { PaymentRequest } from "@kobai/core";
import { createTestKobai } from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { stripeMigrationSet } from "./migration-set.ts";
import {
  cartIdOfPaymentIntent,
  STRIPE_PAYMENT_INTENT_KEY,
  stripePayments,
} from "./payments.ts";

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
function asked(
  metadata: Record<string, unknown>,
  overrides: Partial<PaymentRequest> = {},
): PaymentRequest {
  return { amount: 2500, currency: "MYR", shopper: null, metadata, ...overrides };
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

  it("refuses an intent that is not for what this Order comes to", async () => {
    // The intent is created by a route the **Project** owns, from a Cart a browser named, and
    // it arrives back here as an opaque string on the open context. Nothing but this compares
    // it against the figure Core is about to write the Order for — so without it a storefront
    // bug, or a caller who kept an old intent, buys an expensive Cart for a cheap payment.
    const stripe = stripeStub({
      "GET /v1/payment_intents/pi_redirect": {
        body: intent("succeeded", { amount: 100 }),
      },
    });
    const payments = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });

    const outcome = await payments.charge(
      asked({ [STRIPE_PAYMENT_INTENT_KEY]: "pi_redirect" }),
    );

    expect(outcome).toEqual({
      ok: false,
      detail: "This payment is for 100 MYR and this order comes to 2500 MYR.",
    });
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
    // both can arrive here. Stripe's idempotency key answers the second ask with the first
    // refund; the unique constraint keeps the second from becoming a second row claiming the
    // same money went back twice. Either alone would leave the books wrong.
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

    expect(second?.id).toBe(first?.id);
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
