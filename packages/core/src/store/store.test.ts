import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSIONS } from "../auth/permissions.ts";
import { defineMigrationSet } from "../migrations/set.ts";
import {
  createTestKobai,
  inspectSchema,
  type SchemaInspector,
  seedTestCatalog,
  sessionOf,
  signInTestMerchant,
  type TableRef,
  type TestKobai,
} from "../testing/index.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/**
 * The Store's table, qualified as Postgres actually holds it.
 *
 * Read back from `tables()` rather than written as the bare string `"core_store"`, which
 * resolves to `public` — so on a deployment whose search path is elsewhere the sweep below
 * would find no foreign key on a table it never looked at, and pass. Looking the name up
 * also fails loudly if the table is ever renamed, where a bare name would go quiet.
 */
async function storeTable(schema: SchemaInspector): Promise<TableRef> {
  const matches = (await schema.tables()).filter((table) => table.name === "core_store");
  const [store] = matches;
  if (matches.length !== 1 || store === undefined) {
    throw new Error(`expected exactly one core_store table, found ${matches.length}`);
  }
  return store;
}

describe("GET /admin/store", () => {
  it("returns the Store a fresh database was migrated into being", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "kobai",
      defaultCurrency: "USD",
      // The migration that created `core_store_currency` enabled the code the Store was seeded
      // with, so a Store is never in the state its own rules forbid: the default is always in
      // the set a Price may be denominated in (ADR-0074).
      currencies: [{ code: "USD" }],
      // Seeded at boot rather than by a migration, and nothing in this harness boots — see
      // `seed.test.ts`, where that is the subject.
      defaultRegion: null,
      metadata: {},
    });
  });

  it("carries no identifier, because there is only ever one Store", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const body = (await (
      await kobai.request("/admin/store", { headers: merchant.headers })
    ).json()) as Record<string, unknown>;

    // An id here is the first thing a storefront would key a cache on, and the second thing
    // someone would add a `where` on. ADR-0005: the Store is never a scoping key.
    expect(Object.keys(body).sort()).toEqual([
      "currencies",
      "defaultCurrency",
      "defaultRegion",
      "metadata",
      "name",
    ]);
  });
});

describe("PATCH /admin/store", () => {
  it("changes the name and the metadata, and reads back that way", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's posters", metadata: { support: "…" } }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json();
    expect(updated).toEqual({
      name: "Kyle's posters",
      defaultCurrency: "USD",
      currencies: [{ code: "USD" }],
      defaultRegion: null,
      metadata: { support: "…" },
    });
    // The same bytes the read beside it answers, because a Store is one record however it is
    // reached — and because this route answers with the row it left rather than with the body
    // it was sent.
    await expect(
      (await kobai.request("/admin/store", { headers: merchant.headers })).json(),
    ).resolves.toEqual(updated);
  });

  it("leaves out what the body left out, and replaces the metadata it names", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };
    await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Kyle's posters", metadata: { vat: "GB1", old: 1 } }),
    });

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ metadata: { vat: "GB1" } }),
    });

    // The name survives a body that did not mention it, and the bag is replaced rather than
    // merged — the same two judgements both catalog `PATCH`es make (ADR-0062).
    //
    // **`toEqual` on the bag**, because `toMatchObject` matches a nested object as a subset
    // and a merge that left `old` beside `vat` would satisfy it — which is the one
    // implementation this case exists to rule out.
    expect(response.status).toBe(200);
    const changed = (await response.json()) as {
      name: string;
      metadata: Record<string, unknown>;
    };
    expect(changed.name).toBe("Kyle's posters");
    expect(changed.metadata).toEqual({ vat: "GB1" });
  });

  it("refuses a body that names nothing it could change", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    for (const body of [{}, { defaultCurrency: "usd" }]) {
      const response = await kobai.request("/admin/store", {
        method: "PATCH",
        headers: { ...merchant.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      // The second body is the first one: the currency it names is the one this Store already
      // prices in, so nothing about it would move. A request that changes nothing is more
      // likely a mistake than an intention, which is where a Merchant is told what may change.
      expect(response.status, JSON.stringify(body)).toBe(400);
      const refusal = (await response.json()) as { reason: string; error: string };
      expect(refusal.reason).toBe("invalid");
      expect(refusal.error).toContain("`name`");
    }
  });

  it("refuses a change to the default currency, and leaves every Price standing", async () => {
    kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);
    const headers = { ...catalog.merchant.headers, "content-type": "application/json" };

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "Kyle's posters", defaultCurrency: "EUR" }),
    });

    // The Price of 1250 was written under the rule that a Price carries the Store's default
    // currency and nothing else (#5), so it says `USD` and says nothing about euros. Letting
    // this through would silently reinterpret every amount already in the database as an
    // amount in the new currency — 1250 cents becoming 1250 euro cents — which is a decision
    // about money that nobody has taken. Refusing is the answer that keeps it takeable.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "default-currency-is-fixed",
    });

    // Nothing else in that body moved either: the refusal is decided before the write, so a
    // name sent alongside a rejected currency is not half-applied.
    await expect(
      (await kobai.request("/admin/store", { headers: catalog.merchant.headers })).json(),
    ).resolves.toMatchObject({ name: "kobai", defaultCurrency: "USD" });
    await expect(
      (
        await kobai.request(`/admin/products/${catalog.productId}`, {
          headers: catalog.merchant.headers,
        })
      ).json(),
    ).resolves.toMatchObject({
      variants: [{ prices: [{ amount: 1250, currency: "USD" }] }],
    });
  });

  it("takes the Store to the currency it already prices in", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's posters", defaultCurrency: "usd" }),
    });

    // A Store does not conflict with itself, so sending the whole record back unchanged is
    // usable from a form — the same courtesy `PATCH /admin/variants/{id}` extends to a SKU.
    // Read case-insensitively, as `POST /admin/variants/{id}/prices` reads one.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "Kyle's posters",
      defaultCurrency: "USD",
    });
  });

  it("enables a second currency, and reports the whole set back", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currencies: [{ code: "USD" }, { code: "myr" }] }),
    });

    // The whole set rather than an add and a remove — `media`'s and `collections`' bargain one
    // noun along — and read case-insensitively, because `usd` and `USD` are one currency. This
    // is story 1: a second currency without a second deployment.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultCurrency: "USD",
      currencies: [{ code: "MYR" }, { code: "USD" }],
    });

    // Disabling is the same field with an entry left out, which is the half a list of edits
    // could never say.
    const narrowed = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currencies: [{ code: "USD" }] }),
    });
    expect(narrowed.status).toBe(200);
    await expect(narrowed.json()).resolves.toMatchObject({
      currencies: [{ code: "USD" }],
    });
  });

  it("refuses a set that leaves out the currency this Store prices in", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ currencies: [{ code: "MYR" }] }),
    });

    // ADR-0065's refusal on the narrower base ADR-0074 left it: a Price carrying no Region and
    // no Channel is denominated in the Store's default, so a Store that stopped enabling that
    // code would be quoting those rows in a currency it does not price in. The refusal says so
    // rather than only that it was refused.
    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { reason: string; error: string };
    expect(refusal.reason).toBe("default-currency-must-be-enabled");
    expect(refusal.error).toContain("no Region and no Channel");

    // And nothing moved: the set is judged before the first write.
    await expect(
      (await kobai.request("/admin/store", { headers: merchant.headers })).json(),
    ).resolves.toMatchObject({ currencies: [{ code: "USD" }] });
  });

  it("refuses a set that takes away a currency a Region selects, and names it", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };
    await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ currencies: [{ code: "USD" }, { code: "MYR" }] }),
    });
    await kobai.request("/admin/regions", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Malaysia", currency: "MYR" }),
    });

    const response = await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ currencies: [{ code: "USD" }] }),
    });

    // ADR-0059 at a third table: the alternatives are deleting somebody's Region or leaving one
    // denominated in a currency this Store does not price in, and the repair — move the Region
    // or delete it — is a control the Merchant already has. The refusal names it, because a
    // Store with twenty Regions cannot act on "one of them".
    expect(response.status).toBe(422);
    const refusal = (await response.json()) as { reason: string; error: string };
    expect(refusal.reason).toBe("currency-in-use");
    expect(refusal.error).toContain("Malaysia");
    await expect(
      (await kobai.request("/admin/store", { headers: merchant.headers })).json(),
    ).resolves.toMatchObject({ currencies: [{ code: "MYR" }, { code: "USD" }] });
  });

  it("carries a default Region, and refuses one this Store has not got", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const headers = { ...merchant.headers, "content-type": "application/json" };
    const region = (await (
      await kobai.request("/admin/regions", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "United States", currency: "USD" }),
      })
    ).json()) as { id: string };

    const set = await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ defaultRegion: region.id }),
    });

    // The whole Region rather than its identifier, on `Merchant.role`'s shape: what a client
    // wants is the geography and the currency, and a second request for them is one every
    // client would make.
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({
      defaultRegion: { id: region.id, name: "United States", currency: "USD" },
    });

    const unknown = await kobai.request("/admin/store", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ defaultRegion: "3f6a4b2c-0d1e-4f2a-8b3c-4d5e6f708192" }),
    });

    // 422 rather than 404: the address this request was sent to exists — it is the Store — and
    // what is missing is named inside the body, which is `collection-not-found`'s distinction
    // on `POST /admin/products`.
    expect(unknown.status).toBe(422);
    await expect(unknown.json()).resolves.toMatchObject({ reason: "region-not-found" });
  });

  it("is refused with no session, and refused to a Role that may only read the Store", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const anonymous = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's posters" }),
    });
    expect(anonymous.status).toBe(401);

    // A narrower Role, made the way a Merchant makes one (#173). This one holds the permission
    // the *read* beside it names, which is the whole point: reading what a Store is called and
    // changing it are different powers, so `store:read` alone must not be enough to change it.
    const role = await kobai.request("/admin/roles", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "viewer", permissions: [PERMISSIONS.storeRead] }),
    });
    expect(role.status, "creating the viewer Role").toBe(201);
    await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({
        email: "viewer@example.test",
        password: "a viewer's very long password",
        role: "viewer",
      }),
    });
    const viewer = sessionOf(
      await kobai.request("/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "viewer@example.test",
          password: "a viewer's very long password",
        }),
      }),
    );

    expect(
      (await kobai.request("/admin/store", { headers: viewer.headers })).status,
    ).toBe(200);
    const refused = await kobai.request("/admin/store", {
      method: "PATCH",
      headers: { ...viewer.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's posters" }),
    });

    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: PERMISSIONS.storeWrite,
    });
  });
});

describe("the Store is a singleton", () => {
  it("cannot hold a second row", async () => {
    // `await using` rather than the afterEach above, to keep the ergonomic the harness
    // documents from rotting untested.
    await using harness = await createTestKobai();

    // Enforced in DDL, not by convention: the primary key is a boolean pinned to true.
    await expect(
      harness.db.execute(
        sql`insert into core_store (singleton, name, default_currency) values (false, 'second', 'EUR')`,
      ),
    ).rejects.toThrow();
  });

  it("is referenced by no foreign key anywhere in the database", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // A foreign key onto the Store is multi-tenancy arriving by the back door: it makes the
    // Store a scoping key on whatever points at it (ADR-0005). Asked of the one table rather
    // than of the `core` prefix, because ADR-0005 is the stronger rule and
    // `foreignKeysCrossingInto` would excuse a `core_` table pointing at the Store —
    // `foreignKeysTargeting`'s own JSDoc has the argument.
    await expect(schema.foreignKeysTargeting(await storeTable(schema))).resolves.toEqual(
      [],
    );
  });

  /**
   * And that sweep is not vacuous, which is the half worth proving: an assertion that would
   * say "no references" whatever the database held would let the scoping key it exists to
   * catch walk straight past it.
   *
   * The tables are created here rather than in a migration because that is exactly what the
   * mistake looks like on the day somebody makes it — an ordinary table with a `store_id` on
   * it, added by a Plugin or by Core, neither of which the sweep is allowed to excuse. One
   * sits in another schema, because "everywhere in the database" has to mean everywhere.
   */
  it("has that proven by a sweep that names a foreign key when one arrives", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const store = await storeTable(schema);

    // The Store's key is the boolean pinned to true, so this is what scoping by it would
    // have to look like. The constraint is named rather than left to Postgres, so what the
    // sweep reports back is pinned rather than guessed.
    await kobai.database.query(`
      create table core_scoped (
        id uuid primary key default gen_random_uuid(),
        store_id boolean not null,
        constraint core_scoped_store_fk foreign key (store_id) references core_store (singleton)
      )
    `);
    // And one from a schema nobody thought to look in. A Project owns its own migrations and
    // may put its tables wherever it likes; a sweep confined to `public` would call this
    // database single-tenant while a `store_id` sat one schema over.
    await kobai.database.query(`create schema a_project_of_its_own`);
    await kobai.database.query(`
      create table a_project_of_its_own.scoped (
        store_id boolean not null,
        constraint project_scoped_store_fk foreign key (store_id) references core_store (singleton)
      )
    `);

    // Ordered by the schema and table a key points *from*, which `foreignKeys()` sorts on.
    await expect(schema.foreignKeysTargeting(store)).resolves.toEqual([
      {
        constraint: "project_scoped_store_fk",
        from: { schema: "a_project_of_its_own", name: "scoped" },
        to: store,
      },
      {
        constraint: "core_scoped_store_fk",
        from: { schema: store.schema, name: "core_scoped" },
        to: store,
      },
    ]);
  });
});

describe("traffic before migrations", () => {
  it("is refused while migrations are still pending", async () => {
    kobai = await createTestKobai({ migrate: false });

    const response = await kobai.request("/admin/store");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "booting" });
  });

  it("is refused after a migration has failed", async () => {
    const broken = defineMigrationSet({
      name: "plugin-broken",
      migrationsFolder: "/nonexistent/kobai/migrations",
    });
    kobai = await createTestKobai({ migrationSets: [broken] });

    const response = await kobai.request("/admin/store");

    // Core's own migrations applied before the broken set failed. Serving anyway would be
    // serving against a half-migrated schema, which is the thing this must never do.
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ status: "error" });
  });
});
