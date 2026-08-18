import { afterEach, describe, expect, it } from "vitest";
import { expectStatus } from "../testing/expect-status.ts";
import {
  createTestKobai,
  sessionOf,
  signInTestMerchant,
  TEST_MERCHANT,
  type TestKobai,
  type TestSession,
} from "../testing/index.ts";
import { PERMISSIONS } from "./permissions.ts";

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

/** The harness the test in hand is running against, so a helper below need not re-narrow it. */
function running(): TestKobai {
  if (!kobai) throw new Error("this test has no kobai — call createTestKobai first.");
  return kobai;
}

/**
 * Roles over HTTP — the surface that makes ADR-0027's permission model something a deployment
 * can use rather than something its schema merely allows.
 *
 * Every arrangement here goes through the public API, including the narrow Roles the
 * permission tests elsewhere in this repository need. They used to be built with
 * `insert into core_role …` and a comment saying "Roles are rows, so a narrower one is a row",
 * which was true and was also the finding: a model reachable only from SQL is a model no
 * Merchant has.
 */

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("POST /admin/roles", () => {
  it("creates a Role holding a named set of Permissions", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/roles",
      json({ name: "bookkeeper", permissions: ["order:read"] }, owner.headers),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      name: "bookkeeper",
      permissions: ["order:read"],
      metadata: {},
    });
  });

  it("creates a Role holding nothing at all", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/roles",
      json({ name: "nobody" }, owner.headers),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ permissions: [] });
  });

  it("refuses a name another Role already carries", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/roles",
      json({ name: "owner", permissions: [] }, owner.headers),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "role-name-taken" });
  });

  it("preserves a Permission this build of Core has never heard of", async () => {
    // The decision ADR-0066 records, and the one the `Session` schema already promised: a
    // Plugin's Permission is a string like any other, so Core storing only its own five would
    // make that description false and foreclose one before anybody has designed it.
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const created = await kobai.request(
      "/admin/roles",
      json(
        { name: "editor", permissions: ["content:write", PERMISSIONS.catalogRead] },
        owner.headers,
      ),
    );
    const { id } = (await created.json()) as { id: string };

    const read = await kobai.request(`/admin/roles/${id}`, { headers: owner.headers });

    expect(created.status).toBe(201);
    await expect(read.json()).resolves.toMatchObject({
      permissions: ["content:write", PERMISSIONS.catalogRead],
    });
  });

  it("refuses a permission that is not a string, which is a shape and not a vocabulary", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/roles",
      json({ name: "confused", permissions: [{ store: "read" }] }, owner.headers),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});

describe("GET /admin/roles", () => {
  it("lists the Roles this deployment has, newest first", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    await kobai.request("/admin/roles", json({ name: "bookkeeper" }, owner.headers));

    const response = await kobai.request("/admin/roles", { headers: owner.headers });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { roles: { name: string }[] };
    expect(body.roles.map((role) => role.name)).toEqual(["bookkeeper", "owner"]);
  });

  it("says nothing follows the last page", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const body = await (
      await kobai.request("/admin/roles", { headers: owner.headers })
    ).json();

    // Absent rather than null: its absence is the only end-of-list signal there is (ADR-0064).
    expect(body).not.toHaveProperty("nextCursor");
  });
});

describe("GET /admin/roles/{id}", () => {
  it("answers 404 for an identifier nothing carries, and for a string that is not one", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const missing = await kobai.request(
      "/admin/roles/00000000-0000-4000-8000-000000000000",
      { headers: owner.headers },
    );
    const nonsense = await kobai.request("/admin/roles/not-an-id", {
      headers: owner.headers,
    });

    expect([missing.status, nonsense.status]).toEqual([404, 404]);
    await expect(missing.json()).resolves.toMatchObject({ reason: "role-not-found" });
  });
});

describe("PATCH /admin/roles/{id}", () => {
  it("replaces the whole permission set rather than adding to it", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await createRole(owner, {
      name: "bookkeeper",
      permissions: [PERMISSIONS.orderRead, PERMISSIONS.catalogRead],
    });

    const response = await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: [PERMISSIONS.orderRead] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      name: "bookkeeper",
      permissions: [PERMISSIONS.orderRead],
    });
  });

  it("leaves alone what the body does not name, and refuses a body that names nothing", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await createRole(owner, {
      name: "bookkeeper",
      permissions: [PERMISSIONS.orderRead],
      metadata: { desk: 4 },
    });

    const renamed = await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "accountant" }),
    });
    const empty = await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    await expect(renamed.json()).resolves.toEqual({
      id,
      name: "accountant",
      permissions: [PERMISSIONS.orderRead],
      metadata: { desk: 4 },
    });
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses a name another Role already carries", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await createRole(owner, { name: "bookkeeper" });

    const response = await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "owner" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "role-name-taken" });
  });

  it("takes effect on the next request a Merchant already signed in makes", async () => {
    // The Role is read on every request rather than copied into the session, so access
    // follows the job without anybody signing out — which is what #178's affordances assume.
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await createRole(owner, {
      name: "bookkeeper",
      permissions: [PERMISSIONS.storeRead],
    });
    const bookkeeper = await signInAgainst(owner, "bookkeeper");

    const before = await kobai.request("/admin/store", { headers: bookkeeper.headers });
    await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: [] }),
    });
    const after = await kobai.request("/admin/store", { headers: bookkeeper.headers });
    const session = await kobai.request("/admin/session", {
      headers: bookkeeper.headers,
    });

    expect([before.status, after.status]).toEqual([200, 403]);
    await expect(session.json()).resolves.toMatchObject({
      role: { name: "bookkeeper", permissions: [] },
    });
  });
});

describe("DELETE /admin/roles/{id}", () => {
  it("deletes a Role nobody holds", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await createRole(owner, { name: "bookkeeper" });

    const response = await kobai.request(`/admin/roles/${id}`, {
      method: "DELETE",
      headers: owner.headers,
    });
    const read = await kobai.request(`/admin/roles/${id}`, { headers: owner.headers });

    expect(response.status).toBe(204);
    expect(read.status).toBe(404);
  });

  it("refuses a Role Merchants hold rather than cascading onto them", async () => {
    // ADR-0059's shape, reached through the one foreign key that points at this table: the
    // Merchants stay, and the Merchant who asked is told to move them.
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await createRole(owner, { name: "bookkeeper" });
    await signInAgainst(owner, "bookkeeper");

    const response = await kobai.request(`/admin/roles/${id}`, {
      method: "DELETE",
      headers: owner.headers,
    });
    const merchants = await kobai.request("/admin/merchants", { headers: owner.headers });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ reason: "role-in-use" });
    const body = (await merchants.json()) as { merchants: { email: string }[] };
    expect(body.merchants).toHaveLength(2);
  });
});

describe("GET /admin/merchants", () => {
  it("lists the Merchants of this deployment with the Role each holds", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    await createRole(owner, { name: "bookkeeper", permissions: [PERMISSIONS.orderRead] });
    await signInAgainst(owner, "bookkeeper");

    const response = await kobai.request("/admin/merchants", { headers: owner.headers });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      merchants: { email: string; role: { name: string } }[];
    };
    // Newest first, like every other list here.
    expect(body.merchants.map((each) => [each.email, each.role.name])).toEqual([
      [COLLEAGUE.email, "bookkeeper"],
      [TEST_MERCHANT.email, "owner"],
    ]);
  });

  it("reports a Permission Core has never heard of, on the Merchant who holds it", async () => {
    // The other end of the decision `POST /admin/roles` takes: a word Core does not know is
    // preserved *and travels* — through the roster, and through the session that Merchant reads
    // about themselves. A build that quietly filtered to Core's own would pass every assertion
    // made at the Role and still tell this Merchant they hold nothing.
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    await createRole(owner, { name: "editor", permissions: ["content:write"] });
    const editor = await signInAgainst(owner, "editor");

    const roster = await kobai.request("/admin/merchants", { headers: owner.headers });
    const session = await kobai.request("/admin/session", { headers: editor.headers });

    const { merchants } = (await roster.json()) as {
      merchants: { email: string; role: { permissions: string[] } }[];
    };
    expect(
      merchants.find((each) => each.email === COLLEAGUE.email)?.role.permissions,
    ).toEqual(["content:write"]);
    await expect(session.json()).resolves.toMatchObject({
      role: { name: "editor", permissions: ["content:write"] },
    });
  });

  it("never reports a password digest", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const body = await (
      await kobai.request("/admin/merchants", { headers: owner.headers })
    ).text();

    expect(body).not.toContain("$argon2");
    expect(body).not.toContain("passwordHash");
  });
});

describe("a Merchant against a narrower Role", () => {
  it("is refused the routes their Role does not cover, including these ones", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    await createRole(owner, { name: "bookkeeper", permissions: [PERMISSIONS.orderRead] });
    const bookkeeper = await signInAgainst(owner, "bookkeeper");

    const orders = await kobai.request("/admin/orders", { headers: bookkeeper.headers });
    const roles = await kobai.request("/admin/roles", { headers: bookkeeper.headers });
    const merchants = await kobai.request("/admin/merchants", {
      headers: bookkeeper.headers,
    });

    expect(orders.status).toBe(200);
    expect([roles.status, merchants.status]).toEqual([403, 403]);
    // 403 and not 404: they are signed in, and the answer names the Permission they lack.
    await expect(roles.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: PERMISSIONS.merchantWrite,
    });
  });
});

describe("the last Merchant who can administer Merchants", () => {
  it("cannot be stripped of it, and the refusal says so by name", async () => {
    // A lockout, not a preference: nobody would be left who could put `merchant:write` back,
    // and nobody who could sign a colleague up to try (ADR-0066).
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await roleNamed(owner, "owner");

    const response = await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: [PERMISSIONS.storeRead] }),
    });
    const after = await kobai.request("/admin/session", { headers: owner.headers });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "last-administrator",
    });
    // And the Role was left exactly as it was found, rather than half-narrowed.
    await expect(after.json()).resolves.toMatchObject({
      role: { permissions: expect.arrayContaining([PERMISSIONS.merchantWrite]) },
    });
  });

  it("may be narrowed once somebody else can administer Merchants", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const ownerRole = await roleNamed(owner, "owner");
    await createRole(owner, {
      name: "administrator",
      permissions: [PERMISSIONS.merchantWrite],
    });
    await signInAgainst(owner, "administrator");

    const response = await kobai.request(`/admin/roles/${ownerRole}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: [PERMISSIONS.storeRead] }),
    });

    expect(response.status).toBe(200);
  });

  it("is not protected by a Role nobody holds", async () => {
    // The permission has to be *held*, not merely written down somewhere: a Role with
    // `merchant:write` and no Merchant on it is nobody's way back in.
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const ownerRole = await roleNamed(owner, "owner");
    await createRole(owner, {
      name: "administrator",
      permissions: [PERMISSIONS.merchantWrite],
    });

    const response = await kobai.request(`/admin/roles/${ownerRole}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ permissions: [PERMISSIONS.storeRead] }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      reason: "last-administrator",
    });
  });

  it("is left free to change anything else about the Role", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const id = await roleNamed(owner, "owner");

    const response = await kobai.request(`/admin/roles/${id}`, {
      method: "PATCH",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "proprietor", metadata: { seat: 1 } }),
    });

    expect(response.status).toBe(200);
  });
});

/** The colleague every test above signs in as. One address, so nothing is asked by position. */
const COLLEAGUE = {
  email: "books@example.test",
  password: "a bookkeeper's very long password",
};

/** Creates a Role through the public API and answers with its identifier. */
async function createRole(
  owner: TestSession,
  body: { name: string; permissions?: string[]; metadata?: Record<string, unknown> },
): Promise<string> {
  const response = await running().request("/admin/roles", json(body, owner.headers));
  const created = (await expectStatus(
    response,
    201,
    `creating the Role ${body.name}`,
  )) as { id: string };
  return created.id;
}

/** The identifier of a Role this deployment already has — `owner`, which a migration seeded. */
async function roleNamed(owner: TestSession, name: string): Promise<string> {
  const response = await running().request("/admin/roles", { headers: owner.headers });
  const { roles } = (await expectStatus(response, 200, "listing Roles")) as {
    roles: { id: string; name: string }[];
  };
  const found = roles.find((role) => role.name === name);
  if (!found) throw new Error(`no Role named ${name} exists`);
  return found.id;
}

/**
 * Adds the colleague against a named Role and signs them in, the way a browser would — the
 * only way there is, since a deployment has ever only one first Merchant (ADR-0041).
 */
async function signInAgainst(
  owner: TestSession,
  role: string,
): Promise<Pick<TestSession, "headers" | "token">> {
  const kobai = running();
  const created = await kobai.request(
    "/admin/merchants",
    json({ ...COLLEAGUE, role }, owner.headers),
  );
  await expectStatus(created, 201, `adding a colleague against ${role}`);

  const response = await kobai.request("/admin/session", json(COLLEAGUE));
  await expectStatus(response, 201, `signing in against ${role}`);
  return sessionOf(response);
}
