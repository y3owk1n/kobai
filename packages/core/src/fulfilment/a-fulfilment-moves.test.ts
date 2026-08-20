import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  inspectSchema,
  MIXED_ORDER_DIGITAL_SKU,
  MIXED_ORDER_PHYSICAL_SKU,
  seedTestCatalog,
  seedTestMixedOrder,
  seedTestOrder,
  sessionOf,
  signInTestMerchant,
  type TestCatalog,
  type TestKobai,
  type TestOrder,
  type TestSession,
} from "../testing/index.ts";
import {
  FULFILMENT_REFUSALS,
  FULFILMENT_STATES,
  FULFILMENT_TRANSITIONS,
  type FulfilmentState,
} from "./lifecycle.ts";

/**
 * **A Fulfilment moves, and the Order around it never does** — ADR-0014's central claim, reached
 * by the first feature that wanted a status column (#320).
 *
 * Everything is asserted at the HTTP seam, because that is where a Merchant meets the decision: a
 * transition is an explicit action route, an illegal one is refused with a word a client branches
 * on (ADR-0060), and *which* part of a mixed Order moved is visible in what the Order reports
 * afterwards. The one exception is the last `describe`, which asks Postgres a question no response
 * body can answer — that `core_order` gained no status column while all of this was being built.
 *
 * **Two kinds of assertion about the transitions, and it takes both.** The sweep enumerates every
 * (state, state) pair there is and reads `./lifecycle.ts`'s table for which of them is a 200 and
 * which a 409 — so it holds *the implementation to the table*, and a transition added or removed
 * moves it without an edit. What it cannot do is say the table is the one that was decided: it
 * reads the same source the code does, which is ADR-0049's trap, and a table changed by hand
 * would take the sweep along with it. So the moves that **are** the decision are also written out
 * by hand in the cases above it, where changing the table reddens them.
 *
 * Both halves were watched failing. The sweep, against an implementation whose one statement
 * accepted every state rather than the legal ones: nine cases went red naming the pairs. The
 * hand-written half, against a table with `dispatched → cancelled` removed, which reddened
 * *cancelling a parcel that was lost* and left the sweep entirely green — which is exactly the
 * gap the pair exists to cover.
 */

/** The route that asks for each state — the verb in the path, never a field in a body. */
const ACTION: Record<Exclude<FulfilmentState, "pending">, string> = {
  dispatched: "dispatch",
  delivered: "deliver",
  cancelled: "cancel",
};

/** Every state a route can ask for. `pending` is where Capture leaves one; nothing asks for it. */
const ASKABLE = FULFILMENT_STATES.filter((state) => state !== "pending");

type FulfilmentBody = {
  readonly id: string;
  readonly state: FulfilmentState;
  readonly trackingReference: string | null;
  readonly lineItemIds: readonly string[];
};

/** An Order as these tests read it, over the surface the test is asking through. */
async function readOrder(
  kobai: TestKobai,
  order: TestOrder,
  headers: Record<string, string>,
  surface: "admin" | "store" = "admin",
): Promise<readonly FulfilmentBody[]> {
  const response = await kobai.request(`/${surface}/orders/${order.id}`, { headers });
  expect(response.status, `reading the Order over /${surface}`).toBe(200);
  const body = (await response.json()) as { fulfilments: readonly FulfilmentBody[] };
  return body.fulfilments;
}

/** The Fulfilment covering the line for this SKU — by SKU, never by position. */
async function fulfilmentFor(
  kobai: TestKobai,
  order: TestOrder,
  sku: string,
): Promise<FulfilmentBody> {
  const lineId = order.lineItem(sku).id;
  const found = (await readOrder(kobai, order, order.catalog.merchant.headers)).find(
    (one) => one.lineItemIds.includes(lineId),
  );
  if (!found) throw new Error(`no Fulfilment covers the line for ${sku}`);
  return found;
}

/** Asks for a transition, exactly as a Merchant's client does. */
function ask(
  kobai: TestKobai,
  orderId: string,
  fulfilmentId: string,
  to: Exclude<FulfilmentState, "pending">,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<Response> {
  return kobai.request(
    `/admin/orders/${orderId}/fulfilments/${fulfilmentId}/${ACTION[to]}`,
    {
      method: "POST",
      headers:
        body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

/**
 * A Fulfilment already in a given state, arranged through the routes rather than with SQL.
 *
 * Every state but `pending` is reached by walking the legal moves to it, which is the only way
 * there is — and is why the arrangement is worth a helper: `delivered` takes two requests, and a
 * test about what a `delivered` Fulfilment refuses should not spell them.
 *
 * `catalog` is for a test that wants **two** of these, since a deployment has only ever one first
 * Merchant: seed one catalog and place an Order per call from it.
 */
async function aFulfilmentThatIs(
  kobai: TestKobai,
  state: FulfilmentState,
  catalog?: TestCatalog,
): Promise<{ order: TestOrder; fulfilment: FulfilmentBody }> {
  const order = await seedTestOrder(kobai, catalog === undefined ? {} : { catalog });
  const headers = order.catalog.merchant.headers;
  const [first] = await readOrder(kobai, order, headers);
  if (!first) throw new Error("this Order has no Fulfilment");

  const walk: Record<FulfilmentState, readonly Exclude<FulfilmentState, "pending">[]> = {
    pending: [],
    dispatched: ["dispatched"],
    delivered: ["dispatched", "delivered"],
    cancelled: ["cancelled"],
  };
  for (const step of walk[state]) {
    const moved = await ask(kobai, order.id, first.id, step, headers);
    expect(moved.status, `arranging a ${state} Fulfilment via ${step}`).toBe(200);
  }

  const arranged = (await readOrder(kobai, order, headers)).find(
    (one) => one.id === first.id,
  );
  if (!arranged) throw new Error("the arranged Fulfilment vanished");
  expect(arranged.state).toBe(state);
  return { order, fulfilment: arranged };
}

describe("a Merchant moves one Fulfilment of an Order", () => {
  it("dispatches it with a tracking reference, which kobai stores and reads nothing out of", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const headers = order.catalog.merchant.headers;
    const [pending] = await readOrder(kobai, order, headers);
    if (!pending) throw new Error("this Order has no Fulfilment");

    // Where Capture leaves it, said out loud: every assertion below is about a *change*, and one
    // that started where it ended would hold of a route that did nothing.
    expect(pending.state).toBe("pending");
    expect(pending.trackingReference).toBeNull();

    const dispatched = await ask(kobai, order.id, pending.id, "dispatched", headers, {
      // Deliberately not a number, not parseable and not a carrier kobai has heard of: the
      // promise is that it is stored and handed back, and nothing else.
      trackingReference: "  RR-123/456 ??? ",
    });

    expect(dispatched.status).toBe(200);
    await expect(dispatched.json()).resolves.toEqual({
      id: pending.id,
      strategy: "physical",
      requiresShipping: true,
      tracksInventory: true,
      hasLeadTime: false,
      state: "dispatched",
      trackingReference: "  RR-123/456 ??? ",
      lineItemIds: pending.lineItemIds,
    });
  });

  it("dispatches one that has nothing to track, and records no reference at all", async () => {
    // A download is dispatched by being sent, and there is no consignment number for it — so a
    // body is optional and an absent tracking reference is a real answer rather than a refusal.
    await using kobai = await createTestKobai();
    const order = await seedTestMixedOrder(kobai);
    const digital = await fulfilmentFor(kobai, order, MIXED_ORDER_DIGITAL_SKU);

    const dispatched = await ask(
      kobai,
      order.id,
      digital.id,
      "dispatched",
      order.catalog.merchant.headers,
    );

    expect(dispatched.status).toBe(200);
    await expect(dispatched.json()).resolves.toMatchObject({
      state: "dispatched",
      trackingReference: null,
    });
  });

  it("delivers a dispatched one, keeping the reference the dispatch recorded", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const headers = order.catalog.merchant.headers;
    const [one] = await readOrder(kobai, order, headers);
    if (!one) throw new Error("this Order has no Fulfilment");

    await ask(kobai, order.id, one.id, "dispatched", headers, {
      trackingReference: "RR123456789MY",
    });
    const delivered = await ask(kobai, order.id, one.id, "delivered", headers);

    expect(delivered.status).toBe(200);
    // The reference survives, which is the point: the parcel that arrived is the parcel that was
    // posted under that number, and a transition that cleared it would lose the fact.
    await expect(delivered.json()).resolves.toMatchObject({
      state: "delivered",
      trackingReference: "RR123456789MY",
    });
  });

  it("cancels one that never went, and one that went and was lost", async () => {
    // Both, in one case, because the pair *is* the decision: cancelling is not only a
    // before-it-left act, and a parcel lost in transit is exactly the part that cannot be
    // delivered (story 11). Cancelling is not a refund and gives nothing back — a Return is its
    // own spec — so the Order's total is untouched either way.
    await using kobai = await createTestKobai();
    // One catalog, two Orders placed from it: a deployment has only ever one first Merchant.
    const catalog = await seedTestCatalog(kobai);

    const untouched = await aFulfilmentThatIs(kobai, "pending", catalog);
    const beforeItLeft = await ask(
      kobai,
      untouched.order.id,
      untouched.fulfilment.id,
      "cancelled",
      untouched.order.catalog.merchant.headers,
    );
    expect(beforeItLeft.status).toBe(200);
    await expect(beforeItLeft.json()).resolves.toMatchObject({ state: "cancelled" });

    const posted = await aFulfilmentThatIs(kobai, "dispatched", catalog);
    const lost = await ask(
      kobai,
      posted.order.id,
      posted.fulfilment.id,
      "cancelled",
      posted.order.catalog.merchant.headers,
    );
    expect(lost.status).toBe(200);
    await expect(lost.json()).resolves.toMatchObject({ state: "cancelled" });

    // And the Order itself did not move, which is the whole of ADR-0014's claim: what changed is
    // a part of it, and the financial record is untouched (ADR-0009).
    const read = await kobai.request(`/admin/orders/${posted.order.id}`, {
      headers: posted.order.catalog.merchant.headers,
    });
    await expect(read.json()).resolves.toMatchObject({
      total: posted.order.total,
      payment: { amount: posted.order.total },
    });
  });

  it("will not deliver one that was never dispatched", async () => {
    // **The one arguable edge, pinned by hand** rather than left to the sweep below, which reads
    // the same table the code does. A thing handed over the counter was still dispatched, so
    // recording that first is one extra request — where `pending → delivered` would leave an
    // Order whose record cannot say when it left and no later request could put that back.
    await using kobai = await createTestKobai();
    const { order, fulfilment } = await aFulfilmentThatIs(kobai, "pending");

    const response = await ask(
      kobai,
      order.id,
      fulfilment.id,
      "delivered",
      order.catalog.merchant.headers,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "fulfilment-pending",
    });
  });

  it("reports the move on the Order, to the Merchant and to the Shopper alike", async () => {
    // `GET /store/orders/{id}` gains the state additively, which is ADR-0069's last Shopper
    // clause on this surface: the Shopper reads their own Order back and sees it has gone.
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const [one] = await readOrder(kobai, order, order.catalog.merchant.headers);
    if (!one) throw new Error("this Order has no Fulfilment");

    await ask(kobai, order.id, one.id, "dispatched", order.catalog.merchant.headers, {
      trackingReference: "RR123456789MY",
    });

    const merchantSees = await readOrder(
      kobai,
      order,
      order.catalog.merchant.headers,
      "admin",
    );
    const shopperSees = await readOrder(kobai, order, order.apiKey.headers, "store");

    expect(shopperSees).toEqual([
      expect.objectContaining({
        state: "dispatched",
        trackingReference: "RR123456789MY",
      }),
    ]);
    // Byte for byte the same record, which is what the two routes already promise about an
    // Order — a Merchant reading it over the phone is looking at what the Shopper is looking at.
    expect(shopperSees).toEqual(merchantSees);
  });
});

describe("each Fulfilment of a mixed Order moves on its own", () => {
  it("leaves the digital part exactly where it was when the physical one is dispatched", async () => {
    // **The case ADR-0014 exists for.** One Order, two Fulfilments, two timelines — asserted
    // against the same Order rather than against two convenient ones, because a status column on
    // `core_order` would satisfy every assertion that used two.
    await using kobai = await createTestKobai();
    const order = await seedTestMixedOrder(kobai);
    const headers = order.catalog.merchant.headers;
    const physical = await fulfilmentFor(kobai, order, MIXED_ORDER_PHYSICAL_SKU);
    const digital = await fulfilmentFor(kobai, order, MIXED_ORDER_DIGITAL_SKU);

    expect(physical.id).not.toBe(digital.id);

    const dispatched = await ask(kobai, order.id, physical.id, "dispatched", headers, {
      trackingReference: "RR123456789MY",
    });
    expect(dispatched.status).toBe(200);

    const after = await readOrder(kobai, order, headers);
    expect(after.find((one) => one.id === physical.id)).toMatchObject({
      state: "dispatched",
      trackingReference: "RR123456789MY",
    });
    expect(after.find((one) => one.id === digital.id)).toMatchObject({
      state: "pending",
      trackingReference: null,
    });
  });

  it("lets one be delivered while the other is cancelled", async () => {
    // The two ends of the lifecycle at once on one Order, which is the state a single column
    // cannot hold at all — and the reason the ADR calls it unfixable once there is order history.
    await using kobai = await createTestKobai();
    const order = await seedTestMixedOrder(kobai);
    const headers = order.catalog.merchant.headers;
    const physical = await fulfilmentFor(kobai, order, MIXED_ORDER_PHYSICAL_SKU);
    const digital = await fulfilmentFor(kobai, order, MIXED_ORDER_DIGITAL_SKU);

    await ask(kobai, order.id, digital.id, "dispatched", headers);
    await ask(kobai, order.id, digital.id, "delivered", headers);
    await ask(kobai, order.id, physical.id, "cancelled", headers);

    const after = await readOrder(kobai, order, headers);
    expect(Object.fromEntries(after.map((one) => [one.id, one.state]))).toEqual({
      [physical.id]: "cancelled",
      [digital.id]: "delivered",
    });
  });

  it("keeps the Order reporting its Fulfilments in the same order after one has moved", async () => {
    // The read is ordered by what the Strategy answered and then by id, deliberately not by
    // `state` — so dispatching one part must not shuffle the list a storefront is rendering.
    await using kobai = await createTestKobai();
    const order = await seedTestMixedOrder(kobai);
    const headers = order.catalog.merchant.headers;
    const before = (await readOrder(kobai, order, headers)).map((one) => one.id);
    const physical = await fulfilmentFor(kobai, order, MIXED_ORDER_PHYSICAL_SKU);

    await ask(kobai, order.id, physical.id, "dispatched", headers);

    expect(before).toHaveLength(2);
    expect((await readOrder(kobai, order, headers)).map((one) => one.id)).toEqual(before);
  });
});

describe("an invalid transition is refused with the state that refused it", () => {
  /**
   * **Every pair there is**, generated from `./lifecycle.ts` rather than listed here.
   *
   * Twelve cases — four states times the three a route can ask for — and the table decides which
   * are 200 and which are 409, so this cannot fall out of step with the decision it is checking.
   * The refusal is asserted by **word** and not only by status, because the word is the promised
   * half (ADR-0060) and a 409 with the wrong reason tells a client to do the wrong thing.
   */
  for (const from of FULFILMENT_STATES) {
    for (const to of ASKABLE) {
      const legal = (FULFILMENT_TRANSITIONS[from] as readonly FulfilmentState[]).includes(
        to,
      );

      it(`${legal ? "moves" : "refuses"} a ${from} Fulfilment asked to become ${to}`, async () => {
        await using kobai = await createTestKobai();
        const { order, fulfilment } = await aFulfilmentThatIs(kobai, from);

        const response = await ask(
          kobai,
          order.id,
          fulfilment.id,
          to,
          order.catalog.merchant.headers,
        );

        if (legal) {
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toMatchObject({ state: to });
          return;
        }

        // 409 on `cart-placed`'s distinction: the record is already somewhere this move cannot
        // be made from, and what a Merchant usually met is a colleague having got there first.
        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
          reason: FULFILMENT_REFUSALS[from],
        });
      });
    }
  }

  it("refuses cancelled going back to dispatched, which is the one #211 names by hand", async () => {
    // Said in its own case as well as inside the sweep above, because it is the refusal the spec
    // asks for by name — and because a sweep can be read as being about the mechanism.
    await using kobai = await createTestKobai();
    const { order, fulfilment } = await aFulfilmentThatIs(kobai, "cancelled");

    const response = await ask(
      kobai,
      order.id,
      fulfilment.id,
      "dispatched",
      order.catalog.merchant.headers,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      reason: "fulfilment-cancelled",
    });
  });

  it("names which half of the address was wrong", async () => {
    // Two addresses, two answers: `POST /admin/orders/{a}/fulfilments/{b}/…` can be wrong about
    // either, and a Merchant fixing it has to know which.
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const headers = order.catalog.merchant.headers;
    const [one] = await readOrder(kobai, order, headers);
    if (!one) throw new Error("this Order has no Fulfilment");

    const noOrder = await ask(kobai, MISSING_UUID, one.id, "dispatched", headers);
    expect(noOrder.status).toBe(404);
    await expect(noOrder.json()).resolves.toMatchObject({ reason: "order-not-found" });

    const noFulfilment = await ask(kobai, order.id, MISSING_UUID, "dispatched", headers);
    expect(noFulfilment.status).toBe(404);
    await expect(noFulfilment.json()).resolves.toMatchObject({
      reason: "fulfilment-not-found",
    });

    // Not an identifier at all — the same answer, because an identifier nothing carries and a
    // string that could never be one are one fact to the caller (`IdParam` says so).
    const nonsense = await ask(kobai, order.id, "not-an-id", "dispatched", headers);
    expect(nonsense.status).toBe(404);
    await expect(nonsense.json()).resolves.toMatchObject({
      reason: "fulfilment-not-found",
    });
  });

  it("refuses a Fulfilment belonging to another Order, although its identifier is real", async () => {
    // The reason the Order is in the address at all. Without the join this answers 200 and moves
    // a Fulfilment the Merchant was not looking at.
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const mine = await seedTestOrder(kobai, {
      catalog: await seedTestCatalog(kobai, { merchant }),
    });
    const theirs = await seedTestOrder(kobai, {
      // Its own title and its own SKU: a Product's handle is unique across the Store and so is a
      // SKU, so a second default catalog is refused rather than seeded (#251).
      catalog: await seedTestCatalog(kobai, {
        merchant,
        title: "A mug",
        variants: [{ sku: "MUG" }],
      }),
    });
    const [theirFulfilment] = await readOrder(kobai, theirs, merchant.headers);
    if (!theirFulfilment) throw new Error("that Order has no Fulfilment");

    const response = await ask(
      kobai,
      mine.id,
      theirFulfilment.id,
      "dispatched",
      merchant.headers,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "fulfilment-not-found",
    });
    // And it really did not move, which is the assertion the status alone does not make.
    expect((await readOrder(kobai, theirs, merchant.headers))[0]?.state).toBe("pending");
  });
});

describe("fulfilment:write is what moves a Fulfilment, and order:read is not", () => {
  /** A second Merchant on a Role holding exactly these words, made through the route. */
  async function aMerchantHolding(
    kobai: TestKobai,
    owner: TestSession,
    permissions: readonly string[],
  ): Promise<Record<string, string>> {
    const json = { ...owner.headers, "content-type": "application/json" };
    const role = await kobai.request("/admin/roles", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: `role-${permissions.join("-") || "none"}`,
        permissions,
      }),
    });
    expect(role.status, "creating the narrower Role").toBe(201);
    const made = (await role.json()) as { name: string };

    const email = `${made.name}@example.test`;
    const created = await kobai.request("/admin/merchants", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        email,
        password: "a-long-enough-password",
        role: made.name,
      }),
    });
    expect(created.status, "creating the narrower Merchant").toBe(201);

    const signedIn = await kobai.request("/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "a-long-enough-password" }),
    });
    expect(signedIn.status, "signing the narrower Merchant in").toBe(201);
    // Read off the response the way a browser would, and spread into the shape every request
    // below takes.
    return { ...sessionOf(signedIn).headers };
  }

  it("refuses every transition to a Merchant who may read Orders and nothing else", async () => {
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const [one] = await readOrder(kobai, order, order.catalog.merchant.headers);
    if (!one) throw new Error("this Order has no Fulfilment");

    const reader = await aMerchantHolding(kobai, order.catalog.merchant, ["order:read"]);

    for (const to of ASKABLE) {
      const response = await ask(kobai, order.id, one.id, to, reader);
      expect(response.status, `${ACTION[to]} without fulfilment:write`).toBe(403);
    }
    // Nothing moved, which is the assertion three 403s on their own do not make.
    expect(
      (await readOrder(kobai, order, order.catalog.merchant.headers))[0]?.state,
    ).toBe("pending");
  });

  it("lets a Merchant holding only order:read read every Fulfilment's state", async () => {
    // The other half, and the reason there is no `fulfilment:read`: a Fulfilment is read through
    // its Order, which `order:read` already covers, so a Role granted the books sees the states.
    await using kobai = await createTestKobai();
    const order = await seedTestMixedOrder(kobai);
    const physical = await fulfilmentFor(kobai, order, MIXED_ORDER_PHYSICAL_SKU);
    await ask(kobai, order.id, physical.id, "dispatched", order.catalog.merchant.headers);

    const reader = await aMerchantHolding(kobai, order.catalog.merchant, ["order:read"]);
    const response = await kobai.request(`/admin/orders/${order.id}`, {
      headers: reader,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { fulfilments: readonly FulfilmentBody[] };
    expect(body.fulfilments.map((one) => one.state).toSorted()).toEqual([
      "dispatched",
      "pending",
    ]);
  });

  it("lets warehouse staff dispatch while holding nothing else", async () => {
    // Story 16, said as a Role: `fulfilment:write` alone opens the three transitions, and the
    // Orders list it does not open is what makes the word worth having.
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);
    const [one] = await readOrder(kobai, order, order.catalog.merchant.headers);
    if (!one) throw new Error("this Order has no Fulfilment");

    const warehouse = await aMerchantHolding(kobai, order.catalog.merchant, [
      "fulfilment:write",
    ]);

    const dispatched = await ask(kobai, order.id, one.id, "dispatched", warehouse, {
      trackingReference: "RR123456789MY",
    });
    expect(dispatched.status).toBe(200);

    const books = await kobai.request(`/admin/orders/${order.id}`, {
      headers: warehouse,
    });
    expect(books.status, "reading the books without order:read").toBe(403);
  });
});

/**
 * **`core_order` gains no status column**, and this is the assertion ADR-0014 is actually held to.
 *
 * "Never a status on the Order" is easy to keep while nothing moves. The first feature that wanted
 * one is this ticket, so the claim is asked of Postgres here rather than left as prose — and it is
 * asked as a **sweep for anything that looks like a lifecycle** rather than for the word `status`,
 * because the cheap answer arrives spelled `fulfilment_status` at least as often.
 *
 * Paired with the positive half in the same case, because an emptiness assertion nobody has seen
 * fail is not yet known to be able to: `core_fulfilment` really does carry the state, so the sweep
 * is looking for a column that exists on the wrong table rather than for one nothing has.
 */
describe("the state lives on the Fulfilment and nowhere else", () => {
  /** What a lifecycle column would be called, whichever way somebody reached for one. */
  const LOOKS_LIKE_A_LIFECYCLE = /status|state|dispatch|deliver|cancel|fulfil/i;

  it("puts it on core_fulfilment and leaves core_order without one", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    // The qualified refs `tables()` hands back rather than bare names: a bare name resolves to
    // `public`, so a sweep aimed at the wrong schema finds no columns and reports the rule holds.
    const tables = await schema.tables();
    const refFor = (name: string) => {
      const found = tables.find((table) => table.name === name);
      if (!found) throw new Error(`this database has no ${name}`);
      return found;
    };

    const fulfilmentColumns = (await schema.columnsOf(refFor("core_fulfilment"))).map(
      (column) => column.name,
    );
    // The positive half first, so the sweep below is not vacuously green against a build that
    // never added the column anywhere at all.
    expect(fulfilmentColumns).toContain("state");
    expect(fulfilmentColumns).toContain("tracking_reference");

    const orderColumns = await schema.columnsOf(refFor("core_order"));
    const lifecycle = orderColumns
      .map((column) => column.name)
      .filter((name) => LOOKS_LIKE_A_LIFECYCLE.test(name));

    expect(
      lifecycle,
      `core_order carries ${lifecycle.join(", ")}. An Order does not move (ADR-0009); a Fulfilment does (ADR-0014), and core_fulfilment.state is where that goes.`,
    ).toEqual([]);
  });

  it("refuses a state Core has never heard of, at the database", async () => {
    // The `check` is `core_product.status`'s judgement rather than
    // `core_variant.fulfilment_strategy`'s: a Strategy is named by whatever a deployment wired
    // and is open, and these four are Core's own. Asked of Postgres, because that is the only
    // writer this constraint is there to catch — a Project, a Plugin, a hand-run `UPDATE`.
    await using kobai = await createTestKobai();
    const order = await seedTestOrder(kobai);

    await expect(
      kobai.database.query(
        "update core_fulfilment set state = 'posted' where order_id = $1",
        [order.id],
      ),
    ).rejects.toThrow(/core_fulfilment_state_is_known/);
  });
});

/** An identifier shaped like one and belonging to nothing. */
const MISSING_UUID = "00000000-0000-0000-0000-0000000000ff";
