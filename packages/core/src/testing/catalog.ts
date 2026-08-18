import type { Kobai } from "../kobai.ts";
import { createTestApiKey, type TestApiKey } from "./api-key.ts";
import { expectStatus } from "./expect-status.ts";
import { signInTestMerchant, type TestSession } from "./merchant.ts";

/**
 * What a test asks for: one Variant's Prices, in minor units.
 *
 * `[]` is a Variant with no Price at all — the arrangement a refusal test needs, and one a
 * caller must never have to hand-roll the rest of the Product for.
 */
export type TestVariantSpec = {
  /** Defaults to `POSTER-A2`, `POSTER-A3`, `POSTER-A4` — by position, so two need no names. */
  readonly sku?: string;
  /**
   * The Fulfilment Strategy this Variant points at, **by name**. Defaults to `physical`.
   *
   * Named by a test whose subject is what a Strategy answers — that a `digital` Variant needs
   * no Inventory row, that a Plugin's Strategy is only reachable once the Project wired it. A
   * name this deployment has not wired is refused by the route, and this helper fails saying
   * so, which is the same answer a Merchant would get.
   *
   * Spelled out rather than `fulfilment`, because the request body's `fulfilment` is the object
   * `{ strategy }` and this is the name inside it.
   */
  readonly fulfilmentStrategy?: string;
  /**
   * Minor units, in the Store's default currency. `1250` is USD 12.50.
   *
   * Several, because a Price is a row rather than a column (ADR-0008) — the arrangement a
   * test about price *selection* is actually about. Defaults to one Price of `1250`.
   */
  readonly prices?: readonly number[];
};

/**
 * The Product to seed.
 *
 * `prices` is the one-Variant shorthand and `variants` is the general form; naming both is a
 * type error rather than a precedence rule nobody would remember.
 */
export type TestCatalogOptions = {
  readonly title?: string;
  /**
   * A Merchant who is already signed in.
   *
   * The first Merchant is seeded once per deployment and there is no HTTP way to make
   * another (ADR-0041), so a test that already holds a session hands it over here rather
   * than watching `signInTestMerchant` refuse a second claim.
   */
  readonly merchant?: TestSession;
} & (
  | { readonly prices?: readonly number[]; readonly variants?: never }
  | { readonly variants?: readonly TestVariantSpec[]; readonly prices?: never }
);

export type TestCatalogPrice = {
  readonly id: string;
  readonly amount: number;
  readonly currency: string;
};

export type TestCatalogVariant = {
  readonly id: string;
  readonly sku: string;
  /** In the order they were set, which is the order they were asked for. */
  readonly prices: readonly TestCatalogPrice[];
};

export type TestCatalog = {
  /** Signed in and holding `owner`, for anything the test does on the admin surface. */
  readonly merchant: TestSession;
  /** A secret key, for anything it does on the store surface. */
  readonly apiKey: TestApiKey;
  readonly productId: string;
  /** The first Variant's id — a test with one Variant should not have to say which. */
  readonly variantId: string;
  readonly variants: readonly TestCatalogVariant[];
  /** The Variant with this SKU, or a failure naming the ones there are. */
  variant(sku: string): TestCatalogVariant;
};

const DEFAULT_TITLE = "A poster";

/** USD 12.50, and the amount every test that does not care about the amount gets. */
const DEFAULT_AMOUNT = 1250;

/**
 * A Store with something to sell — a Product, a Variant, a Price — and the credentials to
 * ask about it with.
 *
 * Nearly every test past the first one needs this arrangement before it can resolve,
 * describe or serve anything, so the common case is one line:
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const catalog = await seedTestCatalog(kobai);
 *
 * const price = await kobai.request(`/store/variants/${catalog.variantId}/price`, {
 *   headers: catalog.apiKey.headers,
 * });
 * ```
 *
 * That is one Product titled `A poster`, one Variant `POSTER-A2`, one Price of `1250` in the
 * Store's default currency, a signed-in Merchant and a secret API key. **Amounts are integer
 * minor units** and a Price's currency is the Store's default, which since #5 is the only
 * currency a Price may carry — so the helper never takes one, and the correct thing is the
 * only thing.
 *
 * The interesting cases stay expressible, because a helper must hide the arrangement a test
 * does not care about and never the thing the test is about:
 *
 * ```ts
 * await seedTestCatalog(kobai, { prices: [1250, 900] });  // two Prices on one Variant
 * await seedTestCatalog(kobai, { prices: [] });           // a Variant with no Price
 * await seedTestCatalog(kobai, {                          // several Variants
 *   variants: [{ prices: [1250] }, { sku: "MUG", prices: [] }],
 * });
 * await seedTestCatalog(kobai, { merchant });             // one already signed in
 * ```
 *
 * Everything goes through the public API rather than through the database, like
 * `signInTestMerchant` and `createTestApiKey` — so a test can never prove a capability the
 * API does not actually have, and a Plugin's test is doing exactly what a Plugin can do.
 */
export async function seedTestCatalog(
  kobai: Kobai,
  options?: TestCatalogOptions,
): Promise<TestCatalog> {
  const merchant = options?.merchant ?? (await signInTestMerchant(kobai));
  const json = { ...merchant.headers, "content-type": "application/json" };
  const specs = options?.variants ?? [{ prices: options?.prices }];
  if (specs.length === 0) {
    throw new Error(
      "a Product is never sellable in itself (ADR-0008), so seedTestCatalog needs at least one Variant. For a Variant with no Price, ask for `{ prices: [] }`.",
    );
  }

  const asked = specs.map((spec, index) => ({ ...spec, sku: spec.sku ?? skuFor(index) }));

  const created = (await expectStatus(
    await kobai.request("/admin/products", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: options?.title ?? DEFAULT_TITLE,
        variants: asked.map(({ sku, fulfilmentStrategy }) => ({
          sku,
          // Left out entirely unless a test asked, so what the route does with a Variant that
          // says nothing is exercised by every other test in this repository.
          ...(fulfilmentStrategy === undefined
            ? {}
            : { fulfilment: { strategy: fulfilmentStrategy } }),
        })),
      }),
    }),
    201,
    "creating a Product",
  )) as { id: string; variants: readonly { id: string; sku: string }[] };

  const variants: TestCatalogVariant[] = [];
  // By SKU rather than by position: a Product reports its Variants in SKU order, not in the
  // order they were asked for, so pairing them off by index prices the wrong Variant as soon
  // as a test seeds two.
  for (const spec of asked) {
    const variant = created.variants.find((row) => row.sku === spec.sku);
    if (variant === undefined) {
      throw new Error(
        `creating a Product answered without the Variant ${spec.sku}: ${created.variants.map((row) => row.sku).join(", ")}`,
      );
    }

    const prices: TestCatalogPrice[] = [];
    // In series rather than in parallel: setting a Price is an insert, so the order they
    // arrive in is the order they are in, and a test about the newest one depends on it.
    for (const amount of spec.prices ?? [DEFAULT_AMOUNT]) {
      const price = (await expectStatus(
        await kobai.request(`/admin/variants/${variant.id}/prices`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ amount }),
        }),
        201,
        `pricing ${variant.sku} at ${amount}`,
      )) as TestCatalogPrice;
      prices.push(price);
    }

    variants.push({ id: variant.id, sku: variant.sku, prices });
  }

  // One Variant per spec, and there is at least one spec — so this is the compiler's question
  // rather than a real one, and the answer costs a line.
  const [first] = variants;
  if (first === undefined) throw new Error("unreachable: a seeded catalog has a Variant");

  const apiKey = await createTestApiKey(kobai, merchant, { name: "storefront" });

  return {
    merchant,
    apiKey,
    productId: created.id,
    variantId: first.id,
    variants,
    variant: (sku) => {
      const found = variants.find((candidate) => candidate.sku === sku);
      if (found === undefined) {
        throw new Error(
          `this catalog holds no Variant with SKU ${sku}: ${variants.map((candidate) => candidate.sku).join(", ")}`,
        );
      }
      return found;
    },
  };
}

/** `POSTER-A2`, `POSTER-A3`, `POSTER-A4` — paper sizes, so a second Variant names itself. */
function skuFor(index: number): string {
  return `POSTER-A${index + 2}`;
}
