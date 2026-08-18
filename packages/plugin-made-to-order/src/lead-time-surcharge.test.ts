import type { Kobai, KobaiProjectConfig, PaymentProvider } from "@kobai/core";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCart,
  type TestCatalog,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import {
  LEAD_TIME_DAYS_KEY,
  LEAD_TIME_SURCHARGE_CODE,
  leadTimeSurcharge,
  MADE_TO_ORDER_TERMS,
} from "./lead-time-surcharge.ts";
import { madeToOrderMigrationSet } from "./migration-set.ts";
import { madeToOrder } from "./strategy.ts";

/**
 * ADR-0013's scenario, end to end, for the first time.
 *
 * The open Workflow context has been proven since the walking skeleton — what a caller sends
 * arrives verbatim and Core reads no key out of it — but the thing it was opened *for* has
 * never existed, because ADR-0022 makes a Lead Time surcharge an **Adjustment** and there were
 * no Adjustments to make. These tests are that scenario closed: a storefront asks for something
 * sooner than usual, a Step this Plugin offers reads a number Core has never modelled, and a row
 * lands on the Order saying what the hurry cost.
 *
 * **The assertion is always the Order.** A mechanism that produced a log line would have proved
 * nothing, so every test here reads the Adjustment back through the API a storefront calls.
 */

/** What the reference Project wires, and what every test here boots with (ADR-0017). */
const wiredHere: KobaiProjectConfig = {
  migrationSets: [madeToOrderMigrationSet],
  fulfilment: { strategies: { "made-to-order": madeToOrder } },
  workflows: { "place-order": { steps: { "apply-adjustments": leadTimeSurcharge } } },
};

/** Something this Store makes rather than stocks, at the usual 1250. */
function aCommission(kobai: Kobai): Promise<TestCatalog> {
  return seedTestCatalog(kobai, {
    variants: [{ sku: "COMMISSION", fulfilmentStrategy: "made-to-order" }],
  });
}

/**
 * Placing a Cart, asking for it in `leadTimeDays` days.
 *
 * The lead time goes in the **query string**, which is the whole of how the open context is
 * filled today — `openMetadata(url)` is `Object.fromEntries(url.searchParams)`, so a body would
 * reach no Step at all (#121). That is a limitation of the transport rather than of this
 * Plugin, and this is where a test has to live with it.
 */
function place(kobai: Kobai, cart: TestCart, leadTimeDays?: string): Promise<Response> {
  const path =
    leadTimeDays === undefined
      ? "/store/orders"
      : `/store/orders?${LEAD_TIME_DAYS_KEY}=${encodeURIComponent(leadTimeDays)}`;

  return kobai.request(path, {
    method: "POST",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId: cart.id }),
  });
}

/** As much of a placed Order as these tests read. */
type PlacedOrder = {
  readonly id: string;
  readonly total: number;
  readonly lineItems: readonly {
    readonly sku: string;
    readonly unitAmount: number;
    readonly total: number;
    readonly adjustments: readonly {
      readonly code: string;
      readonly description: string;
      readonly amount: number;
      readonly metadata: Record<string, unknown>;
    }[];
  }[];
  readonly adjustments: readonly { readonly code: string }[];
};

/** Seven days saved on one 1250 commission: 7 × 500. */
const SEVEN_DAYS_SAVED = 3500;

describe("the Step this Plugin offers", () => {
  it("puts the Lead Time surcharge on the Order as an Adjustment of its own", async () => {
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    const response = await place(kobai, cart, "3");

    expect(response.status).toBe(201);
    const order = (await response.json()) as PlacedOrder;
    // Its own line, never folded into what the goods cost (ADR-0022): `unitAmount` still says
    // 1250, and the surcharge sits beside it saying why the line came to more.
    expect(order.lineItems).toMatchObject([
      {
        sku: "COMMISSION",
        unitAmount: 1250,
        adjustments: [
          {
            code: LEAD_TIME_SURCHARGE_CODE,
            description: "Made to order in 3 days rather than 10.",
            amount: SEVEN_DAYS_SAVED,
            metadata: { requestedLeadTimeDays: 3, daysSaved: 7 },
          },
        ],
        total: 1250 + SEVEN_DAYS_SAVED,
      },
    ]);
    // On the line rather than on the Order, because the hurry belongs to the thing being
    // hurried — a Return for that line refunds both.
    expect(order.adjustments).toEqual([]);
    expect(order.total).toBe(1250 + SEVEN_DAYS_SAVED);
  });

  it("is a row rather than an answer, and reads back the same", async () => {
    // The Adjustment is on the Order, so it survives the request that made it — which is the
    // difference between a mechanism that worked and a mechanism that produced a log line.
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });
    const placed = (await (await place(kobai, cart, "3")).json()) as PlacedOrder;

    const read = await kobai.request(`/store/orders/${placed.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      lineItems: [{ adjustments: [{ amount: SEVEN_DAYS_SAVED }] }],
      total: 1250 + SEVEN_DAYS_SAVED,
    });
  });

  it("charges for every unit being hurried, not for the line", async () => {
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const order = (await (await place(kobai, cart, "8")).json()) as PlacedOrder;

    // Two days saved, two of them: 2 × 500 × 2.
    expect(order.lineItems).toMatchObject([{ adjustments: [{ amount: 2000 }] }]);
    expect(order.total).toBe(2 * 1250 + 2000);
  });

  it("leaves alone the lines whose Strategy has no Lead Time", async () => {
    // A mixed Cart, which is the case ADR-0014 says Fulfilment exists for. The Step asks the
    // answer Core carried on each line rather than the Strategy's *name* — a Strategy is named
    // by the key a Project wired it under, so this Plugin does not know what it is called.
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "COMMISSION", fulfilmentStrategy: "made-to-order" },
        { sku: "POSTER-A2" },
      ],
    });
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "COMMISSION" }, { sku: "POSTER-A2" }],
    });

    const order = (await (await place(kobai, cart, "3")).json()) as PlacedOrder;

    expect(order.lineItems).toMatchObject([
      { sku: "COMMISSION", adjustments: [{ amount: SEVEN_DAYS_SAVED }] },
      // The poster is on a shelf already. There is no hurry to charge for.
      { sku: "POSTER-A2", adjustments: [], total: 1250 },
    ]);
    expect(order.total).toBe(2 * 1250 + SEVEN_DAYS_SAVED);
  });

  it("charges nothing when nobody asked for anything sooner", async () => {
    // The ordinary case, and it must cost nothing: every other Cart in every other deployment
    // sends no such key, and this Step is what stands where Core's `apply-adjustments` did.
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    const order = (await (await place(kobai, cart)).json()) as PlacedOrder;

    expect(order.lineItems).toMatchObject([{ adjustments: [], total: 1250 }]);
    expect(order.total).toBe(1250);
  });

  it("charges nothing for a Shopper content to wait the usual time", async () => {
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    const order = (await (
      await place(kobai, cart, String(MADE_TO_ORDER_TERMS.standardLeadTimeDays + 4))
    ).json()) as PlacedOrder;

    expect(order.lineItems).toMatchObject([{ adjustments: [] }]);
    expect(order.total).toBe(1250);
  });

  it("refuses a Lead Time it cannot read, with its own reason", async () => {
    // A refusal from a Plugin's Step reaches the caller as itself — Core has never heard of
    // this reason and answers it with the status it gives anything it does not know. Ignoring
    // the value instead would deliver late and charge nothing for it.
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    const response = await place(kobai, cart, "soon");

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "lead-time-not-understood",
      workflow: { failed: "apply-adjustments" },
    });
    // And no Order at all: the refusal is in front of the money and in front of Capture.
    await expect(kobai.database.query("select id from core_order")).resolves.toEqual([]);
  });
});

describe("the table this Plugin owns", () => {
  it("records what was asked for, which is the half Core does not keep", async () => {
    await using kobai = await createTestKobai(wiredHere);
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    await place(kobai, cart, "3");

    // The Order holds what was charged. This holds what was requested and the terms it was
    // priced under — neither of which Core models, and neither of which the amount can be
    // worked back to once the terms change.
    await expect(
      kobai.database.query(
        "select cart_id, variant_id, requested_lead_time_days, standard_lead_time_days, amount, currency from made_to_order_surcharge",
      ),
    ).resolves.toEqual([
      {
        cart_id: cart.id,
        variant_id: catalog.variantId,
        requested_lead_time_days: 3,
        standard_lead_time_days: MADE_TO_ORDER_TERMS.standardLeadTimeDays,
        amount: SEVEN_DAYS_SAVED,
        currency: "USD",
      },
    ]);
  });

  it("keeps nothing for a placement that failed after it ran", async () => {
    // ADR-0036's unwinding, with money in it. `take-payment` runs after this Step, so a decline
    // means this run's rows describe a surcharge nobody was charged — and the compensation Core
    // calls is what takes them back. Asked of the database rather than of a counter: "the
    // callback ran" and "the row is gone" are two different facts.
    await using kobai = await createTestKobai({
      ...wiredHere,
      payments: { provider: declines },
    });
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    const response = await place(kobai, cart, "3");

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({ reason: "payment-declined" });
    await expect(
      kobai.database.query("select id from made_to_order_surcharge"),
    ).resolves.toEqual([]);
  });
});

describe("an installed Plugin does nothing until the Project wires it", () => {
  it("charges no surcharge when the Step is not in the Workflow", async () => {
    // The same deployment, the same installed Plugin, the same wired table and the same wired
    // Strategy — with one entry taken out of `kobai.config.ts`. A Shopper asks for it in three
    // days and pays the ordinary price (ADR-0017).
    await using kobai = await createTestKobai({ ...wiredHere, workflows: {} });
    const catalog = await aCommission(kobai);
    const cart = await seedTestCart(kobai, { catalog });

    const order = (await (await place(kobai, cart, "3")).json()) as PlacedOrder;

    expect(order.lineItems).toMatchObject([{ adjustments: [] }]);
    expect(order.total).toBe(1250);
    await expect(
      kobai.database.query("select id from made_to_order_surcharge"),
    ).resolves.toEqual([]);
  });
});

/** A provider that takes nothing, so that a later Step fails with this Step's rows written. */
const declines: PaymentProvider = {
  name: "declines-everything",
  charge: async () => ({ ok: false, detail: "This card was declined." }),
  refund: async () => {},
};
