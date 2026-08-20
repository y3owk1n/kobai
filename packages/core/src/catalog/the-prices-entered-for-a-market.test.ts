import { describe, expect, it } from "vitest";
import {
  createTestKobai,
  seedTestCatalog,
  type TestCatalog,
  type TestKobai,
} from "../testing/index.ts";

/**
 * **The Prices entered for a Region, and the ones entered for a Channel** — `GET /admin/prices`
 * (#310).
 *
 * A Merchant opening a market asks a question no route could answer: `GET /admin/products/{id}`
 * answers *this Product's* Prices and nothing answered *this Region's*. So the Prices a Store
 * holds are a list of their own, narrowed by the two things a Price may be constrained to and
 * paged like every other list (ADR-0064).
 *
 * **The file is named for what it asserts.** A Merchant's question is *which Prices apply to
 * Malaysia* and this list answers *which Prices were entered for Malaysia*, which is a narrower
 * thing: `?region=` narrows to the Prices that **name** that Region, deliberately not to the ones
 * that would apply there. The second is what `resolve-price` answers — best match, inside the
 * currency rule, in a Workflow a Project may have replaced (ADR-0017) — so a list that claimed
 * to answer it would be a second implementation of pricing living in a `where` clause, wrong on
 * the first deployment that replaced `select-price`. What this list answers is a fact about the
 * rows: which of them were entered for Malaysia. `GET /store/variants/{id}/price?region=` is
 * still the only thing that says what a Shopper there is charged, and
 * `pricing/a-price-in-a-region.test.ts` is where that is asserted.
 *
 * **The last two cases are the ones ADR-0059 rests on.** `core_price.region_id` cascades rather
 * than refusing, and #292 argued that on there being no route that lists the rows a refusal
 * would name. There is one now, so the cascade is argued instead on the repair being the same
 * deletion either way — and what changed is that a Merchant can see the cost *before* the act
 * rather than being refused after it. Both halves are asserted here rather than left as prose.
 */

/** A Region this Store sells into, selecting a currency it has enabled. */
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

/** A route to market this Store sells through. */
async function createChannel(
  kobai: TestKobai,
  catalog: TestCatalog,
  name: string,
): Promise<string> {
  const response = await kobai.request("/admin/channels", {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  expect(response.status, `creating ${name}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** One Price on a Variant, however it is constrained. */
async function setPrice(
  kobai: TestKobai,
  catalog: TestCatalog,
  variantId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await kobai.request(`/admin/variants/${variantId}/prices`, {
    method: "POST",
    headers: { ...catalog.merchant.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status, `pricing ${variantId} at ${JSON.stringify(body)}`).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * A page of the Prices list, read as a Merchant reads it.
 *
 * Deliberately not called `listPrices`: that is the reader this route is built on, and a local
 * helper wearing its name would read like a unit test of it rather than a request.
 */
async function readPrices(
  kobai: TestKobai,
  catalog: TestCatalog,
  query = "",
): Promise<{
  readonly status: number;
  readonly prices: readonly {
    readonly id: string;
    readonly amount: number;
    readonly variant: { readonly id: string; readonly sku: string };
    readonly region: { readonly name: string } | null;
    readonly channel: { readonly name: string } | null;
  }[];
  readonly nextCursor?: string;
}> {
  const response = await kobai.request(`/admin/prices${query}`, {
    headers: catalog.merchant.headers,
  });
  const body = (await response.json()) as Record<string, unknown>;
  return {
    status: response.status,
    prices: (body.prices ?? []) as never,
    nextCursor: body.nextCursor as string | undefined,
  };
}

describe("the Prices a Store holds", () => {
  it("answers all of them, newest first, each naming the Variant it prices", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, {
      variants: [
        { sku: "POSTER-A2", prices: [] },
        { sku: "MUG", prices: [] },
      ],
    });
    const mug = catalog.variant("MUG").id;

    // One at a time, so `created_at` orders them and the page below is predictable.
    const first = await setPrice(kobai, catalog, catalog.variantId, { amount: 1250 });
    const second = await setPrice(kobai, catalog, mug, { amount: 900 });

    const page = await readPrices(kobai, catalog);

    expect(page.status).toBe(200);
    // **Across Variants**, which is the whole of what this list adds: a Merchant reading
    // `GET /admin/products/{id}` is answered about one Product at a time.
    expect(page.prices.map((one) => one.id)).toEqual([second, first]);
    // The SKU travels with the identifier for `VariantIdentity`'s reason — the id names the row
    // and the SKU is what a Merchant recognises.
    expect(page.prices.map((one) => one.variant.sku)).toEqual(["MUG", "POSTER-A2"]);
    // Unconstrained is `null` at both ends, which means *applies to all* and never *to none*.
    expect(page.prices.every((one) => one.region === null && one.channel === null)).toBe(
      true,
    );
  });

  it("narrows to the Prices entered for one Region, and leaves out the ones entered for everywhere", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const midwest = await createRegion(kobai, catalog, "The Midwest");

    const everywhere = await setPrice(kobai, catalog, catalog.variantId, {
      amount: 1250,
    });
    const there = await setPrice(kobai, catalog, catalog.variantId, {
      amount: 1900,
      regionId: midwest,
    });

    const narrowed = await readPrices(kobai, catalog, `?region=${midwest}`);

    // **The rows that name it**, and not the fallback that would also apply there. The second
    // question is `resolve-price`'s and is answered by running it, because a Project may have
    // replaced the Step that decides.
    expect(narrowed.prices.map((one) => one.id)).toEqual([there]);
    expect(narrowed.prices[0]?.region?.name).toBe("The Midwest");

    // And the unconstrained one is still in the Store: absent means unfiltered, so the whole
    // list holds both. A Price left out of a narrowed page has not gone anywhere.
    const whole = await readPrices(kobai, catalog);
    expect(whole.prices.map((one) => one.id)).toEqual([there, everywhere]);
  });

  it("narrows by Channel the same way, and the two compose", async () => {
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const midwest = await createRegion(kobai, catalog, "The Midwest");
    const marketplace = await createChannel(kobai, catalog, "Marketplace");

    await setPrice(kobai, catalog, catalog.variantId, { amount: 1250 });
    const inThatChannel = await setPrice(kobai, catalog, catalog.variantId, {
      amount: 1100,
      channelId: marketplace,
    });
    const inBoth = await setPrice(kobai, catalog, catalog.variantId, {
      amount: 1900,
      regionId: midwest,
      channelId: marketplace,
    });

    // One filter each: a Channel's Prices are the two that name it, newest first.
    const byChannel = await readPrices(kobai, catalog, `?channel=${marketplace}`);
    expect(byChannel.prices.map((one) => one.id)).toEqual([inBoth, inThatChannel]);

    // **And both together**, which is the question neither a Region's list nor a Channel's can
    // answer alone — two `undefined`-droppable predicates in one `and` rather than a branch.
    const byBoth = await readPrices(
      kobai,
      catalog,
      `?region=${midwest}&channel=${marketplace}`,
    );
    expect(byBoth.prices.map((one) => one.id)).toEqual([inBoth]);
    expect(byBoth.prices[0]?.channel?.name).toBe("Marketplace");
  });

  it("gives every Price it names an address the Merchant can delete it by", async () => {
    // **This is ADR-0059's test, made into an assertion.** The repair a refusal names has to be
    // a control a Merchant has, and `DELETE /admin/variants/{id}/prices/{priceId}` needs *both*
    // identifiers — which is exactly why a Price used to be unreachable from anywhere but the
    // Product it hangs under. Each row of this list carries both.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const midwest = await createRegion(kobai, catalog, "The Midwest");
    await setPrice(kobai, catalog, catalog.variantId, {
      amount: 1900,
      regionId: midwest,
    });

    const found = await readPrices(kobai, catalog, `?region=${midwest}`);
    const price = found.prices[0];
    if (!price) throw new Error("the Region's Price was not listed");

    const removed = await kobai.request(
      `/admin/variants/${price.variant.id}/prices/${price.id}`,
      { method: "DELETE", headers: catalog.merchant.headers },
    );

    expect(removed.status).toBe(204);
    await expect(readPrices(kobai, catalog, `?region=${midwest}`)).resolves.toMatchObject(
      { prices: [] },
    );
  });

  it("is what a Merchant reads before deleting the Region that would take them", async () => {
    // The cascade restated (#292, #310): deleting a Region still takes the Prices constrained
    // to it, and what has changed is that the cost is legible first. A Merchant asks this list,
    // sees the two rows, and deletes knowingly — rather than being refused afterwards and told
    // to find rows nothing could list.
    await using kobai = await createTestKobai();
    const catalog = await seedTestCatalog(kobai, { prices: [] });
    const midwest = await createRegion(kobai, catalog, "The Midwest");
    await setPrice(kobai, catalog, catalog.variantId, { amount: 1250 });
    await setPrice(kobai, catalog, catalog.variantId, {
      amount: 1900,
      regionId: midwest,
    });

    const before = await readPrices(kobai, catalog, `?region=${midwest}`);
    expect(before.prices.map((one) => one.amount)).toEqual([1900]);

    const deleted = await kobai.request(`/admin/regions/${midwest}`, {
      method: "DELETE",
      headers: catalog.merchant.headers,
    });
    expect(deleted.status).toBe(204);

    // Gone with the Region, and the Price that applies everywhere is untouched — the constraint
    // was deleted rather than the Variant emptied.
    const after = await readPrices(kobai, catalog);
    expect(after.prices.map((one) => one.amount)).toEqual([1250]);
  });
});
