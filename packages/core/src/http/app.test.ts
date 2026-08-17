import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  sessionOf,
  signInTestMerchant,
  type TestKobai,
} from "../testing/index.ts";

/**
 * What the whole surface does with a request no route wanted to see.
 *
 * These are refusals the routes themselves never make — they are made above every one of
 * them — and the thing worth asserting about each is *whose mistake it is reported as*. A
 * client error answered 500 tells a Developer the server is broken and pages an operator
 * about a typo.
 */
describe("a request body that will not parse", () => {
  /**
   * Signed in, because every route that takes a body is behind the gate (#25) and the gate
   * answers first. That ordering is the subject of `auth.test.ts`; here it is only the
   * reason these three have to get through the door before they can send a bad body.
   */
  async function post(kobai: TestKobai, body: string): Promise<Response> {
    const merchant = await signInTestMerchant(kobai);
    return kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...merchant.headers, "content-type": "application/json" },
      body,
    });
  }

  it("is the client's mistake, and is answered as one", async () => {
    await using kobai = await createTestKobai();

    const response = await post(kobai, "not json at all");

    expect(response.status).toBe(400);
    // Distinct from the `invalid` a schema failure answers with: this body cannot be read
    // at all, that one reads fine and does not fit, and they have different fixes.
    await expect(response.json()).resolves.toMatchObject({ reason: "malformed-body" });
  });

  it("is answered the same way when the body is empty", async () => {
    await using kobai = await createTestKobai();

    const response = await post(kobai, "");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "malformed-body" });
  });

  it("is `invalid`, not `malformed-body`, when it parses and does not fit", async () => {
    await using kobai = await createTestKobai();

    const response = await post(kobai, JSON.stringify([]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });
});

/**
 * A path no route serves — the one refusal a client cannot anticipate.
 *
 * Every other one is declared: a route names the statuses it answers with, and those reach
 * `@kobai/client` as a union a storefront narrows on. This one is answered by no route, which
 * is exactly why it used to be the odd shape out — Hono's own 404 is plain text, so a client
 * got JSON for every failure it could plan for and text for the one it could not.
 */
describe("a path no route serves", () => {
  it("is refused in the same shape as the gate refusal beside it", async () => {
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const unrouted = await kobai.request("/admin/nothing-here", {
      headers: merchant.headers,
    });
    const gated = await kobai.request("/admin/store");

    expect(unrouted.status).toBe(404);
    expect(gated.status).toBe(401);
    // The two are asserted together, and compared field name by field name rather than
    // against a remembered literal, so neither can be changed on its own: the shape a client
    // parses is the same whether kobai turned the caller back at the gate or never found a
    // route for them.
    expect(unrouted.headers.get("content-type")).toBe(gated.headers.get("content-type"));
    // …and both are JSON, so the pair cannot pass by drifting together.
    expect(unrouted.headers.get("content-type")).toContain("application/json");
    const [missing, refused] = (await Promise.all([unrouted.json(), gated.json()])) as [
      object,
      object,
    ];
    expect(Object.keys(missing).sort()).toEqual(Object.keys(refused).sort());
    expect(missing).toMatchObject({ error: expect.any(String), reason: "not-found" });
    expect(refused).toMatchObject({
      error: expect.any(String),
      reason: "session-missing",
    });
  });

  it("is refused by the gate first, before saying whether it is there", async () => {
    // The admin gate is mounted with `use("*")`, so it runs before routing: an anonymous
    // caller is told the same thing about a path that exists and a path that does not, and
    // cannot map the surface by watching which ones 404. The same property the store surface
    // has (`store.test.ts`), and the reason the description is not served (`openapi.ts`).
    await using kobai = await createTestKobai();

    const response = await kobai.request("/admin/nothing-here");

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it("tells a signed-in Merchant a forbidden route from an absent one", async () => {
    // The other half of ADR-0040's position, and the half that is a deliberate disclosure:
    // past the gate, route existence is not a secret. The route set is identical in every
    // deployment, generated into `openapi.json` and shipped in `@kobai/client`, so hiding a
    // 404 behind a 403 would buy no secrecy and would cost a Developer the difference
    // between a typo and a permission they lack. What stays hidden is which *rows* exist —
    // `requirePermission` answers before the handler ever looks (ADR-0027).
    await using kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    // A Role holding nothing at all. Roles are rows, so a narrower one is a row.
    await kobai.db.execute(
      sql`insert into core_role (name, permissions) values ('bookkeeper', array[]::text[])`,
    );
    const credentials = {
      email: "books@example.test",
      password: "a bookkeeper's very long password",
    };
    await kobai.request("/admin/merchants", {
      method: "POST",
      headers: { ...owner.headers, "content-type": "application/json" },
      body: JSON.stringify({ ...credentials, role: "bookkeeper" }),
    });
    const bookkeeper = sessionOf(
      await kobai.request("/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials),
      }),
    );

    const forbidden = await kobai.request("/admin/products", {
      headers: bookkeeper.headers,
    });
    const absent = await kobai.request("/admin/nothing-here", {
      headers: bookkeeper.headers,
    });

    expect(forbidden.status).toBe(403);
    expect(absent.status).toBe(404);
    await expect(forbidden.json()).resolves.toMatchObject({
      reason: "permission-denied",
    });
    await expect(absent.json()).resolves.toMatchObject({ reason: "not-found" });
  });

  it("answers the same way for a method a path does not serve", async () => {
    await using kobai = await createTestKobai();

    // Reported as a path that is not there rather than as a method that is not allowed:
    // distinguishing the two would mean enumerating the methods of every path, and the
    // description already enumerates them for anyone who needs the list.
    const response = await kobai.request("/health", { method: "DELETE" });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-found" });
  });

  it("answers the same way outside both authenticated surfaces", async () => {
    // One handler covers the whole application, not one per surface — a typo at the root is
    // the same class of mistake as a typo under `/admin`, and a Project hands kobai
    // everything it does not serve itself (`reference/src/app.ts`).
    await using kobai = await createTestKobai();

    const response = await kobai.request("/heath");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ reason: "not-found" });
  });
});
