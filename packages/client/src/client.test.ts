import {
  createTestKobai,
  seedTestCatalog,
  seedTestMerchant,
  signInTestMerchant,
  type TestKobai,
} from "@kobai/core/testing";
import { describe, expect, it } from "vitest";
import { createKobaiClient, type KobaiClient, type SessionRefusal } from "./index.ts";

/**
 * The generated client, driven against a real kobai.
 *
 * Two kinds of test live here and they prove different things.
 *
 * The **runtime** ones dispatch through the client at a booted application on a real
 * Postgres, and assert on what comes back. They prove the generated paths, parameters and
 * bodies are the ones the server actually serves — a client whose types were beautiful and
 * whose URLs were wrong would pass a type check and fail here.
 *
 * The **compile-time** ones assert the opposite direction, and they are the reason this
 * package exists. A client that typed every response `unknown` would pass every runtime
 * test above and deliver none of ADR-0006's promise, so the tests that matter are the ones
 * that must *fail to compile*. They are written as `@ts-expect-error`, which TypeScript
 * reports as an error when the line below it turns out to be fine — so a client that
 * stopped being typed fails `pnpm -r typecheck`, which is the gate's third step. They are
 * in this file rather than a `.d.ts` beside it because they are assertions about the same
 * calls the runtime tests make, and separating them would let one drift from the other.
 */

/** A client pointed at an in-process kobai — no port, no listener, no process. */
function clientFor(
  instance: TestKobai,
  credential?: Parameters<typeof createKobaiClient>[0]["credential"],
): KobaiClient {
  return createKobaiClient({
    baseUrl: "http://kobai.test",
    ...(credential ? { credential } : {}),
    fetch: instance.fetch,
  });
}

/**
 * A client that carries a Merchant's session cookie, which is what a browser does for free.
 *
 * The client does not model the session and should not (ADR-0032): on the same origin a
 * browser attaches the cookie itself. A test has no browser, so it plays one — three lines,
 * and honest about being three lines, rather than a cookie option nobody would use in
 * production.
 */
function adminClientFor(instance: TestKobai, cookie: string): KobaiClient {
  const client = clientFor(instance);
  client.use({
    onRequest: ({ request }) => {
      request.headers.set("cookie", cookie);
      return request;
    },
  });
  return client;
}

describe("consuming kobai through the generated client", () => {
  it("resolves a price on the store surface, and reads the Steps that ran", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      // Named rather than defaulted: the assertions below read the SKU and the amount back,
      // so both belong to this test rather than to the helper.
      variants: [{ sku: "POSTER-A2", prices: [1250] }],
    });

    const client = clientFor(kobai, { apiKey: catalog.apiKey.key });
    const { data, error } = await client.GET("/store/variants/{id}/price", {
      params: { path: { id: catalog.variantId } },
    });

    expect(error).toBeUndefined();
    expect(data?.price.amount).toBe(1250);
    expect(data?.price.currency).toBe("USD");
    expect(data?.variant.sku).toBe("POSTER-A2");
    // `implementation` is a field of its own, not an echo of `step`: it is what differs
    // when a Project has replaced a Step, which is how that replacement is demonstrable.
    expect(data?.workflow.steps.map((ran) => ran.step)).toEqual([
      "load-prices",
      "select-price",
    ]);
  });

  it("reads the catalog on the admin surface", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { title: "A poster", prices: [1250] });
    const admin = adminClientFor(kobai, catalog.merchant.headers.cookie);

    const listed = await admin.GET("/admin/products");
    const detail = await admin.GET("/admin/products/{id}", {
      params: { path: { id: listed.data?.products[0]?.id ?? "" } },
    });

    expect(listed.data?.products.map((product) => product.title)).toEqual(["A poster"]);
    expect(detail.data?.variants[0]?.prices[0]?.amount).toBe(1250);
  });

  it("writes the catalog on the admin surface, through the paths it generated", async () => {
    // The arrangement every other test here takes from `seedTestCatalog` — done through the
    // client instead, because a generated write path is exactly as easy to get wrong as a
    // read one and nothing else in this suite dispatches one at runtime.
    await using kobai = await createTestKobai();
    const merchant = await signInTestMerchant(kobai);
    const admin = adminClientFor(kobai, merchant.headers.cookie);

    const product = await admin.POST("/admin/products", {
      body: { title: "A mug", variants: [{ sku: "MUG-11OZ" }] },
    });
    const setPrice = await admin.POST("/admin/variants/{id}/prices", {
      params: { path: { id: product.data?.variants[0]?.id ?? "" } },
      body: { amount: 899 },
    });

    expect(product.error).toBeUndefined();
    expect(product.data?.variants.map((variant) => variant.sku)).toEqual(["MUG-11OZ"]);
    expect(setPrice.data?.amount).toBe(899);
    expect(setPrice.data?.currency).toBe("USD");
  });

  it("carries the credential each surface asks for, and neither opens the other", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    // The client attaches whichever credential it was given; the server decides. A key at
    // `/admin` is not a session, and a session at `/store` is not a key (ADR-0020).
    const withKey = clientFor(kobai, { apiKey: catalog.apiKey.key });
    const withSession = adminClientFor(kobai, catalog.merchant.headers.cookie);

    const adminWithKey = await withKey.GET("/admin/store");
    const storeWithSession = await withSession.GET("/store/variants/{id}/price", {
      params: { path: { id: catalog.variantId } },
    });

    expect(adminWithKey.response.status).toBe(401);
    expect(storeWithSession.response.status).toBe(401);
    // The two refusals are not symmetrical, and the description says so. A key sent at
    // `/admin` arrives in a header that surface stopped reading when the session moved into
    // a cookie (ADR-0032), so it is no session at all rather than an unrecognised one. A
    // session sent at `/store` is a cookie that gate never looks at — and a browser would
    // not even send it there, because the cookie is scoped to the admin surface.
    expect(reasonOf(adminWithKey.error)).toBe("session-missing");
    expect(reasonOf(storeWithSession.error)).toBe("api-key-missing");
  });

  it("hands back a refusal in the shape the description promised", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai);

    const client = clientFor(kobai, { apiKey: catalog.apiKey.key });
    const { data, error, response } = await client.GET("/store/variants/{id}/price", {
      params: { path: { id: "00000000-0000-4000-8000-000000000000" } },
    });

    expect(data).toBeUndefined();
    expect(response.status).toBe(404);
    // `error` is the union of every refusal this route declares, so reading `workflow` off
    // it means narrowing first — a 500 says nothing but `error`, and the types insist you
    // notice. That insistence is the deliverable.
    if (error === undefined || !("workflow" in error)) {
      throw new Error(`expected a refused resolution, got ${JSON.stringify(error)}`);
    }
    expect(error.reason).toBe("variant-not-found");
    expect(error.workflow.failed).toBe("load-prices");
  });

  it("needs no credential for the one route that cannot require one", async () => {
    await using kobai = await createTestKobai();
    const credentials = {
      email: "first@example.test",
      password: "a merchant's very long password",
    };
    // The first Merchant is seeded at boot and not created over HTTP (#25), so signing in is
    // the only thing this client can do before it holds anything.
    await seedTestMerchant(kobai, credentials);
    const anonymous = clientFor(kobai);

    const signedIn = await anonymous.POST("/admin/session", { body: credentials });

    expect(signedIn.data?.role.permissions).toContain("catalog:write");
    // The credential came back in a header a browser acts on and this client never reads.
    expect(signedIn.response.headers.get("set-cookie")).toContain("kobai_session=");
  });

  it("cannot create a Merchant without one, whatever the deployment holds", async () => {
    await using kobai = await createTestKobai();
    const anonymous = clientFor(kobai);

    const created = await anonymous.POST("/admin/merchants", {
      body: { email: "first@example.test", password: "a merchant's very long password" },
    });

    // Generated from a description in which this route names the session scheme like every
    // other admin route — the anonymous call it used to describe is gone from both.
    expect(created.data).toBeUndefined();
    expect(created.response.status).toBe(401);
    expect(reasonOf(created.error)).toBe("session-missing");
  });

  it("is closed by default, and says which gate turned the caller back", async () => {
    await using kobai = await createTestKobai();
    const anonymous = clientFor(kobai);

    const admin = await anonymous.GET("/admin/store");
    const store = await anonymous.GET("/store/variants/{id}/price", {
      params: { path: { id: "irrelevant" } },
    });

    expect(reasonOf(admin.error)).toBe("session-missing");
    expect(reasonOf(store.error)).toBe("api-key-missing");
    // RFC 6750, and part of the description rather than only of the prose: the store 401
    // declares this header, so it has to send it. The admin 401 declares none and sends
    // none — it is opened by a cookie now, and a challenge naming `Bearer` would be an
    // instruction no client could act on (ADR-0032).
    expect(store.response.headers.get("www-authenticate")).toBe("Bearer");
    expect(admin.response.headers.get("www-authenticate")).toBeNull();
  });
});

/**
 * The `reason` on a refusal, once it has been narrowed to one that has one.
 *
 * Every refusal kobai makes carries `reason` except a 500, which deliberately says nothing
 * — so the client hands back a union and makes the caller notice. `in` is a real narrowing
 * and not a cast: it selects the members of that union that declare the field.
 */
function reasonOf(error: { readonly error: string } | undefined): unknown {
  return error !== undefined && "reason" in error ? error.reason : undefined;
}

/**
 * What the client refuses to compile.
 *
 * These are checked by `pnpm -r typecheck`, which includes this file. Nothing here needs to
 * run — an `@ts-expect-error` that stops being an error is reported by `tsc`, so the
 * assertion is made whether or not the body executes. They are wrapped in `it` blocks
 * anyway so that a reader browsing the suite sees what is guaranteed.
 */
describe("what the generated types refuse", () => {
  /**
   * A client nothing calls.
   *
   * Every call below is one the compiler has already refused, so none of them is meant to
   * be dispatched — each sits inside a function that is never invoked, and the assertion is
   * that the function *compiles*, which it does not.
   */
  const client = createKobaiClient({ baseUrl: "http://kobai.test" });

  it("rejects a field the response does not have", () => {
    const read = async () => {
      const { data } = await client.GET("/store/variants/{id}/price", {
        params: { path: { id: "some-variant" } },
      });

      // The whole ticket in one line. `amount` lives on `price`, and a client that answered
      // `any` here would pass every runtime test above and deliver none of the guarantee.
      // @ts-expect-error `ResolvedPrice` has no `amount` of its own.
      return data?.amount;
    };

    expect(read).toBeDefined();
  });

  it("rejects a field the description does not carry on a nested object", () => {
    const read = async () => {
      const { data } = await client.GET("/admin/products/{id}", {
        params: { path: { id: "some-product" } },
      });

      // Deep, not just top-level: a Variant carries `sku`, and never a `price` — a
      // Variant's Prices are a list, because a Price is a row (ADR-0008).
      // @ts-expect-error `Variant` has `prices`, not `price`.
      return data?.variants[0]?.price;
    };

    expect(read).toBeDefined();
  });

  it("rejects a request body of the wrong shape", () => {
    const write = async () =>
      client.POST("/admin/products", {
        // `variants` is required and `title` is a string. A body that gets either wrong is
        // one the server answers 400 to, and the point of generating the client is that it
        // never gets that far.
        // @ts-expect-error `title` is a string and `variants` is not optional.
        body: { title: 42 },
      });

    expect(write).toBeDefined();
  });

  it("rejects a request body whose nested shape is wrong", () => {
    const write = async () =>
      client.POST("/admin/products", {
        // @ts-expect-error a Variant is created with a `sku`, not a `name`.
        body: { title: "A poster", variants: [{ name: "POSTER-A2" }] },
      });

    expect(write).toBeDefined();
  });

  it("rejects a path that is not on the surface", () => {
    // `/store/products` used to be the example here, and it stopped being one the day the
    // store surface grew a catalog — which is what this assertion is for rather than against.
    // The check is that the generated types refuse a path kobai does not serve, so it is
    // repointed at one kobai has *decided* not to serve: the description itself. `/store`
    // refuses an unauthenticated request before saying whether a path exists, and an endpoint
    // handing out the whole surface anonymously would undo that, so this one will not arrive
    // later the way a catalog route did (ADR-0040).
    // @ts-expect-error there is no such route, so there is no such call.
    const read = async () => client.GET("/openapi.json");

    expect(read).toBeDefined();
  });

  it("rejects a method the path does not answer", () => {
    // `/store/variants/{id}/price` is a read. A storefront cannot set one.
    const write = async () =>
      // @ts-expect-error the store surface serves no `POST` here.
      client.POST("/store/variants/{id}/price", {
        params: { path: { id: "some-variant" } },
      });

    expect(write).toBeDefined();
  });

  it("rejects a missing path parameter", () => {
    // @ts-expect-error `{id}` has to be supplied.
    const read = async () => client.GET("/admin/products/{id}", {});

    expect(read).toBeDefined();
  });

  it("does not model a session credential, because a cookie is not the caller's to carry", () => {
    const build = () =>
      createKobaiClient({
        baseUrl: "http://kobai.test",
        // The session is an httpOnly cookie the browser sends by itself (ADR-0032). An
        // option for it here would be one no caller could fill: nothing outside the browser
        // ever holds the value.
        // @ts-expect-error `KobaiCredential` is the API key, and only the API key.
        credential: { session: "a session token" },
      });

    expect(build).toBeDefined();
  });

  it("does not carry a session token on the sign-in response, because no response does", () => {
    const signIn = async () => {
      const { data } = await client.POST("/admin/session", {
        body: {
          email: "first@example.test",
          password: "a merchant's very long password",
        },
      });

      // The finding that decided ADR-0032: while `token` was a published field, anything
      // logging a response body logged a live credential. It is not a field any more, and
      // this line is what fails the build if it ever comes back.
      // @ts-expect-error a `Session` carries no token; it travels in the cookie.
      return data?.token;
    };

    expect(signIn).toBeDefined();
  });

  it("types a refusal too, so `reason` is a union and not a string", () => {
    // Narrowing on `reason` is how a client decides between "sign in" and "ask an owner",
    // and between "your key was revoked" and "you mistyped it". A `string` here would make
    // every one of those branches unverifiable.
    const expired: SessionRefusal["reason"] = "session-expired";

    // @ts-expect-error `api-key-revoked` belongs to the *other* surface's gate.
    const crossed: SessionRefusal["reason"] = "api-key-revoked";

    expect([expired, crossed]).toBeDefined();
  });
});
