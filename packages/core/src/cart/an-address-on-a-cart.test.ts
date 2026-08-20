import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  inspectSchema,
  type SchemaInspector,
  seedTestCart,
  type TableRef,
  type TestCart,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **A Shopper says where the thing goes** (#319, ADR-0072).
 *
 * A Cart carries a delivery Address, set and replaced over `/store` with the Cart's identifier
 * as the whole of the authority to act on it (ADR-0020) — a Shopper threads no credential of
 * their own. Core checks its **shape and nothing beyond it**: address formats differ by country
 * to a degree no library settles, so refusing a badly-formed address is a Project's decision and
 * kobai refuses none of them.
 *
 * **Nothing here makes an Address mandatory**, and the first case says so: a Cart with none
 * reads, quotes and places exactly as it did before this existed. Whether *shipping* requires
 * one is a later ticket's decision about shipping, not this one's about an Address.
 *
 * The Order's half — that Capture snapshots it, and that nothing afterwards can rewrite where a
 * past parcel went — is `order/an-order-remembers-where-it-went.test.ts`.
 */

/** What a storefront sends to say where the parcel goes, and what kobai answered. */
async function setAddress(
  kobai: TestKobai,
  cart: TestCart,
  address: unknown,
): Promise<Response> {
  return kobai.request(`/store/carts/${cart.id}`, {
    method: "PATCH",
    headers: { ...cart.apiKey.headers, "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
}

/** The Cart as a storefront reads it back. */
async function readCart(kobai: TestKobai, cart: TestCart): Promise<CartBody> {
  const response = await kobai.request(`/store/carts/${cart.id}`, {
    headers: cart.apiKey.headers,
  });
  expect(response.status, "reading the Cart back").toBe(200);
  return (await response.json()) as CartBody;
}

type CartBody = {
  readonly address: AddressBody | null;
  readonly region: { readonly id: string; readonly name: string } | null;
};

type AddressBody = {
  readonly country: string;
  readonly lines: readonly string[];
  readonly postalCode: string | null;
  readonly region: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
  } | null;
};

/** An address that is well formed and says nothing a postal authority would recognise. */
const NONSENSE = {
  country: "MY",
  lines: ["Nowhere at all", "not a street"],
  postalCode: "ZZZZZZ",
} as const;

/** A Region this Store sells into, selecting the currency the Store already prices in. */
async function createRegion(
  kobai: TestKobai,
  catalog: TestCatalog,
  name: string,
): Promise<string> {
  const response = await kobai.request("/admin/regions", {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ name, currency: "USD" }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("a Cart with no Address", () => {
  it("reads, quotes and places, because nothing here makes one mandatory", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const read = await readCart(kobai, cart);
    expect(read.address).toBeNull();

    const quoted = await kobai.request(`/store/carts/${cart.id}/quote`, {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(quoted.status, "quoting a Cart with no Address").toBe(200);

    const placed = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    expect(placed.status, "placing a Cart with no Address").toBe(201);
    expect(((await placed.json()) as { address: unknown }).address).toBeNull();
  });
});

describe("an Address on a Cart", () => {
  it("is set over the store surface with the Cart's identifier as the authority", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const response = await setAddress(kobai, cart, {
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as CartBody).address).toEqual({
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: null,
    });
    // The same bytes on a later read: a correction answers with the Cart, so the two must agree.
    expect((await readCart(kobai, cart)).address).toEqual({
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
      region: null,
    });
  });

  it("is replaced whole rather than merged into", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    await setAddress(kobai, cart, {
      country: "MY",
      lines: ["12 Jalan Ampang", "Kuala Lumpur"],
      postalCode: "50450",
    });
    const replaced = await setAddress(kobai, cart, {
      country: "SG",
      lines: ["1 Raffles Place"],
    });

    expect(replaced.status).toBe(200);
    // `postalCode` is gone rather than kept: an address is one fact and the whole of it was
    // sent, exactly as a named `metadata` is replaced rather than merged (ADR-0062).
    expect(((await replaced.json()) as CartBody).address).toEqual({
      country: "SG",
      lines: ["1 Raffles Place"],
      postalCode: null,
      region: null,
    });
  });

  it("is taken off by `null`, which is not the same as leaving it alone", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    await setAddress(kobai, cart, NONSENSE);

    // A `metadata`-only correction leaves the Address where it was: absent means leave it.
    const untouched = await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { gift: true } }),
    });
    expect(untouched.status).toBe(200);
    expect(((await untouched.json()) as CartBody).address).not.toBeNull();

    const removed = await setAddress(kobai, cart, null);
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as CartBody).address).toBeNull();
  });

  it("may be given when the Cart is started", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const started = await kobai.request("/store/carts", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ address: NONSENSE }),
    });

    expect(started.status).toBe(201);
    expect(((await started.json()) as CartBody).address).toMatchObject({
      country: "MY",
      postalCode: "ZZZZZZ",
    });
  });

  it("names the Region it falls in, and is refused for one this Store has not got", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    const regionId = await createRegion(kobai, cart.catalog, "Malaysia");

    const set = await setAddress(kobai, cart, { ...NONSENSE, regionId });
    expect(set.status).toBe(200);
    expect(((await set.json()) as CartBody).address?.region).toEqual({
      id: regionId,
      name: "Malaysia",
      currency: "USD",
    });

    const unknown = await setAddress(kobai, cart, {
      ...NONSENSE,
      regionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.status).toBe(422);
    // The word the admin surface already answers for the same fact — one fact, one word,
    // whichever end asks it (ADR-0060).
    expect((await unknown.json()) as { reason: string }).toMatchObject({
      reason: "region-not-found",
    });
  });
});

describe("a correction that is refused writes no Address at all", () => {
  /**
   * **A refusal returned out of a transaction commits it**, which is the rule
   * `collection-not-found` already follows on the admin surface — so an Address written in front
   * of a refusal would survive a request the caller was told was turned down.
   *
   * `PATCH /store/carts/{id}` takes an `address` and a `regionId` in one body, and the Region
   * switch is the refusal that can follow the Address write. Both cases below were watched
   * failing against a build that wrote first: the Cart came back with the new Address behind a
   * 422, and — where it had none — `core_address` held a row no Cart pointed at.
   */
  it("leaves the Address the Cart already had exactly as it was", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);
    await setAddress(kobai, cart, NONSENSE);

    const refused = await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({
        address: { country: "SG", lines: ["1 Raffles Place"] },
        regionId: "00000000-0000-4000-8000-000000000000",
      }),
    });

    expect(refused.status).toBe(422);
    expect((await refused.json()) as { reason: string }).toMatchObject({
      reason: "region-not-found",
    });
    // The refusal's own prose is that the Cart was left where it was, and this is that being
    // true rather than said.
    expect((await readCart(kobai, cart)).address).toMatchObject({ country: "MY" });
  });

  it("leaves no Address row behind for a Cart that had none", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const refused = await kobai.request(`/store/carts/${cart.id}`, {
      method: "PATCH",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({
        address: NONSENSE,
        regionId: "00000000-0000-4000-8000-000000000000",
      }),
    });
    expect(refused.status).toBe(422);

    expect((await readCart(kobai, cart)).address).toBeNull();
    // Asked of the table rather than of the Cart, because the row this would leave behind is
    // reachable from nothing: no route lists an Address, and no sweep knows about one.
    await expect(
      kobai.database.query("select count(*)::int as rows from core_address"),
    ).resolves.toEqual([{ rows: 0 }]);
  });
});

describe("Core checks an Address's shape and nothing beyond it", () => {
  it("takes an address no postal authority would accept", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    const set = await setAddress(kobai, cart, NONSENSE);
    expect(set.status).toBe(200);

    // And it places, which is the half that matters: refusing a badly-formed address is a
    // Project's decision (ADR-0072), so an Order for one is a thing kobai takes.
    const placed = await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...cart.apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    });
    expect(placed.status).toBe(201);
    expect(((await placed.json()) as { address: AddressBody }).address).toMatchObject({
      postalCode: "ZZZZZZ",
    });
  });

  it("refuses a malformed shape, which is a different thing", async () => {
    await using kobai = await createTestKobai();
    const cart = await seedTestCart(kobai);

    for (const malformed of [
      { lines: ["nowhere"] },
      { country: "MY" },
      { country: "MY", lines: [] },
      { country: "MY", lines: [""] },
      { country: "Malaysia", lines: ["nowhere"] },
      { country: "MY", lines: "nowhere" },
      { country: "MY", lines: ["nowhere"], postalCode: "" },
    ]) {
      const response = await setAddress(kobai, cart, malformed);
      expect(response.status, JSON.stringify(malformed)).toBe(400);
      expect(await response.json(), JSON.stringify(malformed)).toMatchObject({
        reason: "invalid",
      });
    }
  });
});

describe("an Address is not a scoping key", () => {
  it("is referenced by the Cart that carries one, and by nothing else", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const table = await addressTable(schema);

    // The question `region.test.ts` asks of a Region, asked of an Address (#319). A Cart points
    // at the Address it carries; the Order's snapshot points at **nothing**, because it is a
    // copy in a table of its own (ADR-0009). A second key here — an Order, a Merchant, a
    // Fulfilment — is a decision to take out loud rather than a build to fix quietly.
    await expect(schema.foreignKeysTargeting(table)).resolves.toEqual([
      {
        constraint: "core_cart_address_id_core_address_id_fk",
        from: { schema: table.schema, name: "core_cart" },
        to: table,
      },
    ]);
  });

  it("has that proven by a sweep that names a foreign key when one arrives", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const table = await addressTable(schema);

    // What scoping by an Address would look like on the day somebody does it. Without this the
    // assertion above would say "nothing else points here" whatever the database held, which is
    // ADR-0049's trap.
    await kobai.database.query(`
      create table core_scoped_by_address (
        id uuid primary key default gen_random_uuid(),
        address_id uuid not null,
        constraint core_scoped_address_fk foreign key (address_id) references core_address (id)
      )
    `);

    await expect(schema.foreignKeysTargeting(table)).resolves.toEqual([
      {
        constraint: "core_cart_address_id_core_address_id_fk",
        from: { schema: table.schema, name: "core_cart" },
        to: table,
      },
      {
        constraint: "core_scoped_address_fk",
        from: { schema: table.schema, name: "core_scoped_by_address" },
        to: table,
      },
    ]);
  });
});

/**
 * The Address table, qualified as Postgres actually holds it.
 *
 * Read back from `tables()` rather than written as the bare string: a bare name resolves to
 * `public`, and a sweep aimed at the wrong schema finds nothing and reports that the rule holds.
 */
async function addressTable(schema: SchemaInspector): Promise<TableRef> {
  const found = (await schema.tables()).find((table) => table.name === "core_address");
  if (!found) throw new Error("`core_address` is not in this database.");
  return found;
}
