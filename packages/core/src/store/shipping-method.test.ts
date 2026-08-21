import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * The ways a Store delivers into a Region — **a field of the Region, written whole** (#321).
 *
 * Through HTTP, like everything else about the admin surface. What is asserted here is the
 * Merchant's half: that a rate is created, renamed, repriced, reordered and removed through the
 * two Region writes, and that identity on the wire is what tells a rename from a removal and an
 * addition. What a Cart is *offered* and what a placement is *charged* is
 * `order/shipping.test.ts`, because those are questions a storefront asks.
 *
 * **There is no route of its own here and that is the decision.** Shipping methods ride
 * `POST /admin/regions` and `PATCH /admin/regions/{id}`, behind `store:write`, and are read by
 * reading the Region behind `store:read` — the same pair the enabled currencies ride, and the
 * same argument: a plural route over a table a Merchant can insert into would have had to page
 * (ADR-0064) for a handful of rows a Region already reports. Nothing about the gating is
 * asserted here for that reason: these are the Region routes, and `openapi.test.ts` already
 * holds every one of them to the Permission it declares.
 */

type ShippingMethod = {
  readonly id: string;
  readonly name: string;
  readonly amount: number;
  readonly metadata: Record<string, unknown>;
};

type Region = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly shippingMethods: readonly ShippingMethod[];
  readonly metadata: Record<string, unknown>;
};

type Refusal = { readonly reason?: string; readonly error?: string };

async function createRegion(
  kobai: TestKobai,
  merchant: TestSession,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: Region & Refusal }> {
  const response = await kobai.request("/admin/regions", {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Region & Refusal };
}

async function correctRegion(
  kobai: TestKobai,
  merchant: TestSession,
  id: string,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: Region & Refusal }> {
  const response = await kobai.request(`/admin/regions/${id}`, {
    method: "PATCH",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Region & Refusal };
}

describe("a Region carries the ways this Store delivers into it", () => {
  it("takes them at the create, and reads them back in the order they were declared", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const created = await createRegion(kobai, merchant, {
      name: "Malaysia",
      currency: "USD",
      shippingMethods: [
        { name: "Standard", amount: 500 },
        { name: "Next day", amount: 1500, metadata: { carrier: "poslaju" } },
      ],
    });

    expect(created.status).toBe(201);
    // **The Merchant's own order, kept**, which is what a storefront offers a Shopper in — so
    // `Standard` before `Next day` is a decision the Merchant made rather than an accident of
    // which row was written first.
    expect(created.body.shippingMethods).toEqual([
      { id: expect.any(String), name: "Standard", amount: 500, metadata: {} },
      {
        id: expect.any(String),
        name: "Next day",
        amount: 1500,
        metadata: { carrier: "poslaju" },
      },
    ]);

    // The same bytes a read answers with, because a Region is one record however it is reached.
    const read = await kobai.request(`/admin/regions/${created.body.id}`, {
      headers: merchant.headers,
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual(created.body);
  });

  /**
   * The whole list, in one request — the bargain a Product's `options` already take.
   *
   * Four things happen here at once and that is the point: one method is **renamed**, one is
   * **repriced**, one is **added** and one is **removed**, and a list of edits would have needed
   * four requests and still had no way to say *and this one is gone*.
   *
   * **The renamed one keeps its identifier**, which is the assertion doing the real work: a
   * reconciliation by name would have deleted `Standard` and created `Economy`, and taken every
   * Cart that had chosen it off the method it chose.
   */
  it("adds, renames, reprices and removes in one request, and a rename keeps its identifier", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const created = await createRegion(kobai, merchant, {
      name: "Malaysia",
      currency: "USD",
      shippingMethods: [
        { name: "Standard", amount: 500 },
        { name: "Next day", amount: 1500 },
      ],
    });
    const [standard, nextDay] = created.body.shippingMethods;

    const corrected = await correctRegion(kobai, merchant, created.body.id, {
      shippingMethods: [
        { id: standard?.id, name: "Economy", amount: 400 },
        { name: "Courier", amount: 2500 },
      ],
    });

    expect(corrected.status).toBe(200);
    expect(corrected.body.shippingMethods).toEqual([
      { id: standard?.id, name: "Economy", amount: 400, metadata: {} },
      { id: expect.any(String), name: "Courier", amount: 2500, metadata: {} },
    ]);
    // The one that was left out is gone rather than merely last, and the new one is not the one
    // that was removed wearing its identifier.
    expect(corrected.body.shippingMethods.map((one) => one.id)).not.toContain(
      nextDay?.id,
    );
  });

  it("reorders by the order of the list, and a body naming only the rates is not a body naming nothing", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const created = await createRegion(kobai, merchant, {
      name: "Malaysia",
      currency: "USD",
      shippingMethods: [
        { name: "Standard", amount: 500 },
        { name: "Next day", amount: 1500 },
      ],
    });
    const [standard, nextDay] = created.body.shippingMethods;

    const reordered = await correctRegion(kobai, merchant, created.body.id, {
      shippingMethods: [
        { id: nextDay?.id, name: "Next day", amount: 1500 },
        { id: standard?.id, name: "Standard", amount: 500 },
      ],
    });

    // A correction naming nothing this route would change is refused at 400 (ADR-0062), so this
    // case is also what says `shippingMethods` counts as something.
    expect(reordered.status).toBe(200);
    expect(reordered.body.shippingMethods.map((one) => one.name)).toEqual([
      "Next day",
      "Standard",
    ]);
    // The Region's own columns are untouched by a correction that named none of them.
    expect(reordered.body.name).toBe("Malaysia");
  });

  it("empties the list, and a Region with none prices no delivery", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const created = await createRegion(kobai, merchant, {
      name: "Malaysia",
      currency: "USD",
      shippingMethods: [{ name: "Standard", amount: 500 }],
    });

    const emptied = await correctRegion(kobai, merchant, created.body.id, {
      shippingMethods: [],
    });

    expect(emptied.status).toBe(200);
    // `toEqual` rather than `toMatchObject` on the array itself, which is what really asserts
    // the emptiness — an empty array inside `toMatchObject` holds the length and nothing else.
    expect(emptied.body.shippingMethods).toEqual([]);
  });

  /**
   * An `id` this Region has not got, refused rather than treated as a new method.
   *
   * **422 on `currency-not-enabled`'s distinction**: the body is well formed and what refuses it
   * is the state of the Store. Reachable from the create too, and only one way — a create names
   * a Region that was written a statement ago and carries no method at all — which is why the
   * create declares the word rather than leaving it to the correction.
   */
  it("refuses an entry naming a method this Region has not got, at the create and at the correction", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const elsewhere = await createRegion(kobai, merchant, {
      name: "Elsewhere",
      currency: "USD",
      shippingMethods: [{ name: "Standard", amount: 500 }],
    });
    const stranger = elsewhere.body.shippingMethods[0]?.id ?? "";

    const atTheCreate = await createRegion(kobai, merchant, {
      name: "Malaysia",
      currency: "USD",
      shippingMethods: [{ id: stranger, name: "Standard", amount: 500 }],
    });
    expect(atTheCreate.status).toBe(422);
    expect(atTheCreate.body.reason).toBe("shipping-method-not-found");

    // **And no Region was made**, which is the half a status could never say: a refusal handed
    // back out of a transaction *commits* it, so a create that judged its rates after inserting
    // the Region would answer 422 over a Region it had just created — and a Merchant told their
    // request was refused would find `Malaysia` in the list.
    const listed = (await (
      await kobai.request("/admin/regions", { headers: merchant.headers })
    ).json()) as { regions: readonly Region[] };
    expect(listed.regions.map((one) => one.name)).not.toContain("Malaysia");

    const here = await createRegion(kobai, merchant, {
      name: "Home",
      currency: "USD",
      shippingMethods: [{ name: "Standard", amount: 500 }],
    });
    // **A method of another Region is a method this Region has not got**, which is the same
    // fact: a rate is denominated in the currency the Region that carries it selects, so
    // borrowing one would charge in a currency nothing else on the Order is in.
    const atTheCorrection = await correctRegion(kobai, merchant, here.body.id, {
      shippingMethods: [{ id: stranger, name: "Standard", amount: 500 }],
    });
    expect(atTheCorrection.status).toBe(422);
    expect(atTheCorrection.body.reason).toBe("shipping-method-not-found");

    // And the Region was left exactly as it was: the refusal is made before the first write, so
    // a correction that was turned down did not rewrite the rates it was turned down over.
    const read = (await (
      await kobai.request(`/admin/regions/${here.body.id}`, { headers: merchant.headers })
    ).json()) as Region;
    expect(read.shippingMethods.map((one) => one.name)).toEqual(["Standard"]);
  });

  it("refuses a rate that is not a whole number of minor units, and one that is negative", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    for (const amount of [-1, 5.5, "500"]) {
      const refused = await createRegion(kobai, merchant, {
        name: "Malaysia",
        currency: "USD",
        shippingMethods: [{ name: "Standard", amount }],
      });

      // 400 rather than 422: this does not fit the endpoint's schema at all, which is the line
      // this surface draws between a body it cannot read and a body naming a record the Store
      // has not got.
      expect(refused.status, JSON.stringify(amount)).toBe(400);
      expect(refused.body.reason).toBe("invalid");
    }
  });

  it("refuses a body that names one method twice as the body's own fault", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const created = await createRegion(kobai, merchant, {
      name: "Malaysia",
      currency: "USD",
      shippingMethods: [{ name: "Standard", amount: 500 }],
    });
    const standard = created.body.shippingMethods[0]?.id;

    const refused = await correctRegion(kobai, merchant, created.body.id, {
      shippingMethods: [
        { id: standard, name: "Standard", amount: 500 },
        { id: standard, name: "Standard again", amount: 900 },
      ],
    });

    // **400 `invalid` rather than the Store's own word**, which is the line `POST
    // /admin/products` already draws for a SKU named twice: a body conflicting with itself is
    // not the Store refusing anything, and no retry of it as it stands will be taken. Calling
    // it `shipping-method-not-found` would be *not found* about an id that was found.
    expect(refused.status).toBe(400);
    expect(refused.body.reason).toBe("invalid");
  });
});
