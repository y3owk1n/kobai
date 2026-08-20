import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCart,
  type TestCart,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **Correcting an Address a year later does not rewrite where a past parcel went** (#319,
 * ADR-0009, ADR-0072).
 *
 * Capture copies the Cart's Address onto the Order, exactly as it copies a Line Item's title and
 * price. What that has to survive is everything that can happen to the row it was copied *from*:
 * a Shopper correcting it, a Shopper removing it, and a Merchant deleting the Region it named.
 * So the arrangements below reach past the API and edit the source row directly — ADR-0004's
 * unmediated writer, which is the strongest form of the question and the one no route can ask,
 * since a placed Cart refuses every change through the surface.
 *
 * **What is asserted is the Order's answer, never how it is stored.** If `core_order_address`
 * were replaced tomorrow by something else that still answered these bytes, every case here
 * would stay green — which is the property that makes them worth keeping.
 *
 * The Cart's half — setting one, replacing it, taking it off, and what Core does and does not
 * check about it — is `cart/an-address-on-a-cart.test.ts`.
 */

const ADDRESS = {
  country: "MY",
  lines: ["12 Jalan Ampang", "Kuala Lumpur"],
  postalCode: "50450",
} as const;

type OrderBody = {
  readonly id: string;
  readonly address: {
    readonly country: string;
    readonly lines: readonly string[];
    readonly postalCode: string | null;
    readonly region: { readonly id: string | null; readonly name: string } | null;
  } | null;
};

/** A Cart addressed to {@link ADDRESS}, placed — and the Order that came out of it. */
async function placeAddressed(
  kobai: TestKobai,
  address: Record<string, unknown> = { ...ADDRESS },
): Promise<{ cart: TestCart; order: OrderBody }> {
  const cart = await seedTestCart(kobai);

  const addressed = await kobai.request(`/store/carts/${cart.id}`, {
    method: "PATCH",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  expect(addressed.status, "addressing the Cart").toBe(200);

  const placed = await kobai.request("/store/orders", {
    method: "POST",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ cartId: cart.id }),
  });
  expect(placed.status, "placing the Cart").toBe(201);

  return { cart, order: (await placed.json()) as OrderBody };
}

/** The Order as a storefront reads it back. */
async function readOrder(
  kobai: TestKobai,
  cart: TestCart,
  orderId: string,
): Promise<OrderBody> {
  const response = await kobai.request(`/store/orders/${orderId}`, {
    headers: cart.apiKey.headers,
  });
  expect(response.status, "reading the Order back").toBe(200);
  return (await response.json()) as OrderBody;
}

/** A Region this Store sells into, beside the default one seeded at boot. */
async function createRegion(
  kobai: TestKobai,
  cart: TestCart,
  name: string,
): Promise<string> {
  const response = await kobai.request("/admin/regions", {
    method: "POST",
    headers: {
      ...cart.catalog.merchant.headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name, currency: "USD" }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("Capture snapshots the Address", () => {
  it("reports it on the Order the placement answered with and on every read after", async () => {
    await using kobai = await createTestKobai();
    const { cart, order } = await placeAddressed(kobai);

    const destination = {
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: null,
    };
    expect(order.address).toEqual(destination);
    // The same bytes on a later read: Capture answers with the record, and reading it back
    // answers with the record, so the two cannot differ.
    expect((await readOrder(kobai, cart, order.id)).address).toEqual(destination);

    // And to the Merchant, behind `order:read` — the one Permission an Order has and the one
    // this needs no addition to (#319).
    const merchantsView = await kobai.request(`/admin/orders/${order.id}`, {
      headers: cart.catalog.merchant.headers,
    });
    expect(merchantsView.status).toBe(200);
    expect(((await merchantsView.json()) as OrderBody).address).toEqual(destination);
  });

  it("leaves the Order's destination alone when the source Address row is edited", async () => {
    await using kobai = await createTestKobai();
    const { cart, order } = await placeAddressed(kobai);

    // A Shopper correcting their details a year later, in its most direct form: the row itself.
    // Whatever route eventually offers this, the Order must not follow it (ADR-0009).
    await kobai.database.query(
      `update core_address set country = 'SG', lines = ARRAY['1 Raffles Place'], postal_code = '048616'`,
    );

    expect((await readOrder(kobai, cart, order.id)).address).toEqual({
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: null,
    });
  });

  it("leaves it alone when the source Address row is deleted outright", async () => {
    await using kobai = await createTestKobai();
    const { cart, order } = await placeAddressed(kobai);

    await kobai.database.query(`delete from core_address`);

    // Not merely present: the same destination. A snapshot that survived as `null` would be a
    // record of an Order that went nowhere.
    expect((await readOrder(kobai, cart, order.id)).address).toEqual({
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: null,
    });
  });

  it("is absent for a Cart that carried none, which is an ordinary Order", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const placed = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });

    expect(placed.status).toBe(201);
    expect(((await placed.json()) as OrderBody).address).toBeNull();
  });
});

describe("deleting the Region an Address named", () => {
  it("leaves the Cart's Address whole and drops only the Region", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const regionId = await createRegion(kobai, cart, "Malaysia");

    const addressed = await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ address: { ...ADDRESS, regionId } }),
    });
    expect(addressed.status).toBe(200);

    const deleted = await kobai.request(`/admin/regions/${regionId}`, {
      method: "DELETE",
      headers: cart.catalog.merchant.headers,
    });
    // Not refused: the rows a refusal would name are Shoppers' Carts, and no Merchant can empty
    // one — so ADR-0059's test (is the repair a control the Merchant has) says `set null`.
    expect(deleted.status).toBe(204);

    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      readonly address: {
        readonly lines: readonly string[];
        readonly region: unknown;
      } | null;
    };
    // The street did not move. Deleting a Region drops the grouping — the one part of an
    // Address that was kobai's rather than the Shopper's — and nothing else.
    expect(body.address).toEqual({
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: null,
    });
  });

  it("leaves a placed Order still saying where the parcel went", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const regionId = await createRegion(kobai, cart, "Malaysia");

    const addressed = await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ address: { ...ADDRESS, regionId } }),
    });
    expect(addressed.status).toBe(200);

    const placed = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    expect(placed.status).toBe(201);
    const order = (await placed.json()) as OrderBody;
    expect(order.address?.region).toEqual({ id: regionId, name: "Malaysia" });

    const deleted = await kobai.request(`/admin/regions/${regionId}`, {
      method: "DELETE",
      headers: cart.catalog.merchant.headers,
    });
    expect(deleted.status).toBe(204);

    // The **name** survives and the identifier does not, which is `OrderLineItem.variantId`
    // beside `title` one noun along: navigation goes, and what a person reads stays.
    expect((await readOrder(kobai, cart, order.id)).address).toEqual({
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: { id: null, name: "Malaysia" },
    });
  });

  it("leaves a placed Order alone when the Region is merely renamed", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const regionId = await createRegion(kobai, cart, "Malaysia");

    await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ address: { ...ADDRESS, regionId } }),
    });
    const placed = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    expect(placed.status).toBe(201);
    const order = (await placed.json()) as OrderBody;

    const renamed = await kobai.request(`/admin/regions/${regionId}`, {
      method: "PATCH",
      headers: {
        ...cart.catalog.merchant.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Peninsular Malaysia" }),
    });
    expect(renamed.status).toBe(200);

    // The Region is still there, so the identifier still navigates to it — and the name is the
    // one taken at Capture rather than the one it answers to now. A read that joined would
    // report the new name, which is exactly the rewriting ADR-0009 exists to prevent.
    expect((await readOrder(kobai, cart, order.id)).address?.region).toEqual({
      id: regionId,
      name: "Malaysia",
    });
  });
});
