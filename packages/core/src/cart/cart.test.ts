import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * The Cart, on the store surface — a Shopper's mutable, disposable, unauthoritative selection
 * before purchase (`CONTEXT.md`, ADR-0009).
 *
 * Everything here is dispatched at the public API against a real Postgres, because that is
 * what a storefront actually has: an API key, a Cart identifier, and no Shopper of any kind.
 */

describe("building a Cart", () => {
  it("creates one for a guest, and reads it back empty", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const created = await kobai.request("/store/carts", {
      method: "POST",
      headers: catalog.apiKey.headers,
    });
    expect(created.status).toBe(201);
    const cart = (await created.json()) as { id: string };

    const read = await kobai.request(`/store/carts/${cart.id}`, {
      headers: catalog.apiKey.headers,
    });

    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual({
      id: cart.id,
      // No Shopper: Core never assumes one, and a guest is the ordinary path (ADR-0020).
      shopper: null,
      // Denominated at the moment it was started, from the Store's default Region, because
      // this request named no Region at all — which is every request a single-market
      // storefront makes (#293, ADR-0074).
      currency: "USD",
      region: { id: expect.any(String), name: "USD", currency: "USD" },
      // Nowhere to deliver it, which is where a Cart starts: nothing makes an Address
      // mandatory, and a storefront asks for one when it is ready to (#319).
      address: null,
      // Nothing chosen, which is where every Cart starts and is what a Cart of downloads stays
      // at: `select-shipping` charges what was chosen and charges nothing where nothing was
      // (#321).
      shippingMethod: null,
      lineItems: [],
      metadata: {},
      expiresAt: expect.any(String),
      expired: false,
      // Nothing has been bought from it, which is what a Cart a storefront just started says.
      placed: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("starts one in the Region the storefront named, denominated in its currency", async () => {
    // A storefront that has already asked a Shopper where they are starts the Cart there,
    // rather than starting it in the wrong currency and switching (#293).
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const enabled = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currencies: [{ code: "USD" }, { code: "MYR" }] }),
    });
    expect(enabled.status).toBe(200);
    const created = await kobai.request("/admin/regions", {
      method: "POST",
      headers: { ...catalog.merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Malaysia", currency: "MYR" }),
    });
    const malaysia = ((await created.json()) as { id: string }).id;

    const cart = await kobai.request("/store/carts", {
      method: "POST",
      headers: { ...catalog.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ regionId: malaysia }),
    });

    expect(cart.status).toBe(201);
    // The currency is stamped from the Region rather than read through it from here on — see
    // `a-cart-switches-region.test.ts`, where a Region moved onto another currency leaves this
    // Cart exactly where it was.
    await expect(cart.json()).resolves.toMatchObject({
      currency: "MYR",
      region: { id: malaysia, name: "Malaysia", currency: "MYR" },
    });
  });

  it("refuses a Region this Store has not got, and starts no Cart", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const response = await kobai.request("/store/carts", {
      method: "POST",
      headers: { ...catalog.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ regionId: "2f1b8a5e-0000-4000-8000-000000000000" }),
    });

    // 422 and the admin surface's own word: the body is well formed, and what refuses it is the
    // state of the Store (ADR-0060 — one fact, one word, whichever end asks).
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "region-not-found" });
  });

  it("takes a publishable key, which is what a browser holds", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    const created = await kobai.request("/store/carts", {
      method: "POST",
      headers: publishable.headers,
    });

    expect(created.status).toBe(201);
  });

  it("adds a Variant, changes the quantity, removes the line, and reads it all back", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers);

    const added = await kobai.request(`/store/carts/${cart}/line-items`, {
      method: "POST",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ variantId: catalog.variantId, quantity: 2 }),
    });
    expect(added.status).toBe(200);
    const withLine = (await added.json()) as CartBody;
    expect(withLine.lineItems).toEqual([
      {
        id: expect.any(String),
        variant: { id: catalog.variantId, sku: "POSTER-A2" },
        quantity: 2,
        metadata: {},
      },
    ]);

    const lineItemId = lineOf(withLine, "POSTER-A2").id;
    const changed = await kobai.request(`/store/carts/${cart}/line-items/${lineItemId}`, {
      method: "PATCH",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ quantity: 5 }),
    });
    expect(changed.status).toBe(200);
    expect(lineOf((await changed.json()) as CartBody, "POSTER-A2").quantity).toBe(5);

    // The whole Cart comes back from a removal too, so a storefront re-renders from the
    // response rather than by asking again.
    const removed = await kobai.request(`/store/carts/${cart}/line-items/${lineItemId}`, {
      method: "DELETE",
      headers: catalog.apiKey.headers,
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as CartBody).lineItems).toEqual([]);

    const read = await kobai.request(`/store/carts/${cart}`, {
      headers: catalog.apiKey.headers,
    });
    expect(((await read.json()) as CartBody).lineItems).toEqual([]);
  });

  it("raises the quantity when the same Variant is added twice", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers);

    await addLine(kobai, cart, catalog.apiKey.headers, catalog.variantId, 2);
    const again = await addLine(
      kobai,
      cart,
      catalog.apiKey.headers,
      catalog.variantId,
      3,
    );

    // One line, not two: a Shopper who adds the same poster twice should not see it listed
    // twice, and the unique constraint is what makes that true of concurrent adds as well.
    expect(again.lineItems).toHaveLength(1);
    expect(lineOf(again, "POSTER-A2").quantity).toBe(5);
  });

  it("keeps a second Variant as its own line", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "MUG", prices: [800] }],
    });
    const cart = await startCart(kobai, catalog.apiKey.headers);

    await addLine(kobai, cart, catalog.apiKey.headers, catalog.variantId);
    const both = await addLine(
      kobai,
      cart,
      catalog.apiKey.headers,
      catalog.variant("MUG").id,
    );

    expect(both.lineItems.map((line) => line.variant.sku)).toEqual(["POSTER-A2", "MUG"]);
  });

  it("refuses a Variant carrying no Price", async () => {
    await using kobai = await createTestKobai();
    // One Variant priced and one not, in the same Store, so the refusal is about this Variant
    // rather than about an empty catalog.
    const catalog = await seedTestCatalog(kobai, {
      variants: [{ prices: [1250] }, { sku: "UNPRICED", prices: [] }],
    });
    const cart = await startCart(kobai, catalog.apiKey.headers);

    const response = await kobai.request(`/store/carts/${cart}/line-items`, {
      method: "POST",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ variantId: catalog.variant("UNPRICED").id }),
    });

    // 422: the request is well formed and the Store still cannot sell the thing. Finding this
    // out at Capture would be finding it out from the Shopper.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "variant-not-priced",
    });
  });

  it("refuses a Variant that does not exist, and one that is not an identifier", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers);

    for (const variantId of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/carts/${cart}/line-items`, {
        method: "POST",
        headers: jsonHeaders(catalog.apiKey.headers),
        body: JSON.stringify({ variantId }),
      });

      expect(response.status, variantId).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "variant-not-found",
      });
    }
  });

  it("refuses a quantity of zero rather than treating it as a removal", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers);
    const line = lineOf(
      await addLine(kobai, cart, catalog.apiKey.headers, catalog.variantId),
      "POSTER-A2",
    );

    const response = await kobai.request(`/store/carts/${cart}/line-items/${line.id}`, {
      method: "PATCH",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ quantity: 0 }),
    });

    expect(response.status).toBe(400);
    // And the line is still there — a refused change changes nothing.
    const read = await kobai.request(`/store/carts/${cart}`, {
      headers: catalog.apiKey.headers,
    });
    expect(((await read.json()) as CartBody).lineItems).toHaveLength(1);
  });
});

describe("a Cart's identifier is the whole of the authority over it", () => {
  it("is unguessable, and unrelated to any other Cart's", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const ids = await Promise.all(
      [1, 2, 3].map(() => startCart(kobai, catalog.apiKey.headers)),
    );

    // Random version-4 UUIDs: 122 bits from the platform CSPRNG, so nothing about one Cart's
    // identifier says anything about the next. A sequence, or anything ordered, would make
    // holding one Cart an invitation to walk to the others.
    for (const id of ids) {
      expect(id, id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(new Set(ids).size).toBe(3);
  });

  it("opens that Cart and no other", async () => {
    await using kobai = await createTestKobai();
    const mine = await seedTestCart(kobai, { lines: [] });
    const theirs = await seedTestCart(kobai, { catalog: mine.catalog });

    // The same API key, and still no reach: naming another Cart's Line Item under a Cart you
    // hold is not found, because the Cart's identifier is what scopes the operation.
    const response = await kobai.request(
      `/store/carts/${mine.id}/line-items/${theirs.lineItem("POSTER-A2").id}`,
      { method: "DELETE", headers: mine.apiKey.headers },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      reason: "line-item-not-found",
    });
  });

  it("answers 404 for a Cart nobody holds, and for a string that is not one", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-id"]) {
      const response = await kobai.request(`/store/carts/${id}`, {
        headers: catalog.apiKey.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ reason: "cart-not-found" });
    }
  });

  it("is reachable by no listing a storefront's key opens", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await startCart(kobai, catalog.apiKey.headers);

    // The identifier is the credential, so a route handing out every Cart would hand out every
    // credential — and this key is the one a storefront holds. **A Merchant may enumerate them
    // and the public may not** is the amended rule (ADR-0071), and this is the half of it that
    // did not move: `GET /admin/carts` exists behind a session and `cart:read`, and there is
    // still deliberately nothing here.
    const onTheStore = await kobai.request("/store/carts", {
      headers: catalog.apiKey.headers,
    });

    expect(onTheStore.status).toBe(404);
    // …and the Merchant's list, which does exist, is not opened by that key either: a store
    // credential is worth nothing on the admin surface (ADR-0020).
    const withAStoreKey = await kobai.request("/admin/carts", {
      headers: catalog.apiKey.headers,
    });
    expect(withAStoreKey.status).toBe(401);
  });
});

describe("a Shopper reference is asserted, never authenticated", () => {
  it("is attached over a secret key, and detached the same way", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers);

    const attached = await kobai.request(`/store/carts/${cart}`, {
      method: "PATCH",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({
        shopper: { email: "shopper@example.test", externalId: "auth0|42" },
      }),
    });
    expect(attached.status).toBe(200);
    expect(((await attached.json()) as CartBody).shopper).toEqual({
      email: "shopper@example.test",
      externalId: "auth0|42",
    });

    const detached = await kobai.request(`/store/carts/${cart}`, {
      method: "PATCH",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ shopper: null }),
    });
    expect(((await detached.json()) as CartBody).shopper).toBeNull();
  });

  it("refuses a publishable key, which a browser holds", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });
    const cart = await startCart(kobai, publishable.headers);

    // 403 rather than 401: the credential is valid and insufficient. Core trusts the identity
    // a storefront asserts over a *secret server-side* key (ADR-0020) — over a browser's key
    // the assertion would be the Shopper's own.
    const response = await kobai.request(`/store/carts/${cart}`, {
      method: "PATCH",
      headers: jsonHeaders(publishable.headers),
      body: JSON.stringify({ shopper: { email: "shopper@example.test" } }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "secret-key-required",
    });
  });

  it("lets a publishable key detach one, because that asserts nothing", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });
    const cart = await startCart(kobai, catalog.apiKey.headers, {
      shopper: { email: "shopper@example.test" },
    });

    // The rule is about a claim over who somebody *is*, and `null` makes none — a browser
    // signing a Shopper out has no secret key to reach for, and needs none.
    const response = await kobai.request(`/store/carts/${cart}`, {
      method: "PATCH",
      headers: jsonHeaders(publishable.headers),
      body: JSON.stringify({ shopper: null }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as CartBody).shopper).toBeNull();
  });

  it("refuses a publishable key at creation too, and creates nothing", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const publishable = await createTestApiKey(kobai, catalog.merchant, {
      name: "browser",
      kind: "publishable",
    });

    const response = await kobai.request("/store/carts", {
      method: "POST",
      headers: jsonHeaders(publishable.headers),
      body: JSON.stringify({ shopper: { email: "shopper@example.test" } }),
    });

    expect(response.status).toBe(403);
    const carts = await kobai.database.query("select id from core_cart");
    expect(carts).toEqual([]);
  });

  it("leaves the Shopper alone when a request is about something else", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers, {
      shopper: { email: "shopper@example.test" },
    });

    const response = await kobai.request(`/store/carts/${cart}`, {
      method: "PATCH",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ metadata: { locale: "en-GB" } }),
    });

    // Absent is not `null`: a request that mentions no Shopper must not blank one off.
    expect(((await response.json()) as CartBody).shopper).toEqual({
      email: "shopper@example.test",
      externalId: null,
    });
  });
});

describe("an expired Cart", () => {
  it("still reads, says so, and keeps its Line Items", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { quantity: 3 });

    await expire(kobai, cart.id);

    const response = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as CartBody;
    expect(body.expired).toBe(true);
    // The rows survive expiry, because ADR-0028 makes abandoned cart a first-party Plugin and
    // a Plugin cannot recover what Core has deleted.
    expect(lineOf(body, "POSTER-A2").quantity).toBe(3);
    await expect(
      kobai.database.query("select id from core_cart_line_item where cart_id = $1", [
        cart.id,
      ]),
    ).resolves.toHaveLength(1);
  });

  it("refuses every change, and changes nothing in refusing", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const headers = cart.apiKey.headers;
    const line = cart.lineItem("POSTER-A2");

    await expire(kobai, cart.id);

    for (const [path, init] of changesTo(cart.id, line.id, headers, cart.catalog)) {
      const response = await kobai.request(path, init);
      expect(response.status, `${init.method} ${path}`).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ reason: "cart-expired" });
    }

    const read = await kobai.request(`/store/carts/${cart.id}`, { headers });
    expect(lineOf((await read.json()) as CartBody, "POSTER-A2").quantity).toBe(1);
  });
});

/**
 * A Cart that has already become an Order — **spent**, and the same kind of row an expired one
 * is (#102).
 *
 * The decision this ticket had to make: a placed Cart is consumed rather than left mutable. A
 * Cart is one Shopper's one selection and it becomes exactly one Order, so once it has there is
 * nothing left it could honestly do — changing it would change nothing about the Order, and
 * placing it again is the second charge idempotency exists to prevent. It reads, like an expired
 * one, so a storefront can say what happened.
 */
describe("a Cart that has been placed", () => {
  it("still reads, and says so", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai, { quantity: 3 });

    await seedTestOrder(kobai, { cart });

    const response = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as CartBody;
    expect(body.placed).toBe(true);
    // Not expired: the two are different facts about a Cart and a storefront says different
    // things about them — one is "this one ran out of time", the other is "you have already
    // bought it".
    expect(body.expired).toBe(false);
    expect(lineOf(body, "POSTER-A2").quantity).toBe(3);
  });

  it("refuses every change, and changes nothing in refusing", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const headers = cart.apiKey.headers;
    const line = cart.lineItem("POSTER-A2");

    await seedTestOrder(kobai, { cart });

    for (const [path, init] of changesTo(cart.id, line.id, headers, cart.catalog)) {
      const response = await kobai.request(path, init);
      expect(response.status, `${init.method} ${path}`).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ reason: "cart-placed" });
    }

    const read = await kobai.request(`/store/carts/${cart.id}`, { headers });
    expect(lineOf((await read.json()) as CartBody, "POSTER-A2").quantity).toBe(1);
  });

  it("is not what a Cart nobody has placed says", async () => {
    // The emptiness half: a flag that read `true` on every Cart would pass both tests above.
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });

    expect(((await response.json()) as CartBody).placed).toBe(false);
  });
});

describe("data Core has never heard of", () => {
  /**
   * ADR-0013's open door, and the reason it is on both rows: a Project's replaced Step reads
   * its inputs from a Line Item's `metadata`, so this is how a Shopper's unmodelled choice —
   * a lead time, a gift message, a printing option — reaches the rules that will price it.
   */
  it("round-trips on a Cart and on a Line Item", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const onTheCart = { channel: "kiosk", referral: { campaign: "spring", wave: 2 } };
    const onTheLine = { leadTimeDays: 10, giftMessage: "for Ada" };

    const cart = await startCart(kobai, catalog.apiKey.headers, {
      metadata: onTheCart,
    });
    const added = await kobai.request(`/store/carts/${cart}/line-items`, {
      method: "POST",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({ variantId: catalog.variantId, metadata: onTheLine }),
    });
    expect(added.status).toBe(200);

    const read = await kobai.request(`/store/carts/${cart}`, {
      headers: catalog.apiKey.headers,
    });
    const body = (await read.json()) as CartBody;

    // Untouched, nested values included: kobai stores what it was given and validates none of
    // it, because a shape here would be a promise (ADR-0004).
    expect(body.metadata).toEqual(onTheCart);
    expect(lineOf(body, "POSTER-A2").metadata).toEqual(onTheLine);
  });

  it("survives a second add of the same Variant, and is replaced when named again", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const cart = await startCart(kobai, catalog.apiKey.headers);

    await kobai.request(`/store/carts/${cart}/line-items`, {
      method: "POST",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({
        variantId: catalog.variantId,
        metadata: { leadTimeDays: 10 },
      }),
    });
    const quiet = await addLine(kobai, cart, catalog.apiKey.headers, catalog.variantId);
    expect(lineOf(quiet, "POSTER-A2").metadata).toEqual({ leadTimeDays: 10 });

    const loud = await kobai.request(`/store/carts/${cart}/line-items`, {
      method: "POST",
      headers: jsonHeaders(catalog.apiKey.headers),
      body: JSON.stringify({
        variantId: catalog.variantId,
        metadata: { leadTimeDays: 3 },
      }),
    });
    expect(lineOf((await loud.json()) as CartBody, "POSTER-A2").metadata).toEqual({
      leadTimeDays: 3,
    });
  });
});

// ---- What these tests say by hand, because saying it is the point ------------------------

type CartBody = {
  readonly id: string;
  readonly shopper: { email: string; externalId: string | null } | null;
  readonly lineItems: readonly {
    id: string;
    variant: { id: string; sku: string };
    quantity: number;
    metadata: Record<string, unknown>;
  }[];
  readonly metadata: Record<string, unknown>;
  readonly expired: boolean;
  readonly placed: boolean;
};

function jsonHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, "content-type": "application/json" };
}

/**
 * Every request that changes a Cart, so a rule about "every change" is asserted against all of
 * them rather than against whichever three somebody remembered.
 *
 * Both the states that refuse a change — expired, and placed — read this same list, which is
 * what keeps them from drifting apart.
 */
function changesTo(
  cartId: string,
  lineItemId: string,
  headers: Record<string, string>,
  catalog: TestCatalog,
): [string, RequestInit][] {
  return [
    [
      `/store/carts/${cartId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(headers),
        body: JSON.stringify({ metadata: { late: true } }),
      },
    ],
    [
      `/store/carts/${cartId}/line-items`,
      {
        method: "POST",
        headers: jsonHeaders(headers),
        body: JSON.stringify({ variantId: catalog.variantId }),
      },
    ],
    [
      `/store/carts/${cartId}/line-items/${lineItemId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(headers),
        body: JSON.stringify({ quantity: 9 }),
      },
    ],
    [`/store/carts/${cartId}/line-items/${lineItemId}`, { method: "DELETE", headers }],
  ];
}

/** The Cart's identifier, which is the whole of what a storefront then holds. */
async function startCart(
  kobai: TestKobai,
  headers: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<string> {
  const response = await kobai.request("/store/carts", {
    method: "POST",
    ...(body === undefined
      ? { headers }
      : { headers: jsonHeaders(headers), body: JSON.stringify(body) }),
  });
  if (response.status !== 201) {
    throw new Error(`starting a Cart answered ${response.status}`);
  }
  return ((await response.json()) as CartBody).id;
}

async function addLine(
  kobai: TestKobai,
  cartId: string,
  headers: Record<string, string>,
  variantId: string,
  quantity?: number,
): Promise<CartBody> {
  const response = await kobai.request(`/store/carts/${cartId}/line-items`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify({ variantId, quantity }),
  });
  if (response.status !== 200) {
    throw new Error(
      `adding ${variantId} answered ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as CartBody;
}

function lineOf(cart: CartBody, sku: string): CartBody["lineItems"][number] {
  const found = cart.lineItems.find((line) => line.variant.sku === sku);
  if (!found) {
    throw new Error(
      `this Cart carries no line for ${sku}: ${cart.lineItems.map((line) => line.variant.sku).join(", ")}`,
    );
  }
  return found;
}

/**
 * Time passed, by winding the row back rather than by waiting.
 *
 * A Cart's lifetime is measured in days, so this is the only honest way to reach the far side
 * of one — the same move the session tests make for a window measured in minutes.
 */
async function expire(kobai: TestKobai, cartId: string): Promise<void> {
  await kobai.database.query(
    "update core_cart set expires_at = now() - interval '1 second' where id = $1",
    [cartId],
  );
}
