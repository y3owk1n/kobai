import { createHmac } from "node:crypto";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "@kobai/core/testing";
import { STRIPE_PAYMENT_INTENT_KEY, stripePayments } from "@kobai/plugin-stripe";
import { describe, expect, it } from "vitest";
import config from "../../kobai.config.ts";
import { createAdminAssets } from "../admin-assets.ts";
import { createProjectFetch, type ProjectFetch } from "../app.ts";
import { createRedirectPaymentRoutes, idempotencyKeyFor } from "./redirect.ts";
import { stripeRedirectPayments } from "./stripe.ts";
import { createStripeWebhookRoute, STRIPE_WEBHOOK_PATH } from "./stripe-webhook.ts";

/**
 * **`/webhooks/stripe` — this Project's route, verified by this Project** (ADR-0070).
 *
 * A Plugin cannot add a route — routes are not one of ADR-0003's five Extension Points — and
 * here that is the right shape rather than a limitation: the signature, the logging, and
 * whatever a bank does that nobody anticipated are the deployment's to own. What is asserted
 * below is what a Shopper and the books end up with — an Order, no Order, money given back —
 * and never that a handler was reached.
 *
 * **Nothing here reaches Stripe.** The Plugin's whole contact with the network is one `fetch`,
 * so the stub stands in for Stripe's API, and every signature is made with the same kind of
 * `whsec_…` a deployment holds. The gate has no Stripe secret and must never acquire one.
 */

const WEBHOOK_SECRET = "whsec_test_123";
const PAYMENT_PAGE = "https://storefront.test/checkout/pay";
/** The PaymentIntent every payment below is, written the way Stripe writes one. */
const INTENT = "pi_3Redirect";
const INTENT_ROUTE = `GET /v1/payment_intents/${INTENT}`;

type StripeAnswer = { readonly status?: number; readonly body: unknown };

/**
 * Stripe, as a router a test fills in — a route nothing answered throws rather than reaching
 * the network, which is what makes "this called Stripe" impossible to mistake for a pass.
 */
function stripeStub(answers: Record<string, StripeAnswer>) {
  const calls: { method: string; path: string }[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    calls.push({ method: request.method, path: pathname });

    const answer = answers[`${request.method} ${pathname}`];
    if (answer === undefined) {
      throw new Error(
        `This test stubbed ${Object.keys(answers).join(", ") || "nothing"} and something called ${request.method} ${pathname}.`,
      );
    }
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };

  return { fetch, calls };
}

/** A PaymentIntent as Stripe reports one for a Cart, at what kobai says that Cart comes to. */
function succeededIntent(cartId: string, amount: number) {
  return {
    id: INTENT,
    status: "succeeded",
    amount,
    currency: "myr",
    metadata: { kobaiCartId: cartId },
  };
}

/** The event Stripe posts once the money has left the Shopper's bank. */
function succeededEvent(intent: Record<string, unknown>) {
  return { id: "evt_1", type: "payment_intent.succeeded", data: { object: intent } };
}

/**
 * A request signed the way Stripe signs one: `t=…,v1=…`, over the **bytes that were sent**.
 *
 * Taken over the payload text rather than over the object, because that is the only thing a
 * verification can be about — a body re-serialised from parsed JSON is a different string, and
 * a route that signed *that* would accept a tampered one.
 */
function signed(
  body: unknown,
  { secret = WEBHOOK_SECRET, at = Date.now() }: { secret?: string; at?: number } = {},
): Request {
  const payload = JSON.stringify(body);
  const timestamp = Math.floor(at / 1000);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return webhook(payload, `t=${timestamp},v1=${signature}`);
}

function webhook(payload: string, signature?: string): Request {
  return new Request(`http://kobai.test${STRIPE_WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === undefined ? {} : { "stripe-signature": signature }),
    },
    body: payload,
  });
}

type AStoreOnStripe = {
  readonly kobai: TestKobai;
  readonly fetch: ProjectFetch;
  readonly cartId: string;
  /** What Stripe answers, filled in once the Cart it is about exists. */
  readonly stripeAnswers: Record<string, StripeAnswer>;
  /** Every call something made to Stripe, in order. */
  readonly stripeCalls: { method: string; path: string }[];
  /** Every kobai request this Project's own routes made, in order, exactly as it was sent. */
  readonly askedKobai: { url: string; headers: Headers; body: string }[];
  readonly variantId: string;
  readonly merchantHeaders: Record<string, string>;
};

/**
 * The reference Project as a deployment that has been given Stripe's three settings: the
 * Plugin's provider wired for Core, its redirect routes and its webhook mounted, one Cart
 * waiting to be paid for.
 */
async function aStoreOnStripe(): Promise<AStoreOnStripe> {
  const stripeAnswers: Record<string, StripeAnswer> = {};
  const stripe = stripeStub(stripeAnswers);
  // One object is the bank and the Payment Provider, which it has to be: the thing that
  // starts a payment and the thing kobai asks to confirm it are the same system, or `charge`
  // is confirming somebody else's money.
  const provider = stripePayments({ secretKey: "sk_test_123", fetch: stripe.fetch });
  const kobai = await createTestKobai({ ...config, payments: { provider } });

  const catalog = await seedTestCatalog(kobai);
  const cart = await seedTestCart(kobai, { catalog });

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

  const bank = stripeRedirectPayments({
    stripe: provider,
    db: kobai.db,
    paymentPageUrl: PAYMENT_PAGE,
  });
  const payments = createRedirectPaymentRoutes({
    kobai: { fetch: watched },
    apiKey: catalog.apiKey.key,
    payments: bank,
  });

  return {
    kobai,
    cartId: cart.id,
    stripeAnswers,
    stripeCalls: stripe.calls,
    askedKobai,
    variantId: catalog.variantId,
    merchantHeaders: catalog.merchant.headers,
    fetch: createProjectFetch(
      { fetch: kobai.fetch },
      createAdminAssets(),
      payments,
      createStripeWebhookRoute({
        secret: WEBHOOK_SECRET,
        // The Plugin says which payment an event is about; this Project's own routes settle
        // it, through the very call the Shopper's return makes.
        referenceOf: bank.referenceOfCallback,
        settle: payments.settle,
      }),
    ),
  };
}

describe("a bank that answers this Project rather than the Shopper's browser", () => {
  it("places the Order the Shopper never came back for", async () => {
    // The ordinary case in Malaysia, and the whole reason this route exists: the Shopper
    // authorises in their banking app and closes the tab, so nothing but this ever calls
    // `POST /store/orders`. One cent, because this Project also replaced its pricing rule.
    const store = await aStoreOnStripe();
    await using kobai = store.kobai;
    const intent = succeededIntent(store.cartId, 1);
    store.stripeAnswers[INTENT_ROUTE] = { body: intent };

    const response = await store.fetch(signed(succeededEvent(intent)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settled: "placed",
      cartId: store.cartId,
      reference: INTENT,
    });
    // The Payment record says which system holds this money and that it arrived — Stripe's
    // own PaymentIntent, `received` because a redirect method has already taken it.
    await expect(
      kobai.database.query("select provider, reference, received from core_payment"),
    ).resolves.toEqual([{ provider: "stripe", reference: INTENT, received: true }]);
  });

  it("makes the same kobai call the Shopper's return would have made", async () => {
    // The property that makes the two callers one intention rather than two (ADR-0070): the
    // `Idempotency-Key` is derived from the reference and from nothing else, and the
    // reference travels on the **body** half of the open context rather than in a query
    // string, where it would reach access logs and a `Referer` (#138). #102 does the rest.
    //
    // **Under the key the Plugin reads**, which is the provider's to name: kobai passes the
    // open context to a Payment Provider verbatim, so a Project sending its own key would
    // place every Order with no reference on it — `payment-declined`, for money that has
    // already left the Shopper's bank.
    const store = await aStoreOnStripe();
    await using _kobai = store.kobai;
    const intent = succeededIntent(store.cartId, 1);
    store.stripeAnswers[INTENT_ROUTE] = { body: intent };

    await store.fetch(signed(succeededEvent(intent)));

    const placed = store.askedKobai.find((asked) => asked.url.endsWith("/store/orders"));
    expect(placed?.headers.get("idempotency-key")).toBe(idempotencyKeyFor(INTENT));
    expect(JSON.parse(placed?.body ?? "{}")).toEqual({
      cartId: store.cartId,
      metadata: { [STRIPE_PAYMENT_INTENT_KEY]: INTENT },
    });
    expect(placed?.url).not.toContain(INTENT);
  });

  it("places nothing at all when the signature does not verify", async () => {
    // Somebody who can post a `payment_intent.succeeded` at this route without the signing
    // secret can buy a Store's stock with a Cart they built themselves. So the signature is
    // checked before anything else happens — before the body is parsed, before Stripe is
    // asked about the payment, and before kobai hears about any of it.
    const store = await aStoreOnStripe();
    await using kobai = store.kobai;
    store.stripeAnswers[INTENT_ROUTE] = { body: succeededIntent(store.cartId, 1) };

    const response = await store.fetch(
      signed(succeededEvent(succeededIntent(store.cartId, 1)), {
        secret: "whsec_forged",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "signature-invalid" });
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    // Nothing was asked of Stripe and nothing of kobai: an unverified request is not a
    // request this Project acts on in any degree.
    expect(store.stripeCalls).toEqual([]);
    expect(store.askedKobai).toEqual([]);
  });

  it("refuses a body that was changed after it was signed", async () => {
    // The signature is over the bytes, so a valid signature for one payload does not carry
    // to another — this is the same forgery as above, arriving with a real signature.
    const store = await aStoreOnStripe();
    await using kobai = store.kobai;
    const honest = signed(succeededEvent(succeededIntent("cart-somebody-elses", 1)));

    const tampered = webhook(
      JSON.stringify(succeededEvent(succeededIntent(store.cartId, 1))),
      honest.headers.get("stripe-signature") ?? "",
    );
    const response = await store.fetch(tampered);

    expect(response.status).toBe(400);
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("refuses a signature too old to be this request's, and one that is missing entirely", async () => {
    // Stripe signs a timestamp alongside the payload precisely so that a captured request
    // cannot be replayed later. Five minutes is the tolerance Stripe's own libraries take.
    const store = await aStoreOnStripe();
    await using kobai = store.kobai;
    const intent = succeededIntent(store.cartId, 1);

    const stale = await store.fetch(
      signed(succeededEvent(intent), { at: Date.now() - 10 * 60 * 1000 }),
    );
    const unsigned = await store.fetch(webhook(JSON.stringify(succeededEvent(intent))));

    expect(stale.status).toBe(400);
    await expect(stale.json()).resolves.toMatchObject({ reason: "signature-invalid" });
    expect(unsigned.status).toBe(400);
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });

  it("acknowledges an event about money this Store did not take, and settles nothing", async () => {
    // A Merchant's Stripe account holds payments kobai never started, and the endpoint is
    // told about all of them. Acknowledged rather than refused, because a 4xx is Stripe's
    // signal to try again — and it would try again for three days about a payment that will
    // never be any of kobai's business.
    const store = await aStoreOnStripe();
    await using kobai = store.kobai;

    const response = await store.fetch(
      signed(succeededEvent({ id: "pi_elsewhere", status: "succeeded", metadata: {} })),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ settled: "nothing" });
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    expect(store.askedKobai).toEqual([]);
  });

  it("gives the money back when kobai will not place the Order, and does not ask Stripe to try again", async () => {
    // The one case in the whole design that would otherwise take money and give no goods: a
    // hold lapses while the Shopper is in their banking app, the funds have already left at
    // the bank, and kobai refuses and writes nothing. The Plugin made the payment and the
    // Plugin reverses it, into its own table (ADR-0004, ADR-0070) — and the webhook is
    // *acknowledged*, because retrying would not make the stock exist.
    const store = await aStoreOnStripe();
    await using kobai = store.kobai;
    const intent = succeededIntent(store.cartId, 1);
    store.stripeAnswers[INTENT_ROUTE] = { body: intent };
    store.stripeAnswers["POST /v1/refunds"] = {
      body: { id: "re_1", amount: 1, currency: "myr" },
    };

    // The shelf goes empty while the Shopper is away, which is what a lapsed hold leaves
    // this purchase meeting. A Merchant counting stock is arrangement like any other.
    const counted = await kobai.request(`/admin/variants/${store.variantId}/inventory`, {
      method: "PUT",
      headers: { ...store.merchantHeaders, "content-type": "application/json" },
      body: JSON.stringify({ onHand: 0 }),
    });
    expect(counted.status, "emptying the shelf").toBe(200);

    const response = await store.fetch(signed(succeededEvent(intent)));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settled: "refunded",
      reason: "insufficient-inventory",
    });
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
    // The books, rather than the fact that a callback ran.
    await expect(
      kobai.database.query(
        "select payment_intent_id, amount, currency, refusal from stripe_unplaced_refund",
      ),
    ).resolves.toEqual([
      {
        payment_intent_id: INTENT,
        amount: 1,
        currency: "MYR",
        refusal: "insufficient-inventory",
      },
    ]);
  });
});
