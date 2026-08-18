import { describe, expect, it } from "vitest";
import {
  type AdjustedLines,
  type PaidOrder,
  type PricedLines,
  placeOrderWorkflow,
} from "../order/place-order.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { runWorkflow } from "../workflow/run.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import type { PaymentProvider, PaymentRequest, RefundRequest } from "./provider.ts";

/**
 * Money, through an interface Core defines and implements nowhere (ADR-0053).
 *
 * Everything here is asserted at the public HTTP seam, and everything about a **refund** is
 * asserted by asking the provider what it is holding — never by counting that a callback was
 * reached. A counter says the code ran; only the provider's books say the Shopper got their money
 * back, and those are two different facts (ADR-0036).
 *
 * Every provider in this file is written here rather than taken from the harness, deliberately.
 * `testPaymentProvider` exists so that a test about Adjustments does not have to think about
 * payment; these tests *are* about payment, and what a provider does is the thing under test.
 */

/**
 * A provider that keeps its books — what it took, and what it has since given back.
 *
 * `holds()` is the question worth asking: money it took and has not refunded. A test asserts on
 * that rather than on how many times anything was called, because "the compensation ran" and "the
 * Shopper is not out of pocket" are different statements and only the second one matters.
 */
function ledger(
  options: {
    /** Refuse every charge with this detail, as a provider declines a card. */
    readonly decline?: string;
    /** Fail every refund, as a provider whose own cleanup is broken (ADR-0036). */
    readonly refundFails?: string;
    /** Name the payment from what the storefront sent, the way a real adapter does. */
    readonly reference?: (request: PaymentRequest) => string;
  } = {},
) {
  const taken = new Map<string, { amount: number; currency: string }>();
  const givenBack = new Map<string, { amount: number; currency: string }>();
  let issued = 0;

  const provider = {
    name: "ledger",

    charge: async (request: PaymentRequest) => {
      if (options.decline) return { ok: false as const, detail: options.decline };

      issued += 1;
      const reference = options.reference?.(request) ?? `ledger-${issued}`;
      taken.set(reference, { amount: request.amount, currency: request.currency });
      return { ok: true as const, reference };
    },

    refund: async (payment: RefundRequest) => {
      if (options.refundFails) throw new Error(options.refundFails);
      givenBack.set(payment.reference, {
        amount: payment.amount,
        currency: payment.currency,
      });
    },
  } satisfies PaymentProvider;

  return {
    provider,
    /** What this provider took and has not given back — the Shopper's money, in its hands. */
    holds: () =>
      [...taken].filter(([reference]) => !givenBack.has(reference)).map(([, it]) => it),
    /** Everything it ever took, refunded or not. */
    charges: () => [...taken].map(([reference, it]) => ({ reference, ...it })),
    refunds: () => [...givenBack].map(([reference, it]) => ({ reference, ...it })),
  };
}

/**
 * A surcharge on the line and a discount on the Order, so the total charged is not the goods.
 *
 * Core attaches no Adjustment of its own, so a test about what gets charged has to wire the Step
 * that would — which is what a Plugin or a Project does (ADR-0022).
 */
const handling = defineStep(
  "handling-and-a-voucher",
  (input: PricedLines): AdjustedLines => ({
    cart: input.cart,
    lines: input.lines.map((line) => ({
      ...line,
      adjustments: [{ code: "handling", description: "Handling", amount: 200 }],
    })),
    adjustments: [{ code: "voucher", description: "Welcome voucher", amount: -500 }],
  }),
);

/** A Step of nobody's that declines — the shape a Project's own rule takes when it says no. */
function refuseWith(reason: string) {
  return defineStep(`refuses-with-${reason}`, (_paid: PaidOrder): PaidOrder => {
    throw new StepFailure(reason, "This Store is not taking Orders today.");
  });
}

/**
 * A Step that holds each run until two have reached it — a starting pistol for a race.
 *
 * Wired in front of `capture-order`, it puts both requests past `take-payment` before either can
 * write an Order, which is the state the unique index on `core_order.cart_id` exists to settle.
 * Neither the Cart nor the money is touched by it: it hands its input straight back.
 */
function bothHaveTakenPayment() {
  let arrived = 0;
  let open = () => {};
  const both = new Promise<void>((resolve) => {
    open = resolve;
  });

  return defineStep(
    "both-have-taken-payment",
    async (input: PaidOrder): Promise<PaidOrder> => {
      arrived += 1;
      if (arrived >= 2) open();
      await both;
      return input;
    },
  );
}

async function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

/** Nothing was written, which is the assertion behind every refusal in this file. */
async function ordersIn(kobai: TestKobai) {
  return kobai.database.query("select id from core_order");
}

describe("a Payment against an Order", () => {
  it("records what was taken, by whom, in the Order's own currency", async () => {
    const books = ledger();
    await using kobai = await createTestKobai({ payments: { provider: books.provider } });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      total: 2500,
      payment: {
        id: expect.any(String),
        provider: "ledger",
        // The provider's own handle on the money, stored and never parsed.
        reference: "ledger-1",
        amount: 2500,
        currency: "USD",
      },
    });
    // And the provider agrees about what it was asked for: the Order's total, once.
    expect(books.charges()).toEqual([
      { reference: "ledger-1", amount: 2500, currency: "USD" },
    ]);
  });

  it("charges the total the Order is written for, Adjustments and tax included", async () => {
    // The figure charged and the figure recorded are one expression rather than two, which is
    // what stops a Shopper being charged one number while their Order records another.
    const books = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: { "place-order": { steps: { "apply-adjustments": handling } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);
    const order = (await response.json()) as { total: number };

    // 1250 × 2 plus 200 of handling on the line, less the 500 voucher on the Order.
    expect(order.total).toBe(2200);
    expect(books.charges()).toEqual([
      { reference: "ledger-1", amount: 2200, currency: "USD" },
    ]);
  });

  it("reads back with the Order, so a confirmation and a reload agree", async () => {
    const books = ledger();
    await using kobai = await createTestKobai({ payments: { provider: books.provider } });
    const cart = await seedTestCart(kobai);

    const placed = (await (
      await place(kobai, cart.apiKey.headers, cart.id)
    ).json()) as Record<string, unknown> & { id: string };
    const read = await kobai.request(`/store/orders/${placed.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(read.status).toBe(200);
    const { workflow: _ran, ...record } = placed;
    await expect(read.json()).resolves.toEqual(record);
  });
});

/**
 * A provider that arranges the money instead of taking it — an invoice, a bank transfer, cash at
 * the counter. It is what the reference Project's `manual` one is, and the reason the Payment
 * record has to say which of the two happened.
 */
const invoiced: PaymentProvider = {
  name: "invoiced",
  charge: async () => ({ ok: true, reference: "INV-1", received: false }),
  refund: async () => {},
};

describe("a Payment says whether the money actually arrived", () => {
  it("records money taken as received, for a provider that says nothing about it", async () => {
    // `ok: true` has meant *the money moved* since the interface shipped, so a provider written
    // before this field existed keeps meaning that and needs no edit (ADR-0019).
    const books = ledger();
    await using kobai = await createTestKobai({ payments: { provider: books.provider } });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    await expect(response.json()).resolves.toMatchObject({
      payment: { provider: "ledger", received: true },
    });
  });

  it("records an arrangement as not received, so it is not read as a completed sale", async () => {
    await using kobai = await createTestKobai({ payments: { provider: invoiced } });
    const cart = await seedTestCart(kobai, { quantity: 2 });

    const placed = (await (await place(kobai, cart.apiKey.headers, cart.id)).json()) as {
      id: string;
    };
    const read = await kobai.request(`/store/orders/${placed.id}`, {
      headers: cart.apiKey.headers,
    });

    // The Order exists and is whole — the arrangement was made, and this is a sale. What it is
    // not is money in hand, and that is the one thing the record has to keep saying.
    await expect(read.json()).resolves.toMatchObject({
      total: 2500,
      payment: {
        provider: "invoiced",
        reference: "INV-1",
        amount: 2500,
        received: false,
      },
    });
    await expect(
      kobai.database.query("select received from core_payment"),
    ).resolves.toEqual([{ received: false }]);
  });
});

describe("what is never charged", () => {
  it("refuses a fraction of a penny before the money moves, not after", async () => {
    // Money is an integer count of the currency's minor unit, and a Step that produced a fraction
    // is a bug in this deployment's wiring. Charging it and refunding it would be a worse way to
    // find that out than never charging at all — so the check is in front of the provider, and
    // this asserts the provider was never asked rather than that it was asked and put back.
    const books = ledger();
    const aThirdOff = defineStep(
      "a-third-off-to-the-nearest-nothing",
      (input: PricedLines): AdjustedLines => ({
        cart: input.cart,
        lines: input.lines.map((line) => ({
          ...line,
          // 1250 / 3 is 416.66…, which no `bigint` column can hold and no Shopper can pay.
          adjustments: [
            {
              code: "a-third-off",
              description: "A third off",
              amount: -line.unitAmount / 3,
            },
          ],
        })),
        adjustments: [],
      }),
    );
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: { "place-order": { steps: { "apply-adjustments": aThirdOff } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(500);
    await expect(ordersIn(kobai)).resolves.toEqual([]);
    expect(books.charges()).toEqual([]);
  });
});

describe("a declined Payment", () => {
  it("leaves no Order at all, and says so at 402", async () => {
    const books = ledger({ decline: "The card was declined." });
    await using kobai = await createTestKobai({ payments: { provider: books.provider } });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      reason: "payment-declined",
      // What the provider said for itself, reaching the storefront unchanged.
      error: "The card was declined.",
      workflow: { name: "place-order", failed: "take-payment" },
    });
    // The point of taking payment before Capture: a refused card leaves nothing in the books.
    await expect(ordersIn(kobai)).resolves.toEqual([]);
    expect(books.holds()).toEqual([]);
  });

  it("leaves the Cart placeable, so a second card can be tried", async () => {
    // A Cart becomes exactly one Order (#102), and a declined payment did not make one — so the
    // Cart is not spent, and the Shopper is not sent back to build it again.
    const declining = ledger({ decline: "The card was declined." });
    await using kobai = await createTestKobai({
      payments: { provider: declining.provider },
    });
    const cart = await seedTestCart(kobai);

    expect((await place(kobai, cart.apiKey.headers, cart.id)).status).toBe(402);

    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });
    await expect(read.json()).resolves.toMatchObject({ placed: false, expired: false });
  });
});

describe("a Payment taken against a Capture that fails", () => {
  /** Capture, broken — the one Step this Workflow has no compensation for, made to fail. */
  const captureExplodes = defineStep("capture-explodes", (_paid: PaidOrder): never => {
    throw new Error("The Order could not be written.");
  });

  it("is refunded, and the provider is holding nothing afterwards", async () => {
    const books = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: { "place-order": { steps: { "capture-order": captureExplodes } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    // A broken Step is a bug rather than a decision, so it travels as one.
    expect(response.status).toBe(500);
    await expect(ordersIn(kobai)).resolves.toEqual([]);
    // The assertion the ticket is about, asked of the provider rather than of a counter: it
    // took 2500 and it is holding none of it.
    expect(books.charges()).toEqual([
      { reference: "ledger-1", amount: 2500, currency: "USD" },
    ]);
    expect(books.refunds()).toEqual([
      { reference: "ledger-1", amount: 2500, currency: "USD" },
    ]);
    expect(books.holds()).toEqual([]);
  });

  it("gives back exactly what was taken, not what the Cart says now", async () => {
    // The compensation is handed the very value its `run` was given (ADR-0036), so the refund is
    // for the figure that was actually charged — a Price edited in between changes nothing.
    const books = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: { "place-order": { steps: { "capture-order": captureExplodes } } },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [900] });
    const cart = await seedTestCart(kobai, { catalog, quantity: 3 });

    await place(kobai, cart.apiKey.headers, cart.id);

    expect(books.refunds()).toEqual([
      { reference: "ledger-1", amount: 2700, currency: "USD" },
    ]);
  });

  it("reports a refund that itself fails without replacing what stopped the run", async () => {
    // ADR-0036's two promises, at the seam a storefront sees them. A refusal still answers as
    // that refusal — the Shopper learns why they were turned away — and the fact that the money
    // could not be given back is the *other* fact, which the provider's books are what report.
    const books = ledger({ refundFails: "The refund endpoint is down." });
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: {
        "place-order": {
          before: { "capture-order": [refuseWith("closed-for-stocktaking")] },
        },
      },
    });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    // The refusal, intact: its own reason, its own status, and not the 500 a broken refund
    // would have turned it into.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "closed-for-stocktaking",
      workflow: { failed: "refuses-with-closed-for-stocktaking" },
    });
    await expect(ordersIn(kobai)).resolves.toEqual([]);
    // And the money really is still with the provider — which is why a counter would have been
    // the wrong assertion here: the compensation was reached and it did not work.
    expect(books.holds()).toEqual([{ amount: 1250, currency: "USD" }]);
  });

  it("names the slot it could not undo, beside the refusal rather than in place of it", async () => {
    // The Workflow seam, for the one fact a response body deliberately does not carry: a
    // storefront can do nothing about the Store's internal consistency and an operator must, so
    // `uncompensated` is on the run (ADR-0036). Reached through `runWorkflow` and the registry
    // `createKobai` publishes, which is the same pair a Step composing Workflows uses.
    const books = ledger({ refundFails: "The refund endpoint is down." });
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: {
        "place-order": {
          before: { "capture-order": [refuseWith("closed-for-stocktaking")] },
        },
      },
    });
    const cart = await seedTestCart(kobai);

    const run = await runWorkflow(
      placeOrderWorkflow,
      { cartId: cart.id },
      {
        db: kobai.db,
        metadata: {},
        workflows: kobai.workflows,
        paymentProvider: books.provider,
      },
    );

    expect(run.ok).toBe(false);
    if (run.ok) return;
    // Both facts, and neither replacing the other: why it was refused, and what was left undone.
    expect(run.reason).toBe("closed-for-stocktaking");
    expect(run.uncompensated.map((failure) => failure.slot)).toEqual(["take-payment"]);
    expect(books.holds()).toEqual([{ amount: 1250, currency: "USD" }]);
  });

  it("refunds the loser of a race for one Cart", async () => {
    // Two requests for one Cart get past `load-cart` together and the unique index on
    // `core_order.cart_id` settles it (#102) — so the loser has taken payment by the time
    // Capture refuses it. This is the one path where a deployment meets the refund without
    // anybody having wired a broken Step, and nothing else in this repository exercises it.
    //
    // The overlap is arranged rather than hoped for, the way the idempotency suite arranges its
    // own: a Step held in front of Capture until both requests have taken payment. Two requests
    // fired at once would *probably* interleave across their database round trips, and a test
    // that proves this only probably is a test that goes quiet on the day it stops.
    const books = ledger();
    await using kobai = await createTestKobai({
      payments: { provider: books.provider },
      workflows: {
        "place-order": { before: { "capture-order": [bothHaveTakenPayment()] } },
      },
    });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    const [first, second] = await Promise.all([
      place(kobai, cart.apiKey.headers, cart.id),
      place(kobai, cart.apiKey.headers, cart.id),
    ]);

    // Exactly one Order, and the loser told the same thing it would have been told a moment
    // earlier.
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const loser = first.status === 409 ? first : second;
    await expect(loser.json()).resolves.toMatchObject({ reason: "cart-placed" });
    await expect(ordersIn(kobai)).resolves.toHaveLength(1);

    // Both requests charged, and the provider is holding only the one that became an Order.
    expect(books.charges()).toHaveLength(2);
    expect(books.holds()).toEqual([{ amount: 1250, currency: "USD" }]);
  });
});

describe("a deployment with no Payment Provider", () => {
  it("boots, and serves its catalog and its Admin", async () => {
    // Refusing to boot is reserved for a database that cannot be migrated (ADR-0048). A Store
    // that cannot yet be bought from is still a Store worth reading.
    await using kobai = await createTestKobai({ payments: {} });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });

    const price = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
      headers: catalog.apiKey.headers,
    });
    const admin = await kobai.request("/admin/store", {
      headers: catalog.merchant.headers,
    });

    expect(price.status).toBe(200);
    expect(admin.status).toBe(200);
  });

  it("refuses to place an Order, by name", async () => {
    await using kobai = await createTestKobai({ payments: {} });
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "no-payment-provider",
      workflow: { name: "place-order", failed: "take-payment" },
    });
    await expect(ordersIn(kobai)).resolves.toEqual([]);
  });

  it("still builds and reads a Cart, so a storefront works right up to the money", async () => {
    await using kobai = await createTestKobai({ payments: {} });
    const cart = await seedTestCart(kobai, { quantity: 2 });

    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      lineItems: [{ quantity: 2 }],
    });
  });
});

/**
 * The two flows a real Store takes money with, both through the one interface.
 *
 * A card charged directly and a payment the Shopper completes at their bank differ in *when* the
 * Shopper authorises, not in what kobai does: either way the storefront sends what the provider
 * needs on the request that places the Order, and it arrives verbatim through ADR-0013's open
 * context. Neither needs a change to Core, which is the claim being asserted here rather than
 * described.
 *
 * **In the body, not the query string** (#121). Both halves of the open context reach a Step
 * identically and the query string is asserted elsewhere; what these two send is a credential,
 * and a query parameter is written to access logs, to proxy logs and into the `Referer` of
 * anything the confirmation page loads. So this is the shape a real storefront should copy.
 */
describe("what a storefront can send a provider", () => {
  it("hands a card token to a provider that charges directly", async () => {
    const cards = ledger({
      // A real adapter's first line: read my own key out of what the caller sent.
      reference: (request) => `card-${String(request.metadata.card_token)}`,
    });
    await using kobai = await createTestKobai({ payments: { provider: cards.provider } });
    const cart = await seedTestCart(kobai);

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({
        cartId: cart.id,
        metadata: { card_token: "tok_visa_4242" },
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      payment: { provider: "ledger", reference: "card-tok_visa_4242" },
    });
  });

  it("confirms an authorisation the Shopper completed at their bank", async () => {
    // The redirected flow — FPX, iDEAL, a 3-D Secure challenge. The Shopper goes to their bank
    // *before* the Order is placed and comes back with a reference; `charge` confirms it and
    // takes the money. The Cart was untouched while they were away, and it is still one request
    // that turns it into an Order.
    const bank = ledger({
      reference: (request) => {
        const authorisation = request.metadata.fpx_transaction;
        if (typeof authorisation !== "string") {
          throw new Error("A redirected payment arrives with its authorisation.");
        }
        return `fpx-${authorisation}`;
      },
    });
    await using kobai = await createTestKobai({ payments: { provider: bank.provider } });
    const catalog = await seedTestCatalog(kobai, { prices: [1250] });
    const cart = await seedTestCart(kobai, { catalog });

    const response = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({
        cartId: cart.id,
        metadata: { fpx_transaction: "FPX1700000001" },
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      payment: { reference: "fpx-FPX1700000001", amount: 1250 },
    });
    expect(bank.holds()).toEqual([{ amount: 1250, currency: "USD" }]);
  });
});
