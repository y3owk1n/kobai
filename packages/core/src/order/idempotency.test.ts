import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  type TestKobai,
} from "../testing/index.ts";
import { defineStep } from "../workflow/step.ts";
import type { PaidOrder } from "./place-order.ts";

/**
 * **Idempotent `place-order`** — a storefront that retried after a timeout gets the Order it
 * already has, rather than a second one (#102).
 *
 * The failure this is against is the expensive kind: a request that timed out on the wire
 * succeeded on the server, and the retry every HTTP client makes by itself charges the Shopper
 * twice. Everything here is dispatched at the public API against a real Postgres, because the
 * question is what a storefront actually receives — and every count is asserted against the
 * database, because a tidy answer to the second request proves nothing about what was written.
 */

/** What a storefront sends, with the key it carries when it wants a retry to be safe. */
async function place(
  kobai: TestKobai,
  headers: Record<string, string>,
  cartId: string,
  key?: string,
): Promise<Response> {
  return kobai.request("/store/orders", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    body: JSON.stringify({ cartId }),
  });
}

/** How many Orders exist, which is the only assertion that can see a double charge. */
async function ordersIn(kobai: TestKobai): Promise<number> {
  return (await kobai.database.query("select id from core_order")).length;
}

/**
 * One moment a test waits for, and the same moment something else announces.
 *
 * What it buys is a concurrency test with no timing in it: a request is held exactly where the
 * test needs it rather than for however long a `setTimeout` seemed generous, so the assertion is
 * about the state the server is in and not about how fast the machine running it is.
 */
function signal(): { readonly fired: Promise<void>; fire(): void } {
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire: () => fire() };
}

describe("a retry carrying the key its first attempt did", () => {
  it("answers with the Order that first attempt placed, and writes no second one", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const first = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");
    const again = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");

    expect(first.status).toBe(201);
    // 200 rather than 201: nothing was created this time, and a storefront rendering the
    // confirmation cannot tell the difference from the body.
    expect(again.status).toBe(200);
    const { workflow: _ran, ...record } = (await first.json()) as {
      workflow: unknown;
      id: string;
    };
    await expect(again.json()).resolves.toEqual(record);
    await expect(ordersIn(kobai)).resolves.toBe(1);
  });

  it("keeps answering with it however many times the request is repeated", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const first = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");
    const placed = (await first.json()) as { id: string };
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");

      expect(again.status).toBe(200);
      await expect(again.json()).resolves.toMatchObject({ id: placed.id });
    }

    await expect(ordersIn(kobai)).resolves.toBe(1);
  });
});

describe("a key used for something else", () => {
  it("is refused rather than answered with the Order it already placed", async () => {
    // A programming error, not a retry — and answering it with somebody else's Order would be
    // worse than failing, because the storefront would render a confirmation for a purchase
    // nobody made.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const bought = await seedTestCart(kobai, { catalog });
    const another = await seedTestCart(kobai, { catalog });

    await place(kobai, catalog.apiKey.headers, bought.id, "one-checkout");
    const confused = await place(
      kobai,
      catalog.apiKey.headers,
      another.id,
      "one-checkout",
    );

    expect(confused.status).toBe(409);
    await expect(confused.json()).resolves.toMatchObject({
      reason: "idempotency-key-reused",
    });
    // The second Cart was never touched: it can still be placed, with a key of its own.
    await expect(ordersIn(kobai)).resolves.toBe(1);
    const properly = await place(kobai, catalog.apiKey.headers, another.id, "the-other");
    expect(properly.status).toBe(201);
  });

  it("takes the same key back once its window has passed", async () => {
    // What stops a key being held for ever by a process that died mid-request. Time is passed
    // by winding the row back rather than by waiting, the way every other window here is.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const bought = await seedTestCart(kobai, { catalog });
    const later = await seedTestCart(kobai, { catalog });

    await place(kobai, catalog.apiKey.headers, bought.id, "one-checkout");
    await kobai.database.query(
      "update core_idempotency_key set expires_at = now() - interval '1 second'",
    );

    const reused = await place(kobai, catalog.apiKey.headers, later.id, "one-checkout");

    expect(reused.status).toBe(201);
    await expect(ordersIn(kobai)).resolves.toBe(2);
  });
});

describe("a key that is not one", () => {
  it("is refused rather than quietly treated as no key at all", async () => {
    // The failure worth catching: a storefront that computed an empty key would get no
    // protection and no sign that it had none, which is the same double charge with a
    // reassuring header on it.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await place(kobai, cart.apiKey.headers, cart.id, "");

    expect(response.status).toBe(400);
    await expect(ordersIn(kobai)).resolves.toBe(0);
  });
});

describe("a request that placed nothing gives its key back", () => {
  it("lets the same key place the Order once the Cart is fixed", async () => {
    // A refused attempt created nothing for the key to name, so holding it would refuse the
    // retry that puts the mistake right — which is the opposite of what a key is for.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await seedTestCart(kobai, { catalog, lines: [] });

    const empty = await place(kobai, catalog.apiKey.headers, cart.id, "one-checkout");
    expect(empty.status).toBe(422);
    await kobai.request(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      headers: { ...catalog.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ variantId: catalog.variantId }),
    });

    const placed = await place(kobai, catalog.apiKey.headers, cart.id, "one-checkout");

    expect(placed.status).toBe(201);
    await expect(ordersIn(kobai)).resolves.toBe(1);
  });
});

describe("a key whose first attempt never came back", () => {
  it("is refused while that attempt is still running, and says which", async () => {
    // The in-flight state, reached deliberately rather than by hoping two requests interleave:
    // a Step of this deployment's own holds the first request open at the point of no return,
    // which is one Step past where a slow Payment Provider holds it — payment has been taken by
    // the time this runs, so the second request meets a key whose first attempt has money on it.
    const arrival = signal();
    const carryOn = signal();
    const holdOn = defineStep("hold-on", async (input: PaidOrder): Promise<PaidOrder> => {
      arrival.fire();
      await carryOn.fired;
      return input;
    });
    await using kobai = await createTestKobai({
      workflows: { "place-order": { before: { "capture-order": [holdOn] } } },
    });
    const cart = await seedTestCart(kobai);

    const first = place(kobai, cart.apiKey.headers, cart.id, "one-checkout");
    await arrival.fired;
    const second = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      reason: "idempotency-key-in-progress",
    });
    carryOn.fire();
    expect((await first).status).toBe(201);
    await expect(ordersIn(kobai)).resolves.toBe(1);
  });

  it("answers with the Order anyway when that attempt captured and stopped there", async () => {
    // The window between the Order's commit and the key being told about it. A process that
    // died in it would otherwise refuse every retry for the length of the key's lifetime — the
    // timeout-then-retry this whole mechanism exists for. The Order is the record, so the
    // answer is recovered from it rather than from the key.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const first = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");
    const placed = (await first.json()) as { id: string };

    // The crash, in the one state it leaves behind: the Order is there and the key names
    // nothing.
    await kobai.database.query("update core_idempotency_key set order_id = null");

    const again = await place(kobai, cart.apiKey.headers, cart.id, "one-checkout");

    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toMatchObject({ id: placed.id });
    await expect(ordersIn(kobai)).resolves.toBe(1);
  });
});

describe("requests carrying one key at the same instant", () => {
  /**
   * The case a sequential retry cannot reach, and the one the key exists for: a storefront
   * whose client library fired the retry before the first request came back.
   *
   * The claim is a single `insert … on conflict`, so exactly one of these gets to run whatever
   * order they interleave in. What each of the others is told depends on whether the winner has
   * captured yet — the Order, or that its key is still in flight — and the assertion is on the
   * thing that must be true either way.
   */
  it("place exactly one Order between them", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        place(kobai, cart.apiKey.headers, cart.id, "one-checkout"),
      ),
    );

    await expect(ordersIn(kobai)).resolves.toBe(1);
    const placed = responses.filter((response) => response.status === 201);
    expect(placed).toHaveLength(1);
    for (const other of responses.filter((response) => response.status !== 201)) {
      // 409 while the first is still running, 200 with the Order once it is not. Never a 500,
      // and never a second 201.
      expect([200, 409]).toContain(other.status);
    }
  });

  it("place exactly one Order under different keys, too", async () => {
    // Different keys are different intentions, so idempotency has nothing to say about them —
    // and there is still only one Order, because a Cart becomes exactly one. That is the Cart
    // decision doing the work rather than the key.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const responses = await Promise.all(
      Array.from({ length: 4 }, (_unused, attempt) =>
        place(kobai, cart.apiKey.headers, cart.id, `checkout-${attempt}`),
      ),
    );

    await expect(ordersIn(kobai)).resolves.toBe(1);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    for (const refused of responses.filter((response) => response.status !== 201)) {
      expect(refused.status).toBe(409);
      await expect(refused.json()).resolves.toMatchObject({ reason: "cart-placed" });
    }
  });
});
