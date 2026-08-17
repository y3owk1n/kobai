import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestKobai,
  inspectSchema,
  seedTestMerchant,
  sessionOf,
  signInTestMerchant,
  TEST_MERCHANT,
  type TestKobai,
} from "../testing/index.ts";
import { ALL_PERMISSIONS, PERMISSIONS } from "./permissions.ts";
import {
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_EXTENSION_INTERVAL_MS,
  SESSION_IDLE_WINDOW_MS,
} from "./session.ts";

/**
 * Merchant auth, through the seam a Merchant and the Admin actually use: the public HTTP API,
 * dispatched in-process against a real Postgres.
 *
 * Sign in, use the session, let it expire, sign out. Nothing here reaches into the auth
 * modules — a session that a test can only make work by calling an internal is a session the
 * Admin cannot use.
 */

let kobai: TestKobai | undefined;

afterEach(async () => {
  await kobai?.close();
  kobai = undefined;
});

// The same Merchant `signInTestMerchant` creates, so a test may drive either by hand or
// through the helper and still be talking about one person.
const { email: EMAIL, password: PASSWORD } = TEST_MERCHANT;

const json = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) satisfies RequestInit;

describe("creating a Merchant", () => {
  it("refuses an anonymous request, even on a deployment that has no Merchant", async () => {
    kobai = await createTestKobai();

    const response = await kobai.request(
      "/admin/merchants",
      json({ email: EMAIL, password: PASSWORD }),
    );

    // This route used to answer an anonymous request while no Merchant existed, so whoever
    // reached a fresh deployment first owned the Store. The first Merchant is seeded at boot
    // now (#25), and this is an ordinary guarded route with nothing special about it.
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
    // Nothing was created on the way to being refused: the gate answers before the handler.
    const [row] = await kobai.database.query<{ count: string }>(
      "select count(*)::text as count from core_merchant",
    );
    expect(row?.count).toBe("0");
  });

  it("refuses a second one to a request with no session", async () => {
    kobai = await createTestKobai();
    await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/merchants",
      json({ email: "second@example.test", password: PASSWORD }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it("lets a Merchant holding merchant:write create another", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/merchants",
      json({ email: "second@example.test", password: PASSWORD }, owner.headers),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      id: expect.any(String),
      email: "second@example.test",
      // The seeded Role, holding every permission Core defines.
      role: { name: "owner", permissions: [...ALL_PERMISSIONS] },
    });
    const created = await kobai.request(
      "/admin/session",
      json({ email: "second@example.test", password: PASSWORD }),
    );
    expect(created.status).toBe(201);
  });

  it("refuses a password short enough to be guessed", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/merchants",
      json({ email: "second@example.test", password: "short" }, owner.headers),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "invalid" });
  });

  it("refuses an email another Merchant already holds, however it is capitalised", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai, {
      email: EMAIL,
      password: PASSWORD,
    });

    const response = await kobai.request(
      "/admin/merchants",
      json({ email: EMAIL.toUpperCase(), password: PASSWORD }, owner.headers),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: "email-taken" });
  });

  it("refuses the loser of a race for one address, rather than failing", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    const contested = json(
      { email: "contested@example.test", password: PASSWORD },
      owner.headers,
    );

    const [first, second] = await Promise.all([
      kobai.request("/admin/merchants", contested),
      kobai.request("/admin/merchants", contested),
    ]);

    // One 201 and one 409, in whichever order they land — never a 500. The unique index is
    // what decides, so there is no window between checking and inserting to lose.
    expect([first?.status, second?.status].sort()).toEqual([201, 409]);
  });

  it("refuses a Role nobody has created as a bad request, not a conflict", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);

    const response = await kobai.request(
      "/admin/merchants",
      json(
        { email: "ghost@example.test", password: PASSWORD, role: "no-such-role" },
        owner.headers,
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ reason: "unknown-role" });
  });
});

describe("signing in", () => {
  it("issues a session, and says what it is good for", async () => {
    kobai = await createTestKobai();
    await seedTestMerchant(kobai, { email: EMAIL, password: PASSWORD });

    const response = await kobai.request(
      "/admin/session",
      json({ email: EMAIL, password: PASSWORD }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { expiresAt: string };
    expect(body).toEqual({
      expiresAt: expect.any(String),
      merchant: { id: expect.any(String), email: EMAIL },
      role: { name: "owner", permissions: [...ALL_PERMISSIONS] },
    });
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("puts the credential in an httpOnly cookie and nowhere in the body", async () => {
    kobai = await createTestKobai();
    await seedTestMerchant(kobai, { email: EMAIL, password: PASSWORD });

    const response = await kobai.request(
      "/admin/session",
      json({ email: EMAIL, password: PASSWORD }),
    );

    // `sessionOf` throws when there is no cookie to read, so reaching the next line is
    // already the assertion that one was set.
    const { token } = sessionOf(response);

    // The whole reason for the cookie: a live session token is not in a response body, so
    // no logging integration can ever write one to disk by doing its job.
    await expect(response.text()).resolves.not.toContain(token);
  });

  it("answers a wrong password exactly as it answers an address nobody holds", async () => {
    kobai = await createTestKobai();
    await signInTestMerchant(kobai, { email: EMAIL, password: PASSWORD });

    const wrongPassword = await kobai.request(
      "/admin/session",
      json({ email: EMAIL, password: "not the right password" }),
    );
    const noSuchMerchant = await kobai.request(
      "/admin/session",
      json({ email: "nobody@example.test", password: PASSWORD }),
    );

    // Identical, because a different answer would make this endpoint a way to ask who works
    // here.
    expect(wrongPassword.status).toBe(401);
    expect(noSuchMerchant.status).toBe(401);
    await expect(wrongPassword.json()).resolves.toEqual(await noSuchMerchant.json());
  });
});

describe("the session cookie's attributes", () => {
  /** Signs in over `scheme`, optionally behind a proxy that says so, and reads what came back. */
  async function cookieFrom(
    harness: TestKobai,
    url = "http://kobai.test/admin/session",
    headers: Record<string, string> = {},
  ): Promise<string> {
    await seedTestMerchant(harness, { email: EMAIL, password: PASSWORD });
    const response = await harness.request(
      url,
      json({ email: EMAIL, password: PASSWORD }, headers),
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    // Asserted here so the negative expectations below cannot pass by there being no cookie
    // at all, which is the way a test like this quietly stops testing anything.
    expect(cookie).toContain("kobai_session=");
    return cookie;
  }

  it("is httpOnly and SameSite=Strict, and names no Path of its own", async () => {
    kobai = await createTestKobai();

    const cookie = await cookieFrom(kobai);

    // httpOnly is the point of the exercise: no script reads it, so no logging integration
    // and no third-party bundle can carry a live session off the page.
    expect(cookie).toContain("HttpOnly");
    // Strict rather than Lax: ADR-0010 puts the Admin in the same container as the API, so
    // every request it makes is same-site anyway and nothing enters this surface from another
    // site. Lax would keep a hole open for a flow that does not exist.
    expect(cookie).toContain("SameSite=Strict");
    // No `Path`, so the browser files it under the directory it was set from — `/admin` here,
    // `/api/admin` for a Project that mounted Core at `/api`, and never `/store` or `/health`.
    // A named `Path` could only be right for one of those, because a mount prefix is stripped
    // before Core sees the request (ADR-0031, ADR-0032). Where the cookie is then *sent* is
    // `session-cookie.test.ts`; this is only that the attribute is absent.
    expect(cookie).not.toMatch(/;\s*Path=/i);
  });

  it("does not expire in the browser, so the server stays the authority on when it does", async () => {
    kobai = await createTestKobai();

    const cookie = await cookieFrom(kobai);

    // A cookie the browser dropped would simply stop being sent, and the request after it
    // would be indistinguishable from an anonymous one — the Admin would render an empty page
    // where it owes a sign-in prompt. The `core_session` row decides expiry, and the gate goes
    // on answering `session-expired`.
    expect(cookie).not.toContain("Expires=");
    expect(cookie).not.toContain("Max-Age=");
  });

  it("is not Secure over plain HTTP, so local development works at all", async () => {
    kobai = await createTestKobai();

    const cookie = await cookieFrom(kobai);

    // `devbox run up` serves http://localhost. A cookie that only ever set over HTTPS
    // would make signing in impossible there.
    expect(cookie).not.toContain("Secure");
  });

  it.each([
    ["served over HTTPS itself", "https://kobai.test/admin/session", {}],
    [
      "behind a proxy that terminated TLS",
      "http://kobai.test/admin/session",
      { "x-forwarded-proto": "https" },
    ],
  ])(
    "is Secure when the request arrived over HTTPS — %s",
    async (_case, url, headers) => {
      kobai = await createTestKobai();

      const cookie = await cookieFrom(kobai, url, headers);

      // The proxy case is the one that matters in production: kobai is one container
      // (ADR-0010) and TLS is almost always terminated in front of it, so judging by the
      // process's own socket alone would drop `Secure` from every cookie a real deployment set.
      expect(cookie).toContain("Secure");
    },
  );
});

describe("a session authenticates the admin surface", () => {
  it("opens an endpoint the Merchant's Role has permission for", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ name: "kobai" });
  });

  it.each([
    ["no Cookie header at all", undefined, "session-missing"],
    ["cookies that do not include ours", "somebody_elses=value", "session-missing"],
    ["our cookie carrying nothing", "kobai_session=", "session-malformed"],
    ["a token nobody was issued", "kobai_session=notatokenanybodyhas", "session-unknown"],
  ])("rejects %s", async (_case, cookie, reason) => {
    kobai = await createTestKobai();
    await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", {
      headers: cookie === undefined ? {} : { cookie },
    });

    // The admin surface is not open by default: no session, no Store.
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason });
  });

  it("does not accept the session as a bearer token, which is where it used to travel", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const response = await kobai.request("/admin/store", {
      headers: { authorization: `Bearer ${merchant.token}` },
    });

    // The old transport is gone rather than merely deprecated. Accepting both would keep the
    // exposure ADR-0032 was written to close, for the sake of a caller nobody has.
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it("sends no bearer challenge, because it no longer accepts one", async () => {
    kobai = await createTestKobai();

    const response = await kobai.request("/admin/store");

    // RFC 6750's challenge names the scheme a request failed to satisfy. `/admin` is opened
    // by a cookie now, so naming `Bearer` would be an instruction that cannot work. The store
    // gate still sends it, because there it is still true.
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

/**
 * The property #25 exists to establish, and the one that has to outlive it: **nothing under
 * `/admin` may be reached without a session.**
 *
 * It is swept rather than listed, off the description this build produces, so a route added
 * to the wrong half of `admin.ts` fails here on the day it is written instead of on the day
 * somebody notices. `POST /admin/session` is the one operation excused, because it is what
 * mints a session — and it is excused by name, so removing the exception is a deliberate act.
 */
describe("the admin surface has no unauthenticated write path", () => {
  /** Every admin operation the description carries, in the spelling a request is made in. */
  function adminOperations(harness: TestKobai): { method: string; path: string }[] {
    const paths = harness.openapi().paths ?? {};
    return Object.entries(paths)
      .filter(([path]) => path.startsWith("/admin"))
      .flatMap(([path, item]) =>
        Object.keys(item as object)
          .filter((method) => METHODS.includes(method))
          .map((method) => ({
            method: method.toUpperCase(),
            // A parameter has to be some value; which one cannot matter, because the gate
            // answers before anything reads it.
            path: path.replace(/\{\w+\}/g, "00000000-0000-4000-8000-000000000000"),
          })),
      )
      .filter(({ method, path }) => !(method === "POST" && path === "/admin/session"));
  }

  const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

  it("refuses every operation it serves to a request carrying no session", async () => {
    kobai = await createTestKobai();
    const operations = adminOperations(kobai);

    for (const { method, path } of operations) {
      const response = await kobai.request(path, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify({}),
      });

      expect(response.status, `${method} ${path}`).toBe(401);
      await expect(response.json(), `${method} ${path}`).resolves.toMatchObject({
        reason: "session-missing",
      });
    }

    // A sweep that found nothing would pass every assertion made over it. Eleven is every
    // admin operation but `POST /admin/session`; the number moving is a route being added or
    // removed, which is exactly when somebody should look at this file.
    expect(operations).toHaveLength(11);
    // …and every one of them is refused on a deployment that has no Merchant at all, which
    // is the state the old anonymous path existed for.
    const [row] = await kobai.database.query<{ count: string }>(
      "select count(*)::text as count from core_merchant",
    );
    expect(row?.count).toBe("0");
  });

  it("refuses a write to a path it does not serve, rather than saying it is not there", async () => {
    kobai = await createTestKobai();

    // The gate is mounted `use("*")`, so it answers before routing (ADR-0040). A caller
    // cannot map the surface by watching which paths 404, and — the half that matters here —
    // a write to a path nothing serves is refused for the same reason as a write to one that
    // is: nobody asked.
    const response = await kobai.request("/admin/anything-at-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-missing" });
  });

  it("mints nothing on the one operation that answers without a session", async () => {
    kobai = await createTestKobai();

    // `POST /admin/session` is the exception above, so it is the one route worth asserting
    // *cannot write*: on a deployment with no Merchant it answers the same refusal it
    // answers a wrong password with, and leaves the database exactly as it found it.
    const response = await kobai.request(
      "/admin/session",
      json({ email: EMAIL, password: PASSWORD }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      reason: "invalid-credentials",
    });
    const [row] = await kobai.database.query<{ count: string }>(
      "select count(*)::text as count from core_merchant",
    );
    expect(row?.count).toBe("0");
  });
});

describe("a session expires", () => {
  it("signs the Merchant out rather than quietly treating them as anonymous", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // An unattended browser: time passes, and nobody clicks anything.
    await expire(kobai);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(401);
    // Distinguishable from "you never signed in". The Admin renders a sign-in prompt for
    // this, not the empty page an anonymous request would produce.
    await expect(response.json()).resolves.toMatchObject({ reason: "session-expired" });
  });

  it("says so every time the token is presented, not only the first time", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    await expire(kobai);

    const [first, second, third] = await Promise.all(
      [1, 2, 3].map(() => kobai?.request("/admin/store", { headers: merchant.headers })),
    );

    // The Admin fires several requests on a page load. If the first answer consumed the
    // session, the rest would come back "you never signed in" — the silent degradation this
    // is supposed to prevent, for every request but one.
    for (const response of [first, second, third]) {
      expect(response?.status).toBe(401);
      await expect(response?.json()).resolves.toMatchObject({
        reason: "session-expired",
      });
    }
  });

  it("is cleared from the database when that Merchant signs in again", async () => {
    kobai = await createTestKobai();
    await signInTestMerchant(kobai);
    await expire(kobai);

    await kobai.request("/admin/session", json({ email: EMAIL, password: PASSWORD }));

    // One live session, not two: dead rows are swept on the way in, so the table does not
    // grow forever in a deployment whose Merchants close the tab rather than signing out.
    const remaining = await kobai.db.execute<{ count: string }>(
      sql`select count(*)::text as count from core_session`,
    );
    expect(remaining.rows[0]?.count).toBe("1");
  });
});

describe("a session slides", () => {
  it("is kept alive by a Merchant who keeps working", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // Most of the window spent reading a page, then a click; then most of it again, and
    // another click. More than a whole window has passed since sign-in and the Merchant is
    // still working — so an expiry fixed at sign-in would have signed them out midway through
    // exactly the session story 49 is not about.
    await idleFor(kobai, 0.8 * SESSION_IDLE_WINDOW_MS);
    const midway = await kobai.request("/admin/store", { headers: merchant.headers });

    await idleFor(kobai, 0.8 * SESSION_IDLE_WINDOW_MS);
    const afterwards = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(midway.status).toBe(200);
    expect(afterwards.status).toBe(200);
  });

  it("runs out when nobody is using it, and says so", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // Story 49's unattended browser: the whole window passes with nobody clicking anything.
    await idleFor(kobai, SESSION_IDLE_WINDOW_MS);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(401);
    // Still *expired*, not anonymous. Sliding changes when the Merchant is signed out, never
    // what they are told about it — the Admin renders a sign-in prompt for this reason and an
    // empty page for `session-missing`.
    await expect(response.json()).resolves.toMatchObject({ reason: "session-expired" });
  });

  it("cannot be extended past the cap, however hard it is used", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // A session used continuously since it was minted — its idle deadline is still in the
    // future — but minted longer ago than a session is allowed to live. A window that only
    // ever slid forward would renew this one indefinitely, and a stolen token with it.
    await signedInAgo(kobai, SESSION_ABSOLUTE_LIFETIME_MS + 60_000);

    const response = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ reason: "session-expired" });
  });

  it("shortens its last window rather than overshooting the cap", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // Ten minutes short of the cap, and stale enough that this request extends it. A full
    // idle window from here would land twenty minutes past the cap, so the deadline the
    // Merchant is given has to be the ten minutes that are left rather than the thirty they
    // would get at any other moment of the session.
    const remainder = 10 * 60_000;
    await signedInAgo(kobai, SESSION_ABSOLUTE_LIFETIME_MS - remainder);
    await idleFor(kobai, 2 * SESSION_EXTENSION_INTERVAL_MS);

    const remaining = (await currentDeadline(kobai, merchant)) - Date.now();

    expect(remaining).toBeLessThanOrEqual(remainder);
    expect(remaining).toBeGreaterThan(remainder - SESSION_EXTENSION_INTERVAL_MS);
  });

  it("does not buy a database write with every request", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // Half the extension interval of staleness is not worth an `UPDATE`: two requests in a
    // row find the same deadline, because neither moved it. A session extended on every
    // request would hand back a deadline a few milliseconds newer each time.
    await idleFor(kobai, SESSION_EXTENSION_INTERVAL_MS / 2);
    const first = await currentDeadline(kobai, merchant);
    const second = await currentDeadline(kobai, merchant);

    // Past the interval it is worth one, and the Merchant gets their window back in full.
    await idleFor(kobai, SESSION_EXTENSION_INTERVAL_MS);
    const third = await currentDeadline(kobai, merchant);

    expect(second).toBe(first);
    expect(third).toBeGreaterThan(second);
  });
});

describe("signing out", () => {
  it("invalidates the session on the very next request", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const signOut = await kobai.request("/admin/session", {
      method: "DELETE",
      headers: merchant.headers,
    });
    const afterwards = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(signOut.status).toBe(204);
    expect(afterwards.status).toBe(401);
    await expect(afterwards.json()).resolves.toMatchObject({ reason: "session-unknown" });
  });

  it("is not undone by the request that carries it extending the session", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    // Sign-out is an authenticated request like any other, so the gate in front of it slides
    // the deadline forward before the handler runs — and this session is stale enough that it
    // really does write one. Ending a session has to win against that every time, or "sign
    // out" degrades into "please stop using this", which is the whole reason a Session is a
    // row rather than a signed token.
    await idleFor(kobai, 2 * SESSION_EXTENSION_INTERVAL_MS);

    const signOut = await kobai.request("/admin/session", {
      method: "DELETE",
      headers: merchant.headers,
    });
    const afterwards = await kobai.request("/admin/store", { headers: merchant.headers });

    expect(signOut.status).toBe(204);
    expect(afterwards.status).toBe(401);
    await expect(afterwards.json()).resolves.toMatchObject({ reason: "session-unknown" });
  });

  it("clears the cookie as well as the row, with the attributes it was set with", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const signOut = await kobai.request("/admin/session", {
      method: "DELETE",
      headers: merchant.headers,
    });

    // A browser matches a deletion to a stored cookie by name, domain and path, so a clear
    // that disagreed about `Path` would leave the old cookie sitting there and sign-out would
    // only look like it had worked. Neither names one, and both are set from the same URI —
    // `/admin/session`, which sign-in and sign-out share — so they agree by construction at
    // any mount depth. `session-cookie.test.ts` drives that through a cookie jar.
    const cleared = signOut.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("kobai_session=");
    expect(cleared).not.toContain(merchant.token);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).not.toMatch(/;\s*Path=/i);
  });

  it("ends that session and no other", async () => {
    kobai = await createTestKobai();
    const first = await signInTestMerchant(kobai);
    const second = sessionOf(
      await kobai.request("/admin/session", json({ email: EMAIL, password: PASSWORD })),
    );

    await kobai.request("/admin/session", { method: "DELETE", headers: first.headers });

    const other = await kobai.request("/admin/store", { headers: second.headers });
    expect(other.status).toBe(200);
  });
});

describe("permissions gate the endpoint", () => {
  it("refuses a Role that does not hold the permission, while its session stays valid", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    // A Role holding nothing at all. Roles are rows, so a narrower one is a row — not a
    // different mechanism.
    await kobai.db.execute(
      sql`insert into core_role (name, permissions) values ('bookkeeper', array[]::text[])`,
    );
    await kobai.request(
      "/admin/merchants",
      json(
        { email: "books@example.test", password: PASSWORD, role: "bookkeeper" },
        owner.headers,
      ),
    );
    const { headers } = sessionOf(
      await kobai.request(
        "/admin/session",
        json({ email: "books@example.test", password: PASSWORD }),
      ),
    );

    const store = await kobai.request("/admin/store", { headers });
    const session = await kobai.request("/admin/session", { headers });

    // 403, not 401: they are signed in, and the answer names the permission they lack rather
    // than the resource they asked for. The check happens once, at the endpoint.
    expect(store.status).toBe(403);
    await expect(store.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: PERMISSIONS.storeRead,
    });
    expect(session.status).toBe(200);
  });

  it("refuses the route that adds a colleague to a Role without merchant:write", async () => {
    kobai = await createTestKobai();
    const owner = await signInTestMerchant(kobai);
    await kobai.db.execute(
      sql`insert into core_role (name, permissions) values ('bookkeeper', array[]::text[])`,
    );
    await kobai.request(
      "/admin/merchants",
      json(
        { email: "books@example.test", password: PASSWORD, role: "bookkeeper" },
        owner.headers,
      ),
    );
    const { headers } = sessionOf(
      await kobai.request(
        "/admin/session",
        json({ email: "books@example.test", password: PASSWORD }),
      ),
    );

    const response = await kobai.request(
      "/admin/merchants",
      json({ email: "third@example.test", password: PASSWORD }, headers),
    );

    // `POST /admin/merchants` was the one route that could not carry `requirePermission`,
    // because the *first* Merchant had to be creatable with no session at all; it asked the
    // same question in its handler and `openapi.test.ts` excused it from the gate check on
    // the strength of that. The first Merchant is seeded at boot now (#25), so the route is
    // gated like every other one and the excuse is gone from both places.
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      reason: "permission-denied",
      required: PERMISSIONS.merchantWrite,
    });
  });

  it("gives the seeded owner Role exactly the permissions Core defines", async () => {
    kobai = await createTestKobai();

    const roles = await kobai.database.query<{ name: string; permissions: string[] }>(
      "select name, permissions from core_role order by name",
    );

    // The migration that seeds this Role and `ALL_PERMISSIONS` are two lists of the same
    // thing; this is what stops them drifting apart.
    expect(roles).toEqual([{ name: "owner", permissions: [...ALL_PERMISSIONS] }]);
  });
});

describe("credentials are never stored recoverably", () => {
  it("keeps no copy of the password anywhere in the Merchant's row", async () => {
    kobai = await createTestKobai();
    await signInTestMerchant(kobai, { email: EMAIL, password: PASSWORD });

    const [row] = await kobai.database.query<{ merchant: string }>(
      "select to_jsonb(core_merchant)::text as merchant from core_merchant",
    );

    expect(row?.merchant).not.toContain(PASSWORD);
    // An argon2id digest: salted, deliberately slow, and not a reversible encoding of
    // anything. A stolen row is not a stolen credential.
    expect(row?.merchant).toContain("$argon2id$");
  });

  it("stores a session token only as a hash of itself", async () => {
    kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);

    const [row] = await kobai.database.query<{ session: string }>(
      "select to_jsonb(core_session)::text as session from core_session",
    );

    // Read access to `core_session` hands an attacker nothing to present.
    expect(row?.session).not.toContain(merchant.token);
  });
});

describe("there is no Shopper here", () => {
  it("has no account, credential or session table for anyone but a Merchant", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    const tables = await schema.tables();
    const columns = (
      await Promise.all(tables.map(async (table) => await schema.columnsOf(table)))
    ).flat();
    const names = [
      ...tables.map((table) => table.name),
      ...columns.map((column) => column.name),
    ];

    // Core stores no Shopper credential (ADR-0020), and a single `user` table serving both
    // audiences is the specific mistake this guards against — it would put a Shopper's
    // password in Core's care by accident.
    for (const banned of ["shopper", "customer", "user", "account"]) {
      expect(names.filter((name) => name.includes(banned))).toEqual([]);
    }
  });

  it("keeps auth off the Store, so it can never become a scoping key", async () => {
    kobai = await createTestKobai();
    const schema = inspectSchema(kobai.database);

    // ADR-0005: one deployment is one Store. A Merchant, a Role or a session that pointed at
    // it would make it a scoping key, which is multi-tenancy arriving by the back door.
    const referencing = (await schema.foreignKeys()).filter(
      (key) => key.to.name === "core_store",
    );
    expect(referencing).toEqual([]);

    for (const table of ["core_merchant", "core_role", "core_session"]) {
      const columns = (await schema.columnsOf(table)).map((column) => column.name);
      expect(columns.filter((name) => name.includes("store"))).toEqual([]);
    }
  });
});

/**
 * Winds every session's clock past its expiry — the one thing a test cannot do by waiting.
 *
 * The row is edited rather than a clock injected, so what is under test is the real expiry
 * path a Merchant hits twelve hours after signing in.
 */
async function expire(harness: TestKobai): Promise<void> {
  await harness.db.execute(
    sql`update core_session set expires_at = now() - interval '1 second'`,
  );
}

/**
 * Passes time with nobody clicking anything — the other thing a test cannot do by waiting.
 *
 * The deadline in the row was written by the last request, so a session that has been idle for
 * half an hour is a row whose `expires_at` sits half an hour earlier than the one the last
 * request set. Winding the column back is therefore the same arrangement as letting the clock
 * run forward, and it is the only one available: the idle window is measured in minutes and a
 * test suite is not allowed to take them.
 *
 * `created_at` is left alone deliberately: it anchors a different clock.
 */
async function idleFor(harness: TestKobai, milliseconds: number): Promise<void> {
  await harness.db.execute(
    sql`update core_session
        set expires_at = expires_at - make_interval(secs => ${milliseconds / 1000})`,
  );
}

/**
 * Moves sign-in itself into the past, leaving the idle deadline where it is.
 *
 * The absolute cap is measured from `created_at`, so this is how a test reaches a session that
 * has been *used continuously* for hours — the only kind the cap is about, and one no amount
 * of idling can produce.
 */
async function signedInAgo(harness: TestKobai, milliseconds: number): Promise<void> {
  await harness.db.execute(
    sql`update core_session
        set created_at = now() - make_interval(secs => ${milliseconds / 1000})`,
  );
}

/**
 * When the session behind these headers is currently due to end, as the Merchant is told it.
 *
 * Read through `GET /admin/session`, which is what the Admin asks after a page load — so what
 * this observes is the deadline a client can actually see, not a column. It is an ordinary
 * authenticated request and therefore extends the session like any other, which is exactly
 * what makes it the right instrument for asking whether a request extends anything.
 */
async function currentDeadline(
  harness: TestKobai,
  merchant: { readonly headers: { readonly cookie: string } },
): Promise<number> {
  const response = await harness.request("/admin/session", { headers: merchant.headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { expiresAt: string };
  return Date.parse(body.expiresAt);
}
