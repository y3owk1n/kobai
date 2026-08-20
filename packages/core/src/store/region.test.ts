import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  inspectSchema,
  type SchemaInspector,
  signInTestMerchant,
  type TableRef,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * Regions — the five routes that manage one, and the two rules that make a Region more than a
 * row (#291, ADR-0005, ADR-0074).
 *
 * **Through HTTP, because all of it is a promise about a request and a response**, with one
 * exception at the foot of this file: that nothing scopes by a Region is a property of the
 * *schema*, and `foreignKeysTargeting` is the only thing that can ask it. ADR-0005 says a Region
 * is variation within one Store and emphatically not a tenant boundary, and this spec is the one
 * most likely to be read as an invitation — so the question `store.test.ts` asks about the Store
 * is asked here about the Region, and its sweep is watched naming a key when one arrives.
 *
 * The two rules:
 *
 * - **A Region selects a currency the Store has enabled**, at the create and at the correction
 *   alike, and one it has not is refused rather than stored. That is what makes the Store the
 *   enumerating half of ADR-0074's division rather than a place two answers can disagree.
 * - **The Store's default Region cannot be deleted out from under it.** A storefront that names
 *   no Region is answered for that one, so removing it silently would refuse every such request
 *   instead — and the repair is a control the Merchant already has (ADR-0059).
 */

type Region = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly metadata: Record<string, unknown>;
};

type Refusal = { readonly reason?: string; readonly error?: string };

/** Enables exactly these currencies on the Store — the whole set, as `PATCH` reads it. */
async function enable(
  kobai: TestKobai,
  merchant: TestSession,
  codes: readonly string[],
): Promise<void> {
  const response = await kobai.request("/admin/store", {
    method: "PATCH",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ currencies: codes.map((code) => ({ code })) }),
  });
  if (response.status !== 200) {
    throw new Error(
      `enabling answered ${response.status}: ${JSON.stringify(await response.json())}`,
    );
  }
}

/** Creates a Region through the route a Merchant uses, and answers what came back. */
async function create(
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

describe("the Regions a Store sells into", () => {
  it("is created, read, listed, corrected and deleted", async () => {
    // **`defaultRegion: false`, so the list is exactly what this case made.** A booted
    // deployment has a Region seeded from its own currency and the harness has seeded one
    // since #292; here the whole list is the assertion, twice — once holding the Region that
    // was created and once holding nothing after it was deleted — and a second row in it would
    // make both of those say something weaker.
    await using kobai = await createTestKobai({ defaultRegion: false });
    const merchant = await signInTestMerchant(kobai);

    const created = await create(kobai, merchant, {
      name: "United States",
      currency: "usd",
      metadata: { vat: "none" },
    });

    expect(created.status).toBe(201);
    // The code is upper-cased on the way in, exactly as `defaultCurrency` and a Price's are:
    // `usd` and `USD` are one currency, and a Region selecting the lower-cased spelling would
    // be one nothing else could match.
    expect(created.body).toEqual({
      id: expect.any(String),
      name: "United States",
      currency: "USD",
      metadata: { vat: "none" },
    });

    const read = await kobai.request(`/admin/regions/${created.body.id}`, {
      headers: merchant.headers,
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual(created.body);

    const listed = await kobai.request("/admin/regions", { headers: merchant.headers });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ regions: [created.body] });

    const corrected = await kobai.request(`/admin/regions/${created.body.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "The States" }),
    });
    expect(corrected.status).toBe(200);
    // An absent field means "leave it" and a named one is written — ADR-0062, at a third record.
    await expect(corrected.json()).resolves.toEqual({
      ...created.body,
      name: "The States",
    });

    const deleted = await kobai.request(`/admin/regions/${created.body.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(deleted.status).toBe(204);
    await expect(
      (await kobai.request("/admin/regions", { headers: merchant.headers })).json(),
    ).resolves.toEqual({ regions: [] });
  });

  it("refuses a currency this Store has not enabled, at the create and at the correction", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const refused = await create(kobai, merchant, { name: "Eurozone", currency: "EUR" });

    // 422 rather than 400: `EUR` is three letters in the right field, and what refuses it is
    // the set this Store has enabled — `unknown-fulfilment-strategy`'s distinction.
    expect(refused.status).toBe(422);
    expect(refused.body.reason).toBe("currency-not-enabled");
    // The refusal says where the answer is rather than only what was wrong.
    expect(refused.body.error).toContain("/admin/store");

    // The same word from the other end: a Region that already exists, moved onto a currency
    // this Store has not enabled. One fact gets one word (ADR-0060).
    const usd = await create(kobai, merchant, { name: "United States", currency: "USD" });
    const moved = await kobai.request(`/admin/regions/${usd.body.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currency: "EUR" }),
    });
    expect(moved.status).toBe(422);
    await expect(moved.json()).resolves.toMatchObject({
      reason: "currency-not-enabled",
    });
  });

  it("takes a currency the moment the Store enables it, and moves onto it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    await enable(kobai, merchant, ["USD", "MYR"]);

    const created = await create(kobai, merchant, { name: "Malaysia", currency: "MYR" });

    expect(created.status).toBe(201);
    expect(created.body.currency).toBe("MYR");

    // **A Region's currency moves and the Store's does not**, which is the asymmetry ADR-0074
    // left standing: the Store's default denominates every unconstrained Price, and a Region
    // merely selects one of the enabled set.
    const moved = await kobai.request(`/admin/regions/${created.body.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currency: "USD" }),
    });
    expect(moved.status).toBe(200);
    await expect(moved.json()).resolves.toMatchObject({ currency: "USD" });
  });

  it("refuses a body that names nothing it could change", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const created = await create(kobai, merchant, { name: "Home", currency: "USD" });

    const response = await kobai.request(`/admin/regions/${created.body.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // ADR-0062: a request that changes nothing is more likely a mistake than an intention, and
    // this is where a Merchant is told what may change.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("answers the same word for an address that names nothing and for one that is not an address", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    for (const id of ["3f6a4b2c-0d1e-4f2a-8b3c-4d5e6f708192", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/regions/${id}`, {
        headers: merchant.headers,
      });

      // `IdParam`'s argument: an identifier nothing carries and a string that could never be
      // one are the same answer to the caller.
      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "region-not-found",
      });
    }
  });

  it("refuses to delete the Region this Store falls back to, and takes it once it does not", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const fallback = await create(kobai, merchant, { name: "Home", currency: "USD" });
    const other = await create(kobai, merchant, { name: "Elsewhere", currency: "USD" });
    await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ defaultRegion: fallback.body.id }),
    });

    const refused = await kobai.request(`/admin/regions/${fallback.body.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });

    // 409 rather than 422, on `role-in-use`'s distinction: what refuses it is another row, and
    // it becomes possible by itself the moment that row changes.
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ reason: "region-in-use" });

    // And the repair is a control the Merchant already has, which is ADR-0059's whole test.
    await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ defaultRegion: other.body.id }),
    });
    const taken = await kobai.request(`/admin/regions/${fallback.body.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(taken.status).toBe(204);
  });
});

describe("a Region is not a scoping key", () => {
  it("is referenced by the Store's own fallback and a Price's constraint, and by nothing else", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const table = await regionTable(schema);

    // ADR-0005 says variation *within* one Store, and this spec is the one most likely to be
    // read as an invitation — so this is the question `store.test.ts` asks about the Store,
    // asked about the Region. Neither of these two is scoping, and the pair is worth reading
    // together. The Store pointing *at* a Region is a column on the singleton naming the
    // fallback a storefront that sends no Region is answered for. `core_price.region_id` is a
    // **constraint on a row** and the opposite of a scope: it is nullable, `null` means the
    // Price applies everywhere, and every Price that names none still does — where a scoping
    // key would be one every row had to carry to be visible at all.
    //
    // **`core_cart.region_id` is the third, and it is the decision this sweep asked to be
    // taken out loud rather than a build fixed quietly** (#293). It is not a scope either, and
    // the test is the same one: nothing narrows a list of Carts by Region, no request is
    // answered a different set of Carts because of it, and a Cart that names none still reads
    // and still places. What it decides is what *that Cart* is priced in — one row's own
    // market, the same kind of fact `core_price.region_id` is one table along — where a scoping
    // key would be one every row had to carry to be visible at all.
    //
    // A `region_id` appearing on an **Order** or on a catalog table is what this still names,
    // and the day one does that is another decision to take here.
    await expect(schema.foreignKeysTargeting(table)).resolves.toEqual([
      {
        constraint: "core_cart_region_id_core_region_id_fk",
        from: { schema: table.schema, name: "core_cart" },
        to: table,
      },
      {
        constraint: "core_price_region_id_core_region_id_fk",
        from: { schema: table.schema, name: "core_price" },
        to: table,
      },
      {
        constraint: "core_store_default_region_id_core_region_id_fk",
        from: { schema: table.schema, name: "core_store" },
        to: table,
      },
    ]);
  });

  it("has that proven by a sweep that names a foreign key when one arrives", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const table = await regionTable(schema);

    // What scoping by a Region would look like on the day somebody does it: an ordinary table
    // with a `region_id` on it. The assertion above would say "no scoping key" whatever the
    // database held if this sweep could not see one, which is ADR-0049's trap.
    await kobai.database.query(`
      create table core_scoped_by_region (
        id uuid primary key default gen_random_uuid(),
        region_id uuid not null,
        constraint core_scoped_region_fk foreign key (region_id) references core_region (id)
      )
    `);

    await expect(schema.foreignKeysTargeting(table)).resolves.toEqual([
      {
        constraint: "core_cart_region_id_core_region_id_fk",
        from: { schema: table.schema, name: "core_cart" },
        to: table,
      },
      {
        constraint: "core_price_region_id_core_region_id_fk",
        from: { schema: table.schema, name: "core_price" },
        to: table,
      },
      {
        constraint: "core_scoped_region_fk",
        from: { schema: table.schema, name: "core_scoped_by_region" },
        to: table,
      },
      {
        constraint: "core_store_default_region_id_core_region_id_fk",
        from: { schema: table.schema, name: "core_store" },
        to: table,
      },
    ]);
  });
});

/**
 * The Region table, qualified as Postgres actually holds it.
 *
 * Read back from `tables()` rather than written as the bare string, for `storeTable`'s reason:
 * a bare name resolves to `public`, so a sweep aimed at the wrong schema finds nothing and
 * reports that the rule holds.
 */
async function regionTable(schema: SchemaInspector): Promise<TableRef> {
  const matches = (await schema.tables()).filter((table) => table.name === "core_region");
  const [region] = matches;
  if (matches.length !== 1 || region === undefined) {
    throw new Error(`expected exactly one core_region table, found ${matches.length}`);
  }
  return region;
}
