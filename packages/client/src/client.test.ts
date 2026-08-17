import {
  createTestApiKey,
  createTestKobai,
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

/** A Store holding one Variant at one Price, arranged through the client itself. */
async function priced(instance: TestKobai, amount = 1250) {
  const merchant = await signInTestMerchant(instance);
  const admin = clientFor(instance, { session: merchant.token });

  const product = await admin.POST("/admin/products", {
    body: { title: "A poster", variants: [{ sku: "POSTER-A2" }] },
  });
  if (!product.data)
    throw new Error(`creating a Product failed: ${JSON.stringify(product.error)}`);
  const variant = product.data.variants[0];
  if (!variant) throw new Error("a created Product carried no Variant");

  await admin.POST("/admin/variants/{id}/prices", {
    params: { path: { id: variant.id } },
    body: { amount },
  });

  const key = await createTestApiKey(instance, merchant, { name: "storefront" });
  return { admin, merchant, variantId: variant.id, apiKey: key.key };
}

describe("consuming kobai through the generated client", () => {
  it("resolves a price on the store surface, and reads the Steps that ran", async () => {
    await using kobai = await createTestKobai();
    const store = await priced(kobai, 1250);

    const client = clientFor(kobai, { apiKey: store.apiKey });
    const { data, error } = await client.GET("/store/variants/{id}/price", {
      params: { path: { id: store.variantId } },
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
    const store = await priced(kobai);

    const listed = await store.admin.GET("/admin/products");
    const detail = await store.admin.GET("/admin/products/{id}", {
      params: { path: { id: listed.data?.products[0]?.id ?? "" } },
    });

    expect(listed.data?.products.map((product) => product.title)).toEqual(["A poster"]);
    expect(detail.data?.variants[0]?.prices[0]?.amount).toBe(1250);
  });

  it("carries the credential each surface asks for, and neither opens the other", async () => {
    await using kobai = await createTestKobai();
    const store = await priced(kobai);

    // The client attaches whichever credential it was given; the server decides. A key at
    // `/admin` is not a session, and a session at `/store` is not a key (ADR-0020).
    const withKey = clientFor(kobai, { apiKey: store.apiKey });
    const withSession = clientFor(kobai, { session: store.merchant.token });

    const adminWithKey = await withKey.GET("/admin/store");
    const storeWithSession = await withSession.GET("/store/variants/{id}/price", {
      params: { path: { id: store.variantId } },
    });

    expect(adminWithKey.response.status).toBe(401);
    expect(storeWithSession.response.status).toBe(401);
    // The two refusals are not symmetrical, and the description says so: a key carries a
    // prefix, so the store gate can tell "that is not a kobai key" from "nobody issued
    // that one" without a lookup. A session token carries none, so a key presented at
    // `/admin` is a well-formed bearer token that names no session.
    expect(reasonOf(adminWithKey.error)).toBe("session-unknown");
    expect(reasonOf(storeWithSession.error)).toBe("api-key-malformed");
  });

  it("hands back a refusal in the shape the description promised", async () => {
    await using kobai = await createTestKobai();
    const store = await priced(kobai);

    const client = clientFor(kobai, { apiKey: store.apiKey });
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

  it("needs no credential for the two routes that cannot require one", async () => {
    await using kobai = await createTestKobai();
    const anonymous = clientFor(kobai);

    const created = await anonymous.POST("/admin/merchants", {
      body: { email: "first@example.test", password: "a merchant's very long password" },
    });
    const signedIn = await anonymous.POST("/admin/session", {
      body: { email: "first@example.test", password: "a merchant's very long password" },
    });

    expect(created.data?.email).toBe("first@example.test");
    expect(signedIn.data?.token).toEqual(expect.any(String));
    expect(signedIn.data?.role.permissions).toContain("catalog:write");
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
    // RFC 6750, and part of the description rather than only of the prose: both 401s
    // declare this header, so both have to send it.
    expect(admin.response.headers.get("www-authenticate")).toBe("Bearer");
    expect(store.response.headers.get("www-authenticate")).toBe("Bearer");
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
    // @ts-expect-error there is no such route, so there is no such call.
    const read = async () => client.GET("/store/products");

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
