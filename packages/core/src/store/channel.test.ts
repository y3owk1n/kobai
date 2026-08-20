import { describe, expect, it } from "vitest";
import {
  createTestApiKey,
  createTestKobai,
  inspectSchema,
  type SchemaInspector,
  signInTestMerchant,
  type TableRef,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";

/**
 * Channels — the five routes that manage one, and the credential that decides which Channel a
 * request is in (#291, ADR-0005, ADR-0020).
 *
 * **Through HTTP**, with the same one exception `region.test.ts` makes and for a sharper reason:
 * ADR-0005 names the Channel specifically as the thing Vendure overloads to mean a tenant
 * boundary, so what points *at* `core_channel` is a question only the schema can answer, and it
 * is asked here with the sweep watched naming a key when one arrives.
 *
 * **Nothing reads `channel_id` yet**, and that is deliberate rather than unfinished: a Price
 * constrained by Channel is the next slice of this spec. What is asserted here is that the
 * binding is made where it can never be forged — at minting — and reported back, which is the
 * whole of what #291 promised.
 */

type Channel = {
  readonly id: string;
  readonly name: string;
  readonly metadata: Record<string, unknown>;
};

type Refusal = { readonly reason?: string; readonly error?: string };

/** Creates a Channel through the route a Merchant uses, and answers what came back. */
async function create(
  kobai: TestKobai,
  merchant: TestSession,
  body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly body: Channel & Refusal }> {
  const response = await kobai.request("/admin/channels", {
    method: "POST",
    headers: { ...merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Channel & Refusal };
}

describe("the Channels a Store sells through", () => {
  it("is created, read, listed, renamed and deleted", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const created = await create(kobai, merchant, {
      name: "Marketplace",
      metadata: { fee: "15%" },
    });

    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      name: "Marketplace",
      metadata: { fee: "15%" },
    });

    const read = await kobai.request(`/admin/channels/${created.body.id}`, {
      headers: merchant.headers,
    });
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toEqual(created.body);

    const listed = await kobai.request("/admin/channels", { headers: merchant.headers });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ channels: [created.body] });

    const renamed = await kobai.request(`/admin/channels/${created.body.id}`, {
      method: "PATCH",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "The marketplace" }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toEqual({
      ...created.body,
      name: "The marketplace",
    });

    const deleted = await kobai.request(`/admin/channels/${created.body.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(deleted.status).toBe(204);
    await expect(
      (await kobai.request("/admin/channels", { headers: merchant.headers })).json(),
    ).resolves.toEqual({ channels: [] });
  });

  it("answers the same word for an address that names nothing and for one that is not an address", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    for (const id of ["3f6a4b2c-0d1e-4f2a-8b3c-4d5e6f708192", "not-an-identifier"]) {
      const response = await kobai.request(`/admin/channels/${id}`, {
        headers: merchant.headers,
      });

      expect(response.status, id).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        reason: "channel-not-found",
      });
    }
  });
});

describe("which Channel a request is in", () => {
  it("is decided by the API key, and a key minted without one is unconstrained", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const marketplace = await create(kobai, merchant, { name: "Marketplace" });

    const bound = await kobai.request("/admin/api-keys", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "the marketplace's",
        kind: "secret",
        channelId: marketplace.body.id,
      }),
    });

    expect(bound.status).toBe(201);
    await expect(bound.json()).resolves.toMatchObject({
      channelId: marketplace.body.id,
    });

    // The ordinary key, which is every key that exists today: `null` means *in no particular
    // Channel*, which is the only thing a deployment that has defined none can say.
    const unconstrained = await createTestApiKey(kobai, merchant, {
      name: "a storefront",
    });
    const listed = (await (
      await kobai.request("/admin/api-keys", { headers: merchant.headers })
    ).json()) as { apiKeys: readonly { id: string; channelId: string | null }[] };

    expect(
      listed.apiKeys.find((one) => one.id === unconstrained.id)?.channelId,
    ).toBeNull();
  });

  it("refuses a key minted against a Channel this Store has not got", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/api-keys", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({
        name: "a storefront",
        kind: "publishable",
        channelId: "3f6a4b2c-0d1e-4f2a-8b3c-4d5e6f708192",
      }),
    });

    // 422 rather than 400, on `collection-not-found`'s distinction: the body is well formed —
    // an identifier in the right field — and what refuses it is the state of the Store. It is
    // the same word `GET /admin/channels/{id}` answers 404 with.
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "channel-not-found",
    });
  });

  it("leaves a key working, unconstrained, when its Channel is deleted", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const marketplace = await create(kobai, merchant, { name: "Marketplace" });
    const minted = (await (
      await kobai.request("/admin/api-keys", {
        method: "POST",
        headers: { ...merchant.headers, "content-type": "application/json" },
        body: JSON.stringify({
          name: "the marketplace's",
          kind: "secret",
          channelId: marketplace.body.id,
        }),
      })
    ).json()) as { id: string; key: string };

    const deleted = await kobai.request(`/admin/channels/${marketplace.body.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });

    // Refused for nothing, and the key is not taken with it — `on delete set null`, which is
    // the judgement `DELETE /admin/collections/{id}` makes at a different table. Refusing
    // instead would make a Channel any key had ever named permanently undeletable, since
    // revocation is a column rather than a delete.
    expect(deleted.status).toBe(204);
    const listed = (await (
      await kobai.request("/admin/api-keys", { headers: merchant.headers })
    ).json()) as { apiKeys: readonly { id: string; channelId: string | null }[] };
    expect(listed.apiKeys.find((one) => one.id === minted.id)?.channelId).toBeNull();

    // And it is still a working credential rather than merely a row: the store surface takes
    // it, which is the half a column read could not have said.
    const opened = await kobai.request("/store/products", {
      headers: { authorization: `Bearer ${minted.key}` },
    });
    expect(opened.status).toBe(200);
  });
});

describe("a Channel is not a tenant", () => {
  it("is referenced by an API key's Channel and by nothing else", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const table = await channelTable(schema);

    // ADR-0005 names this one specifically: *Vendure overloads its `Channel` to mean both sales
    // channel and tenant boundary, and it is a known source of confusion. kobai's Channel means
    // sales channel only.* A `channel_id` appearing on a catalog table, a Cart or an Order is
    // what this names — and `core_price`'s, when spec 4's next slice adds one, is a decision to
    // take against this assertion rather than one to make quietly.
    await expect(schema.foreignKeysTargeting(table)).resolves.toEqual([
      {
        constraint: "core_api_key_channel_id_core_channel_id_fk",
        from: { schema: table.schema, name: "core_api_key" },
        to: table,
      },
    ]);
  });

  it("has that proven by a sweep that names a foreign key when one arrives", async () => {
    await using kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);
    const table = await channelTable(schema);

    await kobai.database.query(`
      create table core_scoped_by_channel (
        id uuid primary key default gen_random_uuid(),
        channel_id uuid not null,
        constraint core_scoped_channel_fk foreign key (channel_id) references core_channel (id)
      )
    `);

    await expect(schema.foreignKeysTargeting(table)).resolves.toEqual([
      {
        constraint: "core_api_key_channel_id_core_channel_id_fk",
        from: { schema: table.schema, name: "core_api_key" },
        to: table,
      },
      {
        constraint: "core_scoped_channel_fk",
        from: { schema: table.schema, name: "core_scoped_by_channel" },
        to: table,
      },
    ]);
  });
});

/** The Channel table, qualified as Postgres actually holds it — see `regionTable`'s reason. */
async function channelTable(schema: SchemaInspector): Promise<TableRef> {
  const matches = (await schema.tables()).filter(
    (table) => table.name === "core_channel",
  );
  const [channel] = matches;
  if (matches.length !== 1 || channel === undefined) {
    throw new Error(`expected exactly one core_channel table, found ${matches.length}`);
  }
  return channel;
}
