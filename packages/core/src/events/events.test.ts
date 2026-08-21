import { describe, expect, it } from "vitest";
import type { Logger } from "../config.ts";
import type { FulfilmentTransitionRefusal } from "../fulfilment/lifecycle.ts";
import {
  createTestKobai,
  MIXED_ORDER_PHYSICAL_SKU,
  seedTestMixedOrder,
  seedTestOrder,
  type TestKobai,
  type TestOrder,
} from "../testing/index.ts";
import type {
  EventName,
  EventSubscribers,
  FulfilmentDispatched,
  Subscriber,
} from "./events.ts";

/**
 * **The events surface** — Core emits, the Project wires a Subscriber, and delivery is
 * in-process (ADR-0085, #322).
 *
 * Everything here is asserted at the **HTTP seam**, because that is where the guarantee lives:
 * ADR-0085 makes an Event something Core emits from the route *after* the transaction that made
 * the fact has committed, so a test that called an emitter directly would be asserting against
 * the one arrangement in which the promise is trivially true.
 *
 * **Every case asks what a Subscriber did with what it was handed, and none counts calls.** A
 * counter proves the callback ran and nothing about whether it was told the truth — the rule
 * `packages/plugin-price-log/src/record-price-resolution.test.ts` and
 * `packages/core/src/payment/payment.test.ts` already hold. So the Subscribers below keep books:
 * every payload they were handed, in the order they were handed them, asserted field by field
 * against what the Store actually did.
 */

/** A Subscriber that keeps the payloads it was handed, and the book they go in. */
function recording(): {
  readonly heard: FulfilmentDispatched[];
  readonly subscriber: Subscriber<"fulfilment-was-dispatched">;
} {
  const heard: FulfilmentDispatched[] = [];
  return { heard, subscriber: (payload) => void heard.push(payload) };
}

/** A Logger that keeps what it was told, for the cases about a Subscriber that throws. */
function recordingLogger(): {
  readonly errors: { message: string; fields?: Record<string, unknown> }[];
  readonly logger: Logger;
} {
  const errors: { message: string; fields?: Record<string, unknown> }[] = [];
  return {
    errors,
    logger: {
      info: () => {},
      error: (message, fields) => void errors.push({ message, fields }),
    },
  };
}

type FulfilmentBody = {
  readonly id: string;
  readonly state: string;
  readonly trackingReference: string | null;
  readonly lineItemIds: readonly string[];
};

/** The Fulfilments of an Order, as a Merchant reads them back. */
async function fulfilmentsOf(
  kobai: TestKobai,
  order: TestOrder,
): Promise<readonly FulfilmentBody[]> {
  const response = await kobai.request(`/admin/orders/${order.id}`, {
    headers: order.catalog.merchant.headers,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { fulfilments: readonly FulfilmentBody[] })
    .fulfilments;
}

/** The one Fulfilment of an ordinary Order. */
async function theFulfilment(
  kobai: TestKobai,
  order: TestOrder,
): Promise<FulfilmentBody> {
  const [only] = await fulfilmentsOf(kobai, order);
  if (!only) throw new Error("this Order has no Fulfilment");
  return only;
}

/** Dispatches, exactly as a Merchant's client does. */
function dispatch(
  kobai: TestKobai,
  order: TestOrder,
  fulfilmentId: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const headers = order.catalog.merchant.headers;
  return kobai.request(`/admin/orders/${order.id}/fulfilments/${fulfilmentId}/dispatch`, {
    method: "POST",
    headers:
      body === undefined ? headers : { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** When Postgres says the row was last written — what `occurredAt` is a reading of. */
async function rowWrittenAt(kobai: TestKobai, fulfilmentId: string): Promise<string> {
  const [row] = await kobai.database.query<{ updated_at: Date }>(
    "select updated_at from core_fulfilment where id = $1",
    [fulfilmentId],
  );
  if (!row) throw new Error("no such Fulfilment");
  return new Date(row.updated_at).toISOString();
}

describe("dispatching a Fulfilment", () => {
  it("hands a wired Subscriber what moved, the Order it is part of, the reference and when", async () => {
    const emailTheShopper = recording();
    await using kobai = await createTestKobai({
      events: {
        subscribers: { "fulfilment-was-dispatched": [emailTheShopper.subscriber] },
      },
    });
    const order = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, order);

    const response = await dispatch(kobai, order, pending.id, {
      trackingReference: "RR123456789MY",
    });

    expect(response.status).toBe(200);
    // The whole payload, `toEqual` rather than `toMatchObject`, so a field Core stopped
    // sending is a failure rather than something the assertion quietly stops checking.
    expect(emailTheShopper.heard).toEqual([
      {
        fulfilmentId: pending.id,
        orderId: order.id,
        trackingReference: "RR123456789MY",
        occurredAt: await rowWrittenAt(kobai, pending.id),
      },
    ]);
  });

  it("says `null` where the dispatch recorded no reference", async () => {
    const emailTheShopper = recording();
    await using kobai = await createTestKobai({
      events: {
        subscribers: { "fulfilment-was-dispatched": [emailTheShopper.subscriber] },
      },
    });
    const order = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, order);

    // A download has nothing to track, so this is the ordinary dispatch rather than the odd
    // one — and the payload has to be able to say so rather than dropping the field.
    expect((await dispatch(kobai, order, pending.id)).status).toBe(200);

    expect(emailTheShopper.heard.map((one) => one.trackingReference)).toEqual([null]);
  });

  it("announces the part that moved and not the rest of the Order", async () => {
    const emailTheShopper = recording();
    await using kobai = await createTestKobai({
      events: {
        subscribers: { "fulfilment-was-dispatched": [emailTheShopper.subscriber] },
      },
    });
    // Two Fulfilments on independent timelines — the arrangement that makes "which one moved"
    // a question with a wrong answer available (ADR-0014).
    const order = await seedTestMixedOrder(kobai);
    const posterLine = order.lineItem(MIXED_ORDER_PHYSICAL_SKU).id;
    const fulfilments = await fulfilmentsOf(kobai, order);
    const poster = fulfilments.find((one) => one.lineItemIds.includes(posterLine));
    if (!poster) throw new Error("no Fulfilment covers the poster");

    expect((await dispatch(kobai, order, poster.id)).status).toBe(200);

    // The poster's identifier, and not the PDF's — which a payload carrying "the Order" rather
    // than the identity of what happened could not have distinguished.
    expect(emailTheShopper.heard.map((one) => one.fulfilmentId)).toEqual([poster.id]);
    expect(fulfilments).toHaveLength(2);
  });

  it("announces nothing when the move was refused", async () => {
    const emailTheShopper = recording();
    await using kobai = await createTestKobai({
      events: {
        subscribers: { "fulfilment-was-dispatched": [emailTheShopper.subscriber] },
      },
    });
    const order = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, order);
    // The arrangement is a dispatch that *did* happen, so the assertion below is about the
    // second one alone rather than about a Subscriber nothing had reached yet.
    expect(
      (await dispatch(kobai, order, pending.id, { trackingReference: "FIRST" })).status,
    ).toBe(200);

    // A second dispatch is refused by where the Fulfilment already is, so nothing happened —
    // and an Event is a fact about something kobai *did*.
    const again = await dispatch(kobai, order, pending.id, {
      trackingReference: "SECOND",
    });

    expect(again.status).toBe(409);
    // Still the one payload, and it is the *first* dispatch's — a second announcement of a
    // move that was refused would show up here as a reference nothing ever recorded.
    expect(emailTheShopper.heard.map((one) => one.trackingReference)).toEqual(["FIRST"]);
  });

  it("announces nothing for a delivery or a cancellation, which have no Event yet", async () => {
    const emailTheShopper = recording();
    await using kobai = await createTestKobai({
      events: {
        subscribers: { "fulfilment-was-dispatched": [emailTheShopper.subscriber] },
      },
    });
    const order = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, order);
    expect((await dispatch(kobai, order, pending.id)).status).toBe(200);

    const delivered = await kobai.request(
      `/admin/orders/${order.id}/fulfilments/${pending.id}/deliver`,
      { method: "POST", headers: order.catalog.merchant.headers },
    );

    expect(delivered.status).toBe(200);
    // Still the one payload the dispatch produced. Delivered and cancelled get Events on the
    // same terms when something wants them; an Event nobody subscribes to is a promise with no
    // consumer, which is what ADR-0003 exists to prevent.
    expect(emailTheShopper.heard.map((one) => one.fulfilmentId)).toEqual([pending.id]);
  });
});

describe("several Subscribers on one Event", () => {
  it("runs them in the order the Project wrote them, one after another and awaited", async () => {
    // One book shared by three, so what is asserted is the *sequence* rather than three
    // independent facts — and each entry says which Subscriber wrote it and what it was handed.
    const order: string[] = [];
    /** Yields to the event loop before writing, so a run that did not await would interleave. */
    const slow = (name: string): Subscriber<"fulfilment-was-dispatched"> => {
      return async (payload) => {
        await new Promise((resolve) => setImmediate(resolve));
        order.push(`${name}:${payload.fulfilmentId}`);
      };
    };
    await using kobai = await createTestKobai({
      events: {
        subscribers: {
          "fulfilment-was-dispatched": [slow("first"), slow("second"), slow("third")],
        },
      },
    });
    const placed = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, placed);

    expect((await dispatch(kobai, placed, pending.id)).status).toBe(200);

    // In wired order rather than in whatever order three promises happened to settle in — and
    // all three already finished by the time the Merchant had their answer, which is what
    // "awaited" means and what a floating promise would not have given.
    expect(order).toEqual([
      `first:${pending.id}`,
      `second:${pending.id}`,
      `third:${pending.id}`,
    ]);
  });

  it("calls the ones after a Subscriber that threw, and reports the failure in the log", async () => {
    const before = recording();
    const after = recording();
    const broken: Subscriber<"fulfilment-was-dispatched"> = () => {
      throw new Error("the mail server is down");
    };
    const log = recordingLogger();
    await using kobai = await createTestKobai({
      logger: log.logger,
      events: {
        subscribers: {
          "fulfilment-was-dispatched": [before.subscriber, broken, after.subscriber],
        },
      },
    });
    const placed = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, placed);

    expect((await dispatch(kobai, placed, pending.id)).status).toBe(200);

    // The failure that matters is not one integration being broken; it is one broken
    // integration silencing the ones wired after it. So both books hold the payload.
    expect(before.heard.map((one) => one.fulfilmentId)).toEqual([pending.id]);
    expect(after.heard.map((one) => one.fulfilmentId)).toEqual([pending.id]);
    // Reported in the log and nowhere else — the response body a Merchant's Admin parses does
    // not grow a field about whether somebody's email integration is working.
    // `position` is which of the three broke, counted from the top of the wired list. A
    // Subscriber is a function and has no name of its own, so where the Project wrote it is the
    // only handle there is — and a deployment with three wired against one Event that was told
    // only *a subscriber failed* would have nothing to open.
    expect(log.errors).toEqual([
      {
        message: "a subscriber failed",
        fields: {
          event: "fulfilment-was-dispatched",
          position: 1,
          of: 3,
          reason: "the mail server is down",
        },
      },
    ]);
  });

  it("still answers the Merchant when the deployment's own Logger throws too", async () => {
    // A `Logger` is a Project's (ADR-0003), so it is somebody else's code in the one place that
    // exists to contain somebody else's code throwing. If reporting a broken Subscriber could
    // itself escape, the guarantee would fail in exactly the case it was written for.
    const broken: Subscriber<"fulfilment-was-dispatched"> = () => {
      throw new Error("the mail server is down");
    };
    const after = recording();
    await using kobai = await createTestKobai({
      logger: {
        info: () => {},
        error: () => {
          throw new Error("the log shipper is down too");
        },
      },
      events: {
        subscribers: { "fulfilment-was-dispatched": [broken, after.subscriber] },
      },
    });
    const placed = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, placed);

    const response = await dispatch(kobai, placed, pending.id, {
      trackingReference: "RR123456789MY",
    });

    expect(response.status).toBe(200);
    // And the Subscriber wired after the broken one still ran and was still told the truth.
    expect(after.heard.map((one) => one.trackingReference)).toEqual(["RR123456789MY"]);
    const moved = await theFulfilment(kobai, placed);
    expect(moved.state).toBe("dispatched");
  });
});

describe("when a Subscriber runs", () => {
  it("finds the fact already committed, which is what leaves it nothing to undo", async () => {
    // The Subscriber reads the Order back over the same surface a Merchant would, at the
    // moment it is handed the payload — so what is asserted is not "the emit call came after
    // the update call" but *the world already agrees*. That is ADR-0085's structural claim,
    // and it is the one a `try`/`catch` around the call could never have made.
    const seen: string[] = [];
    // Wired before there is a kobai to read back through, and filled in once there is —
    // which is the only order available, since a Subscriber goes into the config a boot is
    // built from. What is wired is a real Subscriber throughout; only what it does is late.
    let readItBack: Subscriber<"fulfilment-was-dispatched"> = () => {};
    await using kobai = await createTestKobai({
      events: {
        subscribers: { "fulfilment-was-dispatched": [(payload) => readItBack(payload)] },
      },
    });
    const placed = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, placed);
    readItBack = async (payload) => {
      const found = (await fulfilmentsOf(kobai, placed)).find(
        (one) => one.id === payload.fulfilmentId,
      );
      seen.push(found?.state ?? "gone");
    };

    expect((await dispatch(kobai, placed, pending.id)).status).toBe(200);

    expect(seen).toEqual(["dispatched"]);
  });
});

describe("a Subscriber that throws", () => {
  it("does not undo the dispatch, and the Merchant reads the Fulfilment back moved", async () => {
    const broken: Subscriber<"fulfilment-was-dispatched"> = () => {
      throw new Error("the mail server is down");
    };
    await using kobai = await createTestKobai({
      logger: { info: () => {}, error: () => {} },
      events: { subscribers: { "fulfilment-was-dispatched": [broken] } },
    });
    const placed = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, placed);

    const response = await dispatch(kobai, placed, pending.id, {
      trackingReference: "RR123456789MY",
    });

    // Not a 500, and not a refusal: a Subscriber cannot refuse, and `StepFailure` has no
    // meaning here (ADR-0085) — this is deliberately *not* the Workflow runner's rule, where a
    // Step refuses by throwing and compensations unwind in reverse (ADR-0036).
    expect(response.status).toBe(200);

    // And the fact itself, read back through the surface a Merchant reads it through. This is
    // structural rather than a `try`/`catch` promise: the statement that moved the row had
    // committed before the Subscriber ran, so there was nothing left to undo.
    const moved = await theFulfilment(kobai, placed);
    expect(moved.state).toBe("dispatched");
    expect(moved.trackingReference).toBe("RR123456789MY");
  });
});

/**
 * The half of the promise no response body can carry, and the `typecheck` step of the gate is
 * what actually runs it — the Workflow seam's arrangement, one Extension Point along.
 *
 * A payload is **produced by Core and read by a Subscriber**, which is `FulfilledVariant`'s
 * direction (ADR-0019): Core may add a field and every Subscriber written against today's shape
 * still compiles, while one demanding more than Core sends must not.
 */
describe("what a Subscriber may be declared as", () => {
  it("accepts one that reads less than Core sends, which is what makes a field additive", () => {
    const onlyTheOrder: Subscriber<"fulfilment-was-dispatched"> = (dispatched: {
      readonly orderId: string;
    }) => void dispatched.orderId;

    expect(onlyTheOrder).toBeDefined();
  });

  it("rejects one that demands more than Core sends", () => {
    const wantsAnEmail: EventSubscribers = {
      "fulfilment-was-dispatched": [
        // @ts-expect-error a payload carries the identity of what happened and the facts of the
        // transition, never a copy of the record it concerns — so there is no Shopper here.
        (dispatched: { readonly shopperEmail: string }) => void dispatched.shopperEmail,
      ],
    };

    expect(wantsAnEmail).toBeDefined();
  });

  it("rejects one wired against an Event kobai does not emit", () => {
    const guessing: EventSubscribers = {
      // @ts-expect-error the set of Event names is Core's, and `fulfilment-was-delivered` is
      // not in it: delivered gets an Event on the same terms when something wants one, under
      // that name (#338).
      "fulfilment-was-delivered": [() => {}],
    };

    expect(guessing).toBeDefined();
  });
});

/**
 * The rule #338 settled, asserted where the names are declared rather than left to be noticed.
 *
 * An Event announces that a Fulfilment **just moved**; a `fulfilment-…` refusal names the state
 * one is **already in** and so will not move from (`fulfilment/lifecycle.ts`, ADR-0060). They
 * are opposite facts and they must not be one word. Both sets are **derived** — `EventName` from
 * `KobaiEvents`, `FulfilmentTransitionRefusal` from the state union — so this covers the Events
 * delivered and cancelled will get, and the word a fifth state would bring, rather than only the
 * one pair that collided.
 *
 * **Watched failing against the name #322 shipped**, which is the whole of what makes it an
 * assertion rather than a decoration: `error TS2322: Type '"fulfilment-dispatched"[]' is not
 * assignable to type 'never[]'`, naming the spelling.
 */
describe("what an Event may be named", () => {
  it("shares no spelling with the word a Fulfilment refuses a move with", () => {
    // `never` is the whole assertion: a spelling in both sets makes the right-hand side a
    // literal, and a literal does not go into `never[]`. The gate's `typecheck` step runs it.
    const spelledBothWays: never[] = [] as Extract<
      EventName,
      FulfilmentTransitionRefusal
    >[];

    expect(spelledBothWays).toEqual([]);
  });
});

describe("a deployment that wires no Subscriber", () => {
  it("dispatches exactly as it does today, and says nothing to its log", async () => {
    const log = recordingLogger();
    // No `events` key at all — the config of every deployment before this surface existed, and
    // of every one that installs a package offering a Subscriber and wires none (ADR-0017).
    await using kobai = await createTestKobai({ logger: log.logger });
    const placed = await seedTestOrder(kobai);
    const pending = await theFulfilment(kobai, placed);

    const response = await dispatch(kobai, placed, pending.id, {
      trackingReference: "RR123456789MY",
    });

    expect(response.status).toBe(200);
    // The whole body, so a field that changed shape because something is now emitted would be a
    // failure rather than something this assertion stops noticing.
    expect(await response.json()).toEqual({
      ...pending,
      state: "dispatched",
      trackingReference: "RR123456789MY",
    });
    expect(log.errors).toEqual([]);
  });
});
