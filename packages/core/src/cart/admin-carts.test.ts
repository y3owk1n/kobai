import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../auth/permissions.ts";
import { OPENAPI_DOCUMENT_PATH } from "../http/openapi.ts";
import {
  createTestKobai,
  seedTestCart,
  seedTestCatalog,
  seedTestOrder,
  sessionOf,
  signInTestMerchant,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * The Admin's view of the Carts a Store is holding.
 *
 * The same rows a storefront writes over `/store`, read back by a Merchant — so everything here
 * is arranged the way a Shopper arranges it and then asked for over `/admin`. Nothing is
 * inserted behind the API.
 *
 * **This surface reverses a rule that was written down** (ADR-0071). `core_cart`'s schema
 * comment used to say there was deliberately no route that lists Carts, so there was nothing to
 * enumerate; it now says the amended thing, which is that a Cart identifier is a capability
 * Merchants hold and the public does not. The question it exists to answer is the one a
 * Merchant genuinely cannot ask today: *why is that stock unavailable?* — and once holds exist
 * the answer is often a live Cart belonging to a Shopper who is at their bank (ADR-0070).
 *
 * **Read-only, and that is a decision rather than a scope cut.** Releasing a hold by hand takes
 * stock from a Shopper who may be mid-payment; the sweeper already releases on expiry.
 */

describe("a Merchant sees the Carts the Store is holding", () => {
  it("lists them, with the identifier that is the authority to act on one", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await kobai.request("/admin/carts", {
      headers: cart.catalog.merchant.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      carts: [
        {
          // The whole point of the route (ADR-0071): a Cart is addressed by this value and by
          // nothing else, so a list that withheld it would answer no question a Merchant has.
          id: cart.id,
          shopper: null,
          // On the list as well as on the Cart, because *what currency is this in* is a
          // question a Merchant scanning held Carts has (#293).
          currency: "USD",
          region: { id: expect.any(String), name: "USD", currency: "USD" },
          // On the list as well, and for the list's own reason: a Merchant looking for the
          // Cart a Shopper is asking about is looking at where it goes (#319).
          address: null,
          // And how it is to get there, which is the other half of the same question (#321).
          shippingMethod: null,
          metadata: {},
          expiresAt: expect.any(String),
          expired: false,
          placed: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
      ],
    });
  });

  it("lists them newest first, so the Cart just started is at the top", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const first = await seedTestCart(kobai, { catalog });
    const second = await seedTestCart(kobai, { catalog });

    const response = await kobai.request("/admin/carts", {
      headers: catalog.merchant.headers,
    });

    const { carts } = (await response.json()) as { carts: { id: string }[] };
    expect(carts.map((one) => one.id)).toEqual([second.id, first.id]);
  });

  it("says so plainly when nobody is shopping", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/carts", { headers: merchant.headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ carts: [] });
  });

  it("names the Shopper a storefront attached, and reads a guest's as a guest's", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    await seedTestCart(kobai, { catalog });
    await seedTestCart(kobai, {
      catalog,
      shopper: { email: "shopper@example.test", externalId: "auth0|7" },
    });

    const response = await kobai.request("/admin/carts", {
      headers: catalog.merchant.headers,
    });

    const { carts } = (await response.json()) as {
      carts: { shopper: unknown }[];
    };
    // Newest first, so the named Shopper is the first row. A reference and never a credential
    // (ADR-0020) — which is exactly what a Merchant looking at a held Cart needs to know.
    expect(carts.map((one) => one.shopper)).toEqual([
      { email: "shopper@example.test", externalId: "auth0|7" },
      null,
    ]);
  });
});

describe("the list filters by what has become of each Cart", () => {
  it("tells live, expired and spent apart, and answers each on its own", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const live = await seedTestCart(kobai, { catalog });
    const expired = await seedTestCart(kobai, { catalog });
    await expire(kobai, expired.id);
    const spent = await seedTestOrder(kobai, { catalog });

    const of = async (query: string): Promise<string[]> => {
      const response = await kobai.request(`/admin/carts${query}`, {
        headers: catalog.merchant.headers,
      });
      const body = (await response.json()) as { carts?: { id: string }[] };
      expect(response.status, `${query} answered ${JSON.stringify(body)}`).toBe(200);
      return (body.carts ?? []).map((one) => one.id);
    };

    // The three partition the table, which is what makes the filter worth having: a Cart that
    // became an Order is spent whatever its deadline says, and without the filter the default
    // list is mostly history.
    expect(await of("?state=live")).toEqual([live.id]);
    expect(await of("?state=expired")).toEqual([expired.id]);
    expect(await of("?state=spent")).toEqual([spent.cart.id]);
    // And unfiltered is all three, so the filter is narrowing this list rather than being the
    // only way to read it.
    expect([...(await of(""))].sort()).toEqual(
      [live.id, expired.id, spent.cart.id].sort(),
    );
  });

  it("refuses a state it does not know rather than ignoring it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/carts?state=abandoned", {
      headers: merchant.headers,
    });

    // Refused, because a filter quietly dropped answers a different question from the one that
    // was asked — and a Merchant reading the whole table would not know they had.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});

describe("a Merchant opens one Cart", () => {
  it("sees its Line Items, its deadline and what has become of it", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      title: "A poster",
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });
    const cart = await seedTestCart(kobai, { catalog, quantity: 2 });

    const response = await kobai.request(`/admin/carts/${cart.id}`, {
      headers: catalog.merchant.headers,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: cart.id,
      shopper: null,
      // What it is denominated in and where it is being bought — a read on a screen that is
      // read-only, and the answer to *what currency is that hold in* (#293).
      currency: "USD",
      region: { id: expect.any(String), name: "USD", currency: "USD" },
      lineItems: [
        {
          id: cart.lineItem("POSTER-A2").id,
          // Live, not a snapshot: a Cart's lines follow the catalog, which is the asymmetry
          // ADR-0009 asks for and the opposite of an Order's.
          variant: { id: catalog.variantId, sku: "POSTER-A2" },
          quantity: 2,
          metadata: {},
        },
      ],
      address: null,
      shippingMethod: null,
      metadata: {},
      expiresAt: expect.any(String),
      expired: false,
      placed: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("reads back exactly what the storefront holding it reads", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const admin = await kobai.request(`/admin/carts/${cart.id}`, {
      headers: cart.catalog.merchant.headers,
    });
    const storefront = await kobai.request(`/store/carts/${cart.id}`, {
      headers: cart.apiKey.headers,
    });

    // One record, two credentials for reading it — the same bargain `/admin/orders/{id}` makes
    // with `/store/orders/{id}`. What differs is who may ask, not what they are told.
    await expect(admin.json()).resolves.toEqual(await storefront.json());
  });

  it("answers 404 for a Cart that does not exist, and for an id that is not one", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/carts/${id}`, {
        headers: merchant.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json(), id).resolves.toMatchObject({
        reason: "cart-not-found",
      });
    }
  });
});

describe("this surface is read-only", () => {
  /**
   * The decision ADR-0071 records, asserted rather than described.
   *
   * **Releasing a hold is the half that is settled for good**: doing it by hand takes stock from
   * a Shopper who may be mid-payment at their bank — ADR-0070's failure mode, caused
   * deliberately — and the sweeper already releases on expiry, so no route here ever gives one
   * back. The Cart writes beside it are `cart:write`'s and belong to spec 8, which is why they
   * are 404 here rather than absent from the ADR.
   *
   * A Merchant signed in and holding every Permission Core defines is what makes this an
   * assertion about the surface rather than about the gate.
   */
  it("serves no route that changes a Cart, releases a hold, or deletes one", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const { headers } = cart.catalog.merchant;

    const writes = [
      { method: "POST", path: "/admin/carts" },
      { method: "PATCH", path: `/admin/carts/${cart.id}` },
      { method: "DELETE", path: `/admin/carts/${cart.id}` },
      { method: "POST", path: `/admin/carts/${cart.id}/line-items` },
      { method: "POST", path: `/admin/carts/${cart.id}/reservations` },
      { method: "DELETE", path: `/admin/carts/${cart.id}/reservations` },
    ];

    for (const write of writes) {
      const response = await kobai.request(write.path, {
        method: write.method,
        headers: { ...headers, "content-type": "application/json" },
        body: write.method === "DELETE" ? undefined : "{}",
      });

      const where = `${write.method} ${write.path}`;
      expect(response.status, where).toBe(404);
      await expect(response.json(), where).resolves.toMatchObject({
        reason: "not-found",
      });
    }

    // …and the hold the Cart may be carrying is still there afterwards, which is the fact the
    // absence of those routes exists to protect.
    const read = await kobai.request(`/admin/carts/${cart.id}`, { headers });
    expect(read.status).toBe(200);
  });

  /**
   * The same decision, asked of the surface rather than of six paths somebody thought of.
   *
   * The list above is a guess at what a write would be called; this is **every** operation the
   * description carries under `/admin/carts`, whatever it is named, held to being a read. So a
   * verb added here fails this rather than slipping past a list nobody extended — the sentence
   * rather than a count of routes (ADR-0049 § *Applied again*).
   *
   * It is asked of the checked-in artifact, which `http/openapi.test.ts` already holds to being
   * what this build produces, and it has been watched failing: pointed at `/admin/roles` it
   * names that surface's `post`, `patch` and `delete`.
   *
   * **What would legitimately turn this red is spec 8**, which ADR-0071 also decides: `cart:write`
   * for creating and editing a Cart on a Merchant's behalf. Whoever builds it edits this
   * deliberately, which is the point — what must survive it is the sentence one line down, since
   * releasing a hold by hand is the thing ADR-0071 rules out for good.
   */
  it("describes no operation under /admin/carts that is not a read", async () => {
    const document = JSON.parse(await readFile(OPENAPI_DOCUMENT_PATH, "utf8")) as {
      paths?: Record<string, Record<string, unknown>>;
    };

    const operations = Object.entries(document.paths ?? {})
      .filter(([path]) => path === "/admin/carts" || path.startsWith("/admin/carts/"))
      .flatMap(([path, item]) => Object.keys(item).map((method) => `${method} ${path}`));

    // A sweep that found nothing would satisfy every assertion made over it.
    expect(
      operations,
      "the description carries no /admin/carts operation at all",
    ).not.toHaveLength(0);
    expect(operations.filter((operation) => !operation.startsWith("get "))).toEqual([]);
  });
});

describe("reading Carts is its own Permission", () => {
  it("refuses a Role holding every other Permission Core defines", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const owner = cart.catalog.merchant;

    // Every Permission but this one, which is the strong form of "no other Permission grants
    // it": reusing `order:read` was considered and rejected, because ADR-0009's first decision
    // is that a Cart and an Order are governed by opposite rules and merging their Permissions
    // says the opposite in the one place a deployment configures trust (ADR-0071).
    const headers = await merchantHolding(
      kobai,
      owner,
      Object.values(PERMISSIONS).filter((one) => one !== PERMISSIONS.cartRead),
    );

    const list = await kobai.request("/admin/carts", { headers });
    const one = await kobai.request(`/admin/carts/${cart.id}`, { headers });

    // 403 and not 404: they are signed in, and the answer names the Permission they lack
    // rather than pretending the Cart is not there.
    for (const response of [list, one]) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        reason: "permission-denied",
        required: PERMISSIONS.cartRead,
      });
    }
    // …and the Orders they *do* hold a Permission for still answer, so what was refused is the
    // one power rather than the whole surface.
    const orders = await kobai.request("/admin/orders", { headers });
    expect(orders.status).toBe(200);
  });

  it("admits a Role holding nothing else", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const headers = await merchantHolding(kobai, cart.catalog.merchant, [
      PERMISSIONS.cartRead,
    ]);

    const list = await kobai.request("/admin/carts", { headers });
    const one = await kobai.request(`/admin/carts/${cart.id}`, { headers });

    // The half that makes the refusal above a binding rather than a wall — and the reason
    // `cart:read` is a word of its own: a deployment can grant seeing the Carts without
    // granting anything else at all.
    expect(list.status).toBe(200);
    expect(one.status).toBe(200);
  });
});

/**
 * A second Merchant on a Role carrying exactly these Permissions, signed in.
 *
 * Through the routes a Merchant uses, never `insert into core_role` — a test that built its
 * Role with SQL would pass just as well against a route that is gated wrongly.
 */
async function merchantHolding(
  kobai: TestKobai,
  owner: TestSession,
  permissions: readonly string[],
): Promise<Record<string, string>> {
  const email = "colleague@example.test";
  const password = "a colleague's very long password";
  const json = { ...owner.headers, "content-type": "application/json" };

  const role = await kobai.request("/admin/roles", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ name: "bookkeeper", permissions }),
  });
  expect(role.status).toBe(201);
  const created = await kobai.request("/admin/merchants", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ email, password, role: "bookkeeper" }),
  });
  expect(created.status).toBe(201);

  return sessionOf(
    await kobai.request("/admin/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  ).headers;
}

/**
 * Time passed, by winding the row back rather than by waiting — the same move `cart.test.ts`
 * makes, because a Cart's lifetime is measured in days.
 */
async function expire(kobai: TestKobai, cartId: string): Promise<void> {
  await kobai.database.query(
    "update core_cart set expires_at = now() - interval '1 second' where id = $1",
    [cartId],
  );
}
