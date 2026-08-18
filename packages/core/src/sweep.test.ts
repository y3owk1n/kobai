import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { ReservedLines } from "./order/place-order.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
  type TestKobaiOptions,
} from "./testing/index.ts";
import { defineStep } from "./workflow/step.ts";

/**
 * **The sweeper** — the one piece of background work kobai has, on a plain interval rather than
 * on ADR-0026's job queue.
 *
 * A queue brings retries, visibility windows and a failure model of its own and deserves the spec
 * it has not had yet; a sweep is one statement on a timer, and it either ran or it will run again
 * in a minute. The accepted cost is that this is kobai's first background work outside the job
 * mechanism, and the queue spec will have to migrate it (#98).
 *
 * **Time is passed by winding rows back, never by waiting.** A hold lasts fifteen minutes and an
 * idempotency key a day, so a test that waited for either to lapse would be the slowest in the
 * repository and the least honest — the helpers at the foot of `auth.test.ts` are the prior art.
 * The one thing that is waited *for* is the interval, in the one test whose subject is the timer.
 */

/**
 * A Step that never finishes — a placement whose process died between holding and Capture.
 *
 * The state the sweeper exists for, and the only honest way to arrange it through the public API:
 * a Step that *refused* would run the compensation, which is the other way a hold ends and is
 * already asserted in `reservation/reservation.test.ts`. This one leaves the units claimed, the
 * row written, and nobody coming back for either.
 */
const neverFinishes = defineStep(
  "never-finishes",
  (_held: ReservedLines): Promise<ReservedLines> => new Promise(() => {}),
);

/** A deployment whose placements hang after the hold, so a hold can be found abandoned. */
const abandonsItsHolds: TestKobaiOptions = {
  workflows: { "place-order": { after: { "hold-reservations": [neverFinishes] } } },
};

describe("a lapsed hold", () => {
  it("is released, and its units come back", async () => {
    await using kobai = await createTestKobai(abandonsItsHolds);
    const catalog = await stockedCatalog(kobai, 3);
    await abandonAHold(kobai, catalog);

    await expect(stockOf(kobai)).resolves.toEqual({ onHand: 3, reserved: 2 });
    await windHoldsBack(kobai);
    await expect(kobai.sweep()).resolves.toMatchObject({ reservationsReleased: 1 });

    // Back on the shelf — and the row says how it ended rather than disappearing, so a Merchant
    // asking why stock moved has something to read.
    await expect(stockOf(kobai)).resolves.toEqual({ onHand: 3, reserved: 0 });
    await expect(reservations(kobai)).resolves.toEqual([
      { consumed: false, released: true },
    ]);
  });

  it("is left alone while its window still stands", async () => {
    await using kobai = await createTestKobai(abandonsItsHolds);
    const catalog = await stockedCatalog(kobai, 3);
    await abandonAHold(kobai, catalog);

    await expect(kobai.sweep()).resolves.toMatchObject({ reservationsReleased: 0 });

    // Releasing a hold out from under a placement that is still running is the worse of the two
    // mistakes the sweeper can make, because that one oversells.
    await expect(stockOf(kobai)).resolves.toEqual({ onHand: 3, reserved: 2 });
  });

  it("gives its units back once, however many sweeps see it", async () => {
    await using kobai = await createTestKobai(abandonsItsHolds);
    const catalog = await stockedCatalog(kobai, 3);
    await abandonAHold(kobai, catalog);
    await windHoldsBack(kobai);

    await kobai.sweep();
    await expect(kobai.sweep()).resolves.toMatchObject({ reservationsReleased: 0 });

    // The row is what authorises the arithmetic, so a second sweep — or a compensation racing
    // one — finds nothing left to release and returns nothing. Stock that came back twice would
    // be stock the Store does not have.
    await expect(stockOf(kobai)).resolves.toEqual({ onHand: 3, reserved: 0 });
  });

  it("is never released once it has been consumed, however old it is", async () => {
    await using kobai = await createTestKobai();
    const catalog = await stockedCatalog(kobai, 3);
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });
    expect((await place(kobai, cart.apiKey.headers, cart.id)).status).toBe(201);

    await windHoldsBack(kobai);
    await expect(kobai.sweep()).resolves.toMatchObject({ reservationsReleased: 0 });

    // Those units left the building with an Order. Restocking a Store that has already shipped
    // is the sweeper's one genuinely dangerous mistake, and `consumed_at` is what forecloses it.
    await expect(stockOf(kobai)).resolves.toEqual({ onHand: 1, reserved: 0 });
  });

  it("is released without complaint when the Variant has stopped being counted", async () => {
    await using kobai = await createTestKobai(abandonsItsHolds);
    const catalog = await stockedCatalog(kobai, 3);
    await abandonAHold(kobai, catalog);
    await windHoldsBack(kobai);

    // The Variant is gone while the hold stands, and its Inventory row went with it. Since #115
    // `DELETE /admin/variants/{id}` refuses exactly this — units claimed by a Reservation being
    // placed are what stop a Variant being deleted — so the writer here is one Core does not
    // mediate (ADR-0004), which is what this SQL is. There is nothing to give back either way,
    // and the sweep must say so by finishing: a failure rolls `released_at` back and the same
    // row returns every minute forever.
    await kobai.db.execute(sql`delete from core_variant`);

    await expect(kobai.sweep()).resolves.toMatchObject({ reservationsReleased: 1 });
    await expect(reservations(kobai)).resolves.toEqual([
      { consumed: false, released: true },
    ]);
  });

  it("refuses to be released against a stock level somebody else has rewritten", async () => {
    await using kobai = await createTestKobai(abandonsItsHolds);
    const catalog = await stockedCatalog(kobai, 3);
    await abandonAHold(kobai, catalog);
    await windHoldsBack(kobai);

    // The write Core does not mediate (ADR-0004): a hand-run `UPDATE` that clears `reserved`
    // while a hold stands. No path through kobai produces it, so giving units back on top of it
    // would be inventing stock — and stamping the row `released` while the shelf never moved
    // would hide it.
    await kobai.db.execute(sql`update core_inventory set reserved = 0`);

    await expect(kobai.sweep()).rejects.toThrow(/written to this Inventory row/);
    await expect(reservations(kobai)).resolves.toEqual([
      { consumed: false, released: false },
    ]);
  });

  it("is released by the interval, without anybody asking", async () => {
    await using kobai = await createTestKobai(abandonsItsHolds);
    const catalog = await stockedCatalog(kobai, 3);
    await abandonAHold(kobai, catalog);
    await windHoldsBack(kobai);

    // The interval is the whole subject here, so this is the one test that waits — for a timer
    // wound down to milliseconds, against a row already wound back. `sweep()` above says the
    // query is right; this says something actually calls it.
    kobai.startSweeper({ intervalMs: 20 });

    await vi.waitFor(
      async () => {
        await expect(stockOf(kobai)).resolves.toEqual({ onHand: 3, reserved: 0 });
      },
      { timeout: 5000, interval: 20 },
    );
  });
});

describe("an expired idempotency key", () => {
  it("is deleted, in the same sweep", async () => {
    // Nothing deleted these until the sweeper existed, which is a note #102 left in the schema:
    // one row per placement attempt, accumulating, and a background sweep was the natural home
    // for them the moment kobai had one at all.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    expect((await place(kobai, cart.apiKey.headers, cart.id, "kept")).status).toBe(201);
    const second = await seedTestCart(kobai, { catalog: cart.catalog });
    expect((await place(kobai, second.apiKey.headers, second.id, "gone")).status).toBe(
      201,
    );

    await kobai.db.execute(
      sql`update core_idempotency_key
          set expires_at = now() - interval '1 minute'
          where key = 'gone'`,
    );
    await expect(kobai.sweep()).resolves.toMatchObject({ idempotencyKeysDeleted: 1 });

    await expect(idempotencyKeys(kobai)).resolves.toEqual(["kept"]);
  });

  it("is swept only once it has stopped binding", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    expect((await place(kobai, cart.apiKey.headers, cart.id, "once")).status).toBe(201);

    // A key that still binds answers a retry with the Order it placed, and a sweep that deleted
    // it would turn a safe retry back into a second attempt at buying.
    await expect(kobai.sweep()).resolves.toMatchObject({ idempotencyKeysDeleted: 0 });
    const replayed = await place(kobai, cart.apiKey.headers, cart.id, "once");
    expect(replayed.status).toBe(200);

    await kobai.db.execute(
      sql`update core_idempotency_key set expires_at = now() - interval '1 minute'`,
    );
    await kobai.sweep();

    // Afterwards the row is gone — and the Cart is still spent, because that is the unique
    // index's job rather than the key's (#102). So the retry is refused about the Cart.
    await expect(idempotencyKeys(kobai)).resolves.toEqual([]);
    const afterwards = await place(kobai, cart.apiKey.headers, cart.id, "once");
    expect(afterwards.status).toBe(409);
    await expect(afterwards.json()).resolves.toMatchObject({ reason: "cart-placed" });
  });
});

/** A catalog whose one Variant the Store is counting. */
async function stockedCatalog(kobai: TestKobai, onHand: number): Promise<TestCatalog> {
  const catalog = await seedTestCatalog(kobai);
  const response = await kobai.request(`/admin/variants/${catalog.variantId}/inventory`, {
    method: "PUT",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ onHand }),
  });
  expect(response.status).toBe(200);
  return catalog;
}

/**
 * Starts a placement that holds and then never comes back, and waits for the hold to exist.
 *
 * The request is deliberately not awaited: it never resolves, which is the arrangement. Waiting
 * for the row rather than for a duration is what keeps this a test about the sweeper instead of
 * a test about how fast Postgres is today.
 */
async function abandonAHold(kobai: TestKobai, catalog: TestCatalog) {
  const cart = await seedTestCart(kobai, { catalog, quantity: 2 });
  void place(kobai, cart.apiKey.headers, cart.id);
  await vi.waitFor(async () => {
    await expect(reservations(kobai)).resolves.toHaveLength(1);
  });
}

/** Winds every hold's window back, which is how time passes here. */
async function windHoldsBack(kobai: TestKobai) {
  await kobai.db.execute(
    sql`update core_reservation set expires_at = now() - interval '1 minute'`,
  );
}

async function place(
  kobai: TestKobai,
  headers: Record<string, string>,
  cartId: string,
  idempotencyKey?: string,
) {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify({ cartId }),
  });
}

/** What the one counted Variant's row says, which is what a release has to move. */
async function stockOf(kobai: TestKobai) {
  const [row] = await kobai.database.query<{ on_hand: string; reserved: string }>(
    "select on_hand::text as on_hand, reserved::text as reserved from core_inventory",
  );
  return { onHand: Number(row?.on_hand), reserved: Number(row?.reserved) };
}

async function reservations(kobai: TestKobai) {
  return kobai.database.query<{ consumed: boolean; released: boolean }>(
    `select consumed_at is not null as consumed, released_at is not null as released
     from core_reservation`,
  );
}

async function idempotencyKeys(kobai: TestKobai) {
  const rows = await kobai.database.query<{ key: string }>(
    "select key from core_idempotency_key order by key",
  );
  return rows.map((row) => row.key);
}
