import { afterEach, describe, expect, it } from "vitest";
import {
  createTestKobai,
  sessionOf,
  signInTestMerchant,
  TEST_MERCHANT,
  type TestKobai,
} from "../testing/index.ts";

/**
 * API keys — the credential the store surface is gated by (ADR-0020).
 *
 * Everything a Developer does goes through the public HTTP API, because that is how they do
 * it. The tests that reach into the database do so on purpose and for one reason: what is
 * *stored* is the whole security property here, and no response can show that a column does
 * not hold a key.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

async function created(
  instance: TestKobai,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Record<string, string>> {
  const response = await instance.request("/admin/api-keys", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, string>;
}

describe("creating an API key", () => {
  it("shows the key value once, at creation", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const key = await created(kobai, merchant.headers, {
      name: "storefront",
      kind: "secret",
    });

    expect(key.key).toMatch(/^kobai_sk_[A-Za-z0-9_-]{43}$/);
    expect(key.name).toBe("storefront");
    expect(key.kind).toBe("secret");
    // The id outlives the value, which is what makes the key revocable after this response.
    expect(key.id).toEqual(expect.any(String));
  });

  it("tells publishable and secret apart from the value itself", async () => {
    // Spec story 45: a Developer must be able to see that a key is secret without asking
    // kobai, so that shipping one to a browser is a visible mistake rather than a silent one.
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const publishable = await created(kobai, merchant.headers, {
      name: "browser",
      kind: "publishable",
    });
    const secret = await created(kobai, merchant.headers, {
      name: "server",
      kind: "secret",
    });

    expect(publishable.key).toMatch(/^kobai_pk_/);
    expect(secret.key).toMatch(/^kobai_sk_/);
  });

  it("stores no value that could be presented back", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const key = await created(kobai, merchant.headers, {
      name: "server",
      kind: "secret",
    });

    const rows = await kobai.database.query<Record<string, unknown>>(
      "select * from core_api_key",
    );
    expect(rows).toHaveLength(1);
    // Not "the value is not in the column we chose" but "the value is nowhere in the row":
    // a dump of this table hands an attacker nothing to present.
    expect(JSON.stringify(rows[0])).not.toContain(key.key);
  });

  it("refuses a kind that is neither publishable nor secret", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/api-keys", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "confused", kind: "publishable-ish" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("is closed to a caller with no session", async () => {
    kobai = await createTestKobai();

    const response = await kobai.request("/admin/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "storefront", kind: "secret" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it("is closed to a Role that does not hold api-key:write", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // A Role narrow enough to be the subject of the test rather than a detail of it.
    const password = "a reader's very long password";
    await kobai.database.query(
      "insert into core_role (name, permissions) values ('reader', array['store:read'])",
    );
    await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.test", password, role: "reader" }),
    });
    const reader = sessionOf(
      await kobai.request("/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "reader@example.test", password }),
      }),
    );

    const response = await kobai.request("/admin/api-keys", {
      method: "POST",
      headers: {
        ...reader.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "storefront", kind: "secret" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: "api-key:write",
    });
  });
});

describe("revoking an API key", () => {
  it("revokes it, and says so when there was no such key", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const key = await created(kobai, merchant.headers, {
      name: "server",
      kind: "secret",
    });

    const revoked = await kobai.request(`/admin/api-keys/${key.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(revoked.status).toBe(204);

    // Read from the database, because there is no route that reports a key's state — a
    // storefront finding out is what `/store` answering 401 means, and that is asserted
    // where the store surface is (`http/store.test.ts`).
    const revokedAt = async () =>
      (
        await kobai?.database.query<{ revoked_at: Date | null }>(
          "select revoked_at from core_api_key",
        )
      )?.[0]?.revoked_at;

    const stoppedWorking = await revokedAt();
    expect(stoppedWorking).toBeInstanceOf(Date);

    // Revoking twice is idempotent, and does not move the moment it stopped working — which
    // is the fact anybody asks this column for after an incident.
    await kobai.request(`/admin/api-keys/${key.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    expect(await revokedAt()).toEqual(stoppedWorking);

    const absent = await kobai.request(
      "/admin/api-keys/00000000-0000-4000-8000-000000000000",
      { method: "DELETE", headers: merchant.headers },
    );
    expect(absent.status).toBe(404);
    await expect(absent.json()).resolves.toMatchObject({ reason: "api-key-not-found" });
  });
});

describe("listing API keys", () => {
  it("names every key that exists, and carries no value to present", async () => {
    // The gap this closes: minting answers with the value once and the id once, so a
    // Merchant who lost that response held a live credential they could not revoke.
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const browser = await created(kobai, merchant.headers, {
      name: "browser",
      kind: "publishable",
    });
    const server = await created(kobai, merchant.headers, {
      name: "server",
      kind: "secret",
    });

    const response = await kobai.request("/admin/api-keys", {
      headers: merchant.headers,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apiKeys: { id: string; name: string; kind: string; revokedAt: string | null }[];
    };
    // Newest first, like the Product list.
    expect(body.apiKeys.map((key) => key.name)).toEqual(["server", "browser"]);
    expect(body.apiKeys.map((key) => key.kind)).toEqual(["secret", "publishable"]);
    expect(body.apiKeys.map((key) => key.id)).toEqual([server.id, browser.id]);
    // The whole security property of this route, and the reason it is worth asserting on
    // the serialised body rather than field by field: #6 stores only a SHA-256 and shows
    // the value once, so a listing that leaked any part of a key would undo that quietly.
    const listed = JSON.stringify(body);
    expect(listed).not.toContain(server.key);
    expect(listed).not.toContain(browser.key);
    expect(listed).not.toContain("kobai_sk_");
    expect(listed).not.toContain("kobai_pk_");
  });

  it("keeps a revoked key in the list, and says when it stopped working", async () => {
    // A revoked key that vanished would make the list unusable as an audit: "no such key"
    // and "revoked last Tuesday" are different answers to the same question.
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const key = await created(kobai, merchant.headers, {
      name: "server",
      kind: "secret",
    });

    await kobai.request(`/admin/api-keys/${key.id}`, {
      method: "DELETE",
      headers: merchant.headers,
    });
    const response = await kobai.request("/admin/api-keys", {
      headers: merchant.headers,
    });

    const body = (await response.json()) as {
      apiKeys: { id: string; revokedAt: string | null }[];
    };
    expect(body.apiKeys).toHaveLength(1);
    expect(body.apiKeys[0]?.id).toBe(key.id);
    expect(body.apiKeys[0]?.revokedAt).toEqual(expect.any(String));
  });

  it("is closed to a caller with no session", async () => {
    kobai = await createTestKobai();

    const response = await kobai.request("/admin/api-keys");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it("is closed to a Role that does not hold api-key:read", async () => {
    // Reading the list is its own permission: a Merchant may be allowed to see which
    // credentials exist without being allowed to mint or revoke one.
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const password = "a reader's very long password";
    await kobai.database.query(
      "insert into core_role (name, permissions) values ('reader', array['store:read'])",
    );
    await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body: JSON.stringify({ email: "reader@example.test", password, role: "reader" }),
    });
    const reader = sessionOf(
      await kobai.request("/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "reader@example.test", password }),
      }),
    );

    const response = await kobai.request("/admin/api-keys", {
      headers: reader.headers,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: "api-key:read",
    });
  });
});

describe("the owner Role", () => {
  it("holds the API key permissions on a freshly migrated deployment", async () => {
    // The seeded Role gains each new permission through a migration of its own, so an
    // existing deployment's owner keeps holding everything Core defines (ADR-0027).
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai, TEST_MERCHANT);

    expect(merchant.role.permissions).toContain("api-key:write");
    expect(merchant.role.permissions).toContain("api-key:read");
  });
});
