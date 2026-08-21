import type { FulfilmentDispatched, Subscriber } from "@kobai/core";
import {
  createTestKobai,
  seedTestOrder,
  type TestKobai,
  type TestKobaiOptions,
  type TestOrder,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { dispatchLog } from "./log-dispatches.ts";
import { priceLogMigrationSet } from "./migration-set.ts";

/**
 * The Subscriber this Plugin **offers** — and what it takes to make it run (ADR-0017,
 * ADR-0085, #323).
 *
 * This is `record-price-resolution.test.ts`'s argument reached through the other half of the
 * extension surface. There a Plugin offered a Step and a Project's `kobai.config.ts` was the
 * only thing that put it into a Workflow; here a Plugin offers a Subscriber and that same file
 * is the only thing that puts it against an Event. **A Subscriber is the sharper of the two
 * cases**: a Step at least has to satisfy the slot's input and output, so a Plugin that
 * installed one by being installed would still be constrained by the compiler, while a
 * Subscriber returns nothing and decides nothing — one that registered itself at load time
 * would be running code in a deployment with no compile-time trace of it at all.
 *
 * So every case below boots the application, dispatches a Fulfilment over the surface a Merchant
 * dispatches through, and **asks the log what it holds** rather than counting that a callback
 * was reached. A counter proves the callback ran and nothing about whether it was told the
 * truth.
 */

/**
 * Every deployment below wires this Plugin's tables; only some wire its Subscriber.
 *
 * **The Subscriber never touches a table, and the tables are wired anyway on purpose.** It is
 * what makes the unwired case below say something: the Plugin is installed, imported, and wired
 * as far as a Project can wire it short of naming the Subscriber — and it still hears nothing.
 * It also keeps the wired and unwired deployments one line apart, which is the whole shape of
 * the argument (`record-price-resolution.test.ts` draws the same line for the Step).
 */
const WIRED_TABLES: TestKobaiOptions = { migrationSets: [priceLogMigrationSet] };

/**
 * An Order with one Fulfilment, and that Fulfilment as a Merchant reads it back.
 *
 * Takes a catalog for the case that wants a *second* Order out of one deployment: a deployment
 * has only ever one first Merchant, so seeding a second catalog is refused rather than allowed.
 */
async function anOrderToDispatch(kobai: TestKobai, catalog?: TestOrder["catalog"]) {
  const order = await seedTestOrder(kobai, catalog === undefined ? {} : { catalog });
  const read = await kobai.request(`/admin/orders/${order.id}`, {
    headers: order.catalog.merchant.headers,
  });
  expect(read.status).toBe(200);
  const body = (await read.json()) as { fulfilments: readonly { id: string }[] };
  const [only] = body.fulfilments;
  if (!only) throw new Error("this Order has no Fulfilment");
  return { order, fulfilmentId: only.id };
}

/** Marks it dispatched, exactly as the Admin does. */
function dispatch(
  kobai: TestKobai,
  order: TestOrder,
  fulfilmentId: string,
  trackingReference?: string,
) {
  return kobai.request(`/admin/orders/${order.id}/fulfilments/${fulfilmentId}/dispatch`, {
    method: "POST",
    headers: { ...order.catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(trackingReference === undefined ? {} : { trackingReference }),
  });
}

/**
 * A bare Subscriber that keeps every payload it was handed, wired beside the Plugin's own.
 *
 * **This is how a Plugin's test pins `occurredAt` without reading `core_fulfilment`.** Core's
 * own suite is where "the payload's `occurredAt` is a reading of the row Postgres wrote" is
 * asserted, because that is Core's promise; a Plugin has no business in a `core_*` table at all
 * (ADR-0004), and one that reached into one here would tie its gate to a column name Core has
 * promised nothing about. What is this Plugin's promise is that it kept what it was handed, and
 * a Subscriber wired beside it is the surface that can say so — and never a clock, which would
 * be asserting that the two readings happened close together rather than that they are the same
 * fact.
 */
function alsoWired(): {
  readonly heard: FulfilmentDispatched[];
  readonly subscriber: Subscriber<"fulfilment-was-dispatched">;
} {
  const heard: FulfilmentDispatched[] = [];
  return { heard, subscriber: (payload) => void heard.push(payload) };
}

/** The one payload kobai sent, or a failure that says it sent none. */
function theOnePayload(heard: readonly FulfilmentDispatched[]): FulfilmentDispatched {
  const [only] = heard;
  if (heard.length !== 1 || !only) {
    throw new Error(`kobai announced ${heard.length} dispatches, not one`);
  }
  return only;
}

describe("a Plugin that offers a Subscriber", () => {
  it("logs what kobai said, once a Project has wired it", async () => {
    const log = dispatchLog();
    const kobaiSaid = alsoWired();
    await using kobai = await createTestKobai({
      ...WIRED_TABLES,
      // The line a Project writes in `kobai.config.ts`, and the whole of what makes this
      // Plugin's Subscriber run.
      events: {
        subscribers: {
          "fulfilment-was-dispatched": [kobaiSaid.subscriber, log.logTheDispatch],
        },
      },
    });
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    const response = await dispatch(kobai, order, fulfilmentId, "RR123456789MY");

    expect(response.status).toBe(200);
    // The whole entry, `toEqual` rather than `toMatchObject`, so a field this Plugin stopped
    // keeping is a failure rather than something the assertion quietly stops checking. Three
    // fields are held against what the arrangement did, and the fourth against what kobai
    // actually sent — see `alsoWired`.
    expect(log.entriesFor(order.id)).toEqual([
      {
        fulfilmentId,
        orderId: order.id,
        trackingReference: "RR123456789MY",
        occurredAt: theOnePayload(kobaiSaid.heard).occurredAt,
      },
    ]);
  });

  it("says `null` where the dispatch recorded no reference", async () => {
    // A download has nothing to track, so the payload's `trackingReference` is nullable — and
    // a Plugin that dropped the field rather than keeping the `null` would be inventing a
    // reference that was never recorded.
    const log = dispatchLog();
    await using kobai = await createTestKobai({
      ...WIRED_TABLES,
      events: { subscribers: { "fulfilment-was-dispatched": [log.logTheDispatch] } },
    });
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    expect((await dispatch(kobai, order, fulfilmentId)).status).toBe(200);

    expect(log.entriesFor(order.id).map((entry) => entry.trackingReference)).toEqual([
      null,
    ]);
  });

  it("never runs while it is offered and unwired", async () => {
    // This module imports the Subscriber. It is installed, in scope, and one line of config
    // away from running — and it does not run, because no Project asked for it (ADR-0017).
    // **This is the case the whole rule exists for**, and it is invisible to any test that
    // only ever wires it.
    const log = dispatchLog();
    await using kobai = await createTestKobai(WIRED_TABLES);
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    const response = await dispatch(kobai, order, fulfilmentId, "RR123456789MY");

    // The dispatch is untouched — a deployment that wired no Subscriber behaves exactly as one
    // that had never heard of the Extension Point.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "dispatched",
      trackingReference: "RR123456789MY",
    });
    expect(log.entriesFor(order.id)).toEqual([]);
  });

  it("keeps one entry however many times it is told, because delivery may be at least once", async () => {
    // ADR-0085 asks a Subscriber to be idempotent: in-process delivery is at most once, a
    // durable one would be at least once, and a Plugin written to the weaker guarantee is a
    // Plugin that would double-count the day that changes. Wired twice is how a Project can
    // make that happen today — nothing stops one — and it is the same arrangement
    // `record-price-resolution.test.ts` uses to hold the Step's bookkeeping to being told
    // twice.
    const log = dispatchLog();
    const kobaiSaid = alsoWired();
    await using kobai = await createTestKobai({
      ...WIRED_TABLES,
      events: {
        subscribers: {
          "fulfilment-was-dispatched": [
            log.logTheDispatch,
            kobaiSaid.subscriber,
            log.logTheDispatch,
          ],
        },
      },
    });
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    expect((await dispatch(kobai, order, fulfilmentId, "RR123456789MY")).status).toBe(
      200,
    );

    // One entry, and it is a whole one — a log that deduplicated by dropping the second telling
    // on the floor and a log that kept both would both be caught, and so would one that kept a
    // half-written entry.
    expect(log.entriesFor(order.id)).toEqual([
      {
        fulfilmentId,
        orderId: order.id,
        trackingReference: "RR123456789MY",
        occurredAt: theOnePayload(kobaiSaid.heard).occurredAt,
      },
    ]);
  });

  it("answers for the Order it was asked about and not for another", async () => {
    // One process serves every Order, so a log that answered *everything it has heard* would
    // be a question with no stable answer. Two Orders, one dispatched each, and each read is
    // its own.
    const log = dispatchLog();
    await using kobai = await createTestKobai({
      ...WIRED_TABLES,
      events: { subscribers: { "fulfilment-was-dispatched": [log.logTheDispatch] } },
    });
    const first = await anOrderToDispatch(kobai);
    const second = await anOrderToDispatch(kobai, first.order.catalog);

    expect((await dispatch(kobai, first.order, first.fulfilmentId, "FIRST")).status).toBe(
      200,
    );
    expect(
      (await dispatch(kobai, second.order, second.fulfilmentId, "SECOND")).status,
    ).toBe(200);

    expect(
      log.entriesFor(first.order.id).map((entry) => entry.trackingReference),
    ).toEqual(["FIRST"]);
    expect(
      log.entriesFor(second.order.id).map((entry) => entry.trackingReference),
    ).toEqual(["SECOND"]);
  });

  it("gives each Project its own log, because the offer is a factory", async () => {
    // A Plugin that needs anything of the deployment's exports a factory, the way
    // `stripePayments` does — and here what it needs is somewhere to put what it hears. Two
    // logs are two books: a module-level one would be shared state a Project never asked for.
    const wired = dispatchLog();
    const unwired = dispatchLog();
    await using kobai = await createTestKobai({
      ...WIRED_TABLES,
      events: { subscribers: { "fulfilment-was-dispatched": [wired.logTheDispatch] } },
    });
    const { order, fulfilmentId } = await anOrderToDispatch(kobai);

    expect((await dispatch(kobai, order, fulfilmentId)).status).toBe(200);

    expect(wired.entriesFor(order.id)).toHaveLength(1);
    expect(unwired.entriesFor(order.id)).toEqual([]);
  });
});

/**
 * The one property of this log that is not about the extension surface, and the one case in this
 * file that does not go through HTTP.
 *
 * **The bound is a property of the object rather than of a deployment**, and reaching it over the
 * surface would mean placing and dispatching a hundred and one Orders to assert one `if`. So the
 * Subscriber is called the way Core calls it — with payloads of exactly the shape Core sends,
 * which the compiler checks — and nothing about *when* Core calls it is being claimed here. Every
 * case above is the other kind and stays where it is.
 */
describe("a log nothing drains", () => {
  it("drops the oldest rather than growing for as long as the process runs", () => {
    const log = dispatchLog();
    const announced = (n: number): FulfilmentDispatched => ({
      fulfilmentId: `fulfilment-${n}`,
      orderId: "one-very-busy-order",
      trackingReference: `RR${n}`,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    });

    // One more than it keeps, so exactly one has to have fallen off.
    for (let n = 0; n <= 100; n += 1) log.logTheDispatch(announced(n));

    const kept = log.entriesFor("one-very-busy-order");
    expect(kept).toHaveLength(100);
    // The oldest went and the newest stayed — a bound that dropped the wrong end would keep the
    // same count and answer nothing anybody was asking about.
    expect(kept.at(0)?.fulfilmentId).toBe("fulfilment-1");
    expect(kept.at(-1)?.fulfilmentId).toBe("fulfilment-100");
  });

  it("does not spend the bound on a Fulfilment it has already heard about", () => {
    // Idempotence and the bound have to agree: being told about one Fulfilment a hundred times
    // must not push ninety-nine others off the end.
    const log = dispatchLog();
    const told = (fulfilmentId: string): FulfilmentDispatched => ({
      fulfilmentId,
      orderId: "one-very-busy-order",
      trackingReference: null,
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    log.logTheDispatch(told("the-first-one"));
    for (let n = 0; n < 100; n += 1) log.logTheDispatch(told("told-over-and-over"));

    expect(
      log.entriesFor("one-very-busy-order").map((entry) => entry.fulfilmentId),
    ).toEqual(["the-first-one", "told-over-and-over"]);
  });
});
