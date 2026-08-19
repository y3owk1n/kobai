import { describe, expect, it } from "vitest";
import type { PaidOrder, ReservedLines } from "../order/place-order.ts";
import type { PaymentProvider } from "../payment/provider.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep, StepFailure } from "../workflow/step.ts";
import type {
  ReservableLine,
  ReservationClaim,
  ReservationProvider,
} from "./provider.ts";
import { MINIMUM_RESERVATION_HOLD_WINDOW_MS } from "./reservation.ts";

/**
 * A **Reservation** through the Workflow that makes one: held while an Order is being placed,
 * consumed inside the Capture transaction, released when anything after the hold fails
 * (ADR-0018, ADR-0027).
 *
 * Everything is asserted at the public HTTP seam and against what the database is holding
 * afterwards, because both halves matter and neither implies the other: a 201 with the stock
 * still on the shelf is an oversell waiting to happen, and a 409 with the stock gone is a Store
 * that has lost track of what it owns. The race that decides which of two Shoppers gets the last
 * one has a file of its own — `the-last-unit.test.ts` — because it is the ticket's whole point.
 */

describe("stock, while an Order is being placed", () => {
  it("is consumed at Capture, in the transaction the Order is written in", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // Three on the shelf, two sold, one left — and nothing still claimed, because the claim
    // became the Order rather than outliving it.
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 1,
      reserved: 0,
      available: 1,
    });
  });

  it("is recorded as a Reservation against the Order that consumed it", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placed = (await (await place(kobai, cart.apiKey.headers, cart.id)).json()) as {
      id: string;
    };

    // The record says who claimed what and how it ended, and it is one row whichever provider
    // made the claim — which is what lets Capacity arrive without a table of its own.
    const rows = await kobai.database.query<{
      provider: string;
      subject: string;
      quantity: string;
      order_id: string;
      consumed: boolean;
      released: boolean;
    }>(
      `select provider, subject, quantity::text as quantity, order_id,
              consumed_at is not null as consumed, released_at is not null as released
       from core_reservation`,
    );
    expect(rows).toEqual([
      {
        provider: "inventory",
        subject: catalog.variantId,
        quantity: "2",
        order_id: placed.id,
        consumed: true,
        released: false,
      },
    ]);
  });

  it("is not claimed at all for a Variant nobody is counting", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { quantity: 4 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(201);
    // An untracked Variant is not one with none left: it sells freely, and there is nothing to
    // hold, nothing to release and no row to sweep.
    await expect(reservationCount(kobai)).resolves.toBe(0);
  });

  it("refuses the Order when the Store does not have enough, and leaves the stock alone", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 1);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "insufficient-inventory",
      workflow: { name: "place-order", failed: "hold-reservations" },
    });
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 1,
      reserved: 0,
      available: 1,
    });
    await expect(orderCount(kobai)).resolves.toBe(0);
  });

  it("holds nothing when one line of a Cart cannot be held", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [900] }],
    });
    await countStock(kobai, catalog, catalog.variant("POSTER-A2").id, 5);
    await countStock(kobai, catalog, catalog.variant("MUG").id, 0);
    const cart = await seedTestCart(kobai, {
      catalog,
      lines: [{ sku: "POSTER-A2" }, { sku: "MUG" }],
    });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(409);
    // The poster is not left claimed for a Shopper who was told no. All of it or none of it,
    // because the alternative makes stock unsellable until the sweeper notices.
    await expect(
      stockOf(kobai, catalog, catalog.variant("POSTER-A2").id),
    ).resolves.toEqual({
      onHand: 5,
      reserved: 0,
      available: 5,
    });
  });

  it("is released by the Step's compensation when the Payment is declined", async () => {
    await using kobai = await createTestKobai({ payments: { provider: declining } });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    expect(response.status).toBe(402);
    // Held, then given back — the whole reason `hold-reservations` carries a compensation. A
    // Store that leaked two units on every declined card would be unsellable by lunchtime.
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 0,
      available: 3,
    });
    const [row] = await kobai.database.query<{ released: boolean; consumed: boolean }>(
      `select released_at is not null as released, consumed_at is not null as consumed
       from core_reservation`,
    );
    expect(row).toEqual({ released: true, consumed: false });
  });

  it("is released when a Step of nobody's refuses after the hold", async () => {
    await using kobai = await createTestKobai({
      workflows: { "place-order": { after: { "take-payment": [refuses] } } },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await place(kobai, cart.apiKey.headers, cart.id);

    // A Plugin's or a Project's own rule declining a purchase is the ordinary case the
    // compensation exists for, and it is not Core's refusal — so the stock has to come back
    // for a reason Core has never heard of.
    expect(response.status).toBe(422);
    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 0,
      available: 3,
    });
  });

  it("is held while the Order is in flight, so a Merchant cannot count it away", async () => {
    // The one place the intermediate state is observable through the public API: a hold is
    // `reserved`, and a Merchant setting a count below it is refused rather than quietly
    // overwriting a claim somebody is about to buy.
    await using kobai = await createTestKobai({
      workflows: { "place-order": { after: { "hold-reservations": [pause.step] } } },
    });
    const catalog = await seedTestCatalog(kobai);
    await countStock(kobai, catalog, catalog.variantId, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const placing = place(kobai, cart.apiKey.headers, cart.id);
    await pause.reached;

    await expect(stockOf(kobai, catalog, catalog.variantId)).resolves.toEqual({
      onHand: 3,
      reserved: 2,
      available: 1,
    });
    const refused = await countStock(kobai, catalog, catalog.variantId, 1);
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ reason: "stock-is-reserved" });

    pause.release();
    expect((await placing).status).toBe(201);
  });
});

/**
 * **How long a hold stands, and who decides it** (ADR-0075, on ADR-0050's shape).
 *
 * The seam is `createTestKobai`, which takes the same `kobai.config.ts` shape a Developer
 * writes — so these assert the deployment a Project actually gets rather than a function
 * called with an argument. What the window decided is read off the row it wrote, because
 * `expires_at` is the whole of what a hold's lifetime is: the sweeper compares that column
 * against `now()` and nothing else.
 */
describe("how long a hold stands", () => {
  it("is fifteen minutes for a Project that configures nothing", async () => {
    await using kobai = await createTestKobai();

    // The literal rather than the constant: a test that read the constant would agree with
    // any default at all, and this is the assertion that fifteen minutes is still what a
    // Project gets for free.
    await expect(holdWindowInMinutes(kobai)).resolves.toBe(15);
  });

  it("is what the Project set, when it set one", async () => {
    await using kobai = await createTestKobai({
      reservations: { holdWindowMs: 45 * 60_000 },
    });

    await expect(holdWindowInMinutes(kobai)).resolves.toBe(45);
  });
});

/**
 * **A hold window Core will not enforce stops the boot, and one it merely would not have
 * chosen does not** (ADR-0075).
 *
 * The seam is `createTestKobai`, which is `createKobai` with a database in front of it — so
 * these assert the very thing a Project's `server.ts` does on the way up. **Nothing is
 * clamped**: every refusal here is a boot that failed rather than a number quietly moved to
 * the nearest legal one.
 *
 * The last case is the one that carries a decision rather than a bound. Core keeps a floor and
 * **no ceiling**, because a hold is never renewed and so its window already is the bound —
 * unlike `session.idleWindowMs`, where the cap is the only thing standing between a stolen
 * token and forever. A test that only ever asked for reasonable numbers would pass just as
 * happily against a ceiling somebody added later.
 */
describe("a hold window Core will not enforce", () => {
  const bootWith = (holdWindowMs: number) =>
    createTestKobai({ reservations: { holdWindowMs } });

  it("is refused at zero, which is a hold that has lapsed before the payment starts", async () => {
    await expect(bootWith(0)).rejects.toThrow(/`reservations\.holdWindowMs`.*at least/s);
  });

  it("is refused when negative, rather than read as its absolute value", async () => {
    await expect(bootWith(-15 * 60_000)).rejects.toThrow(
      /`reservations\.holdWindowMs`.*at least.*-900000/s,
    );
  });

  it("is refused below the floor a placement needs", async () => {
    // Thirty seconds looks like a perfectly ordinary number and is one a placement can
    // overrun: taking payment happens inside the window, and a hold released from under its
    // own run fails Capture after the money has moved.
    await expect(bootWith(30_000)).rejects.toThrow(/at least 60000.*30000/s);
  });

  it("is refused when it is not a whole number of milliseconds", async () => {
    await expect(bootWith(900_000.5)).rejects.toThrow(
      /whole number of milliseconds.*900000\.5/s,
    );
  });

  it("is refused when it is not a number at all, which is what a bad environment gives", async () => {
    // `Number(process.env.KOBAI_HOLD_WINDOW_MS)` with the variable unset is `NaN`, and it
    // typechecks as a `number` all the way in. Left alone it puts an `Invalid Date` in
    // `expires_at`, which is a hold Postgres cannot compare and the sweeper never gives back.
    await expect(bootWith(Number("nonsense"))).rejects.toThrow(
      /whole number of milliseconds.*NaN/s,
    );
  });

  it("is accepted at the floor itself, so the bound is a bound and not an off-by-one", async () => {
    await using booted = await bootWith(MINIMUM_RESERVATION_HOLD_WINDOW_MS);

    await expect(holdWindowInMinutes(booted)).resolves.toBe(1);
  });

  it("is accepted far above anything Core would have chosen, because there is no ceiling", async () => {
    // A day. Nothing above a hold's window bounds it, because nothing renews a hold — so what
    // a long one costs is this Store's own stock left unsellable, which is the Merchant's
    // decision to make and not Core's (ADR-0075).
    await using booted = await bootWith(24 * 60 * 60_000);

    await expect(holdWindowInMinutes(booted)).resolves.toBe(24 * 60);
  });
});

/**
 * **What the compiler refuses to accept as a Reservation provider** (#127).
 *
 * `ReservationProvider` is not exported from `@kobai/core` and no config key takes one, so
 * nothing outside this package can hit either of these today — which is exactly why the
 * spelling was settled now rather than on the day the second provider is written. The
 * assertion is the `@ts-expect-error`, run by the `typecheck` step of the gate rather than by
 * vitest; the `expect` only keeps the block a test.
 */
describe("what could not have been a Reservation provider", () => {
  it("rejects one that demands more of a line than Core sends", () => {
    // Contravariance, and the reason all four operations are function-valued properties rather
    // than methods. The Capacity provider this interface exists to admit wants a period, and
    // under the method spelling it could have said so and been handed `undefined` — the honest
    // place for it is `line.metadata`, which is ADR-0013's open data.
    const capacity: ReservationProvider = {
      name: "capacity",
      // @ts-expect-error Core sends a `ReservableLine`, and a period is not on one.
      claimsFor: (_db, lines: readonly (ReservableLine & { period: string })[]) =>
        Promise.resolve(
          lines.map((line) => ({
            provider: "capacity",
            subject: line.period,
            quantity: line.quantity,
          })),
        ),
      hold: () => Promise.resolve({ ok: true }),
      consume: () => Promise.resolve(),
      release: () => Promise.resolve(),
    };

    expect(capacity).toBeDefined();
  });

  it("rejects one that demands more of a claim than Core hands back", () => {
    // The same mistake on the other three operations, which take what `claimsFor` produced: a
    // provider may not narrow what it is given back, because Core hands it the claims it
    // stored rather than the ones it was told about.
    const fussy: ReservationProvider = {
      name: "fussy",
      claimsFor: () => Promise.resolve([]),
      hold: () => Promise.resolve({ ok: true }),
      // @ts-expect-error Core stores a `ReservationClaim`; an expiry is not on one.
      consume: (_tx, _claims: readonly (ReservationClaim & { expiresAt: Date })[]) =>
        Promise.resolve(),
      release: () => Promise.resolve(),
    };

    expect(fussy).toBeDefined();
  });
});

/** The Payment Provider that says no, so the Step after the hold is the one that fails. */
const declining: PaymentProvider = {
  name: "declining",
  charge: async () => ({ ok: false, detail: "This card was declined." }),
  refund: async () => {},
};

/** A Step of nobody's, refusing with a reason Core has never heard of. */
const refuses = defineStep("refuses-after-payment", (_paid: PaidOrder): PaidOrder => {
  throw new StepFailure("not-today", "This Store is not taking Orders today.");
});

/** A Step that stops the run where a test wants to look at what the hold did. */
const pause = (() => {
  let reached = () => {};
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    step: defineStep("pause", async (input: ReservedLines): Promise<ReservedLines> => {
      reached();
      await held;
      return input;
    }),
    reached: arrived,
    release: () => {
      release();
    },
  };
})();

async function place(kobai: TestKobai, headers: Record<string, string>, cartId: string) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId }),
  });
}

/** What a Merchant says the Store has — through the API, like everything else here. */
async function countStock(
  kobai: TestKobai,
  catalog: TestCatalog,
  variantId: string,
  onHand: number,
) {
  return kobai.request(`/admin/variants/${variantId}/inventory`, {
    method: "PUT",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
}

/** What the Store believes it has, read the way a Merchant reads it. */
async function stockOf(kobai: TestKobai, catalog: TestCatalog, variantId: string) {
  const response = await kobai.request(`/admin/products/${catalog.productId}`, {
    headers: catalog.merchant.headers,
  });
  const product = (await response.json()) as {
    variants: readonly {
      id: string;
      inventory: { onHand: number; reserved: number; available: number } | null;
    }[];
  };
  const found = product.variants.find((variant) => variant.id === variantId)?.inventory;
  // The three numbers, without the identifier the test already named — so a failure reads as
  // what the Store has rather than as a uuid nobody was asking about.
  return found === null || found === undefined
    ? found
    : { onHand: found.onHand, reserved: found.reserved, available: found.available };
}

/**
 * The window the hold this deployment takes is written with, to the nearest minute.
 *
 * A hold's `expires_at` is fixed as the row is written — `now` plus the window — so
 * subtracting the instant just before the placement recovers the window plus however long the
 * placement took, which is a few hundred milliseconds against a window measured in minutes.
 * Rounding to a minute is what lets the assertion be the number a Project wrote rather than a
 * tolerance nobody chose; every window this file configures is a whole number of minutes, and
 * so is the floor Core enforces.
 *
 * It reads the column rather than a response body because nothing on the HTTP surface reports
 * a hold's deadline yet — the route that will is the next ticket of this spec.
 */
async function holdWindowInMinutes(kobai: TestKobai): Promise<number> {
  const catalog = await seedTestCatalog(kobai);
  await countStock(kobai, catalog, catalog.variantId, 3);
  const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

  const before = Date.now();
  const placed = await place(kobai, cart.apiKey.headers, cart.id);
  expect(placed.status).toBe(201);

  // Through `text`, because a `numeric` arrives from pg as a string anyway and an implicit
  // conversion is a place for a rounding nobody asked for to hide.
  const rows = await kobai.database.query<{ expires_ms: string }>(
    `select (extract(epoch from expires_at) * 1000)::text as expires_ms
     from core_reservation`,
  );
  const [row] = rows;
  if (!row) throw new Error("The placement wrote no Reservation to read a window off.");
  expect(rows).toHaveLength(1);

  return Math.round((Number(row.expires_ms) - before) / 60_000);
}

async function reservationCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ id: string }>(
    "select id from core_reservation",
  );
  return rows.length;
}

async function orderCount(kobai: TestKobai): Promise<number> {
  const rows = await kobai.database.query<{ id: string }>("select id from core_order");
  return rows.length;
}
