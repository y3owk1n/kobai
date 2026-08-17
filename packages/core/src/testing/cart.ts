import type { Kobai } from "../kobai.ts";
import type { TestApiKey } from "./api-key.ts";
import { seedTestCatalog, type TestCatalog } from "./catalog.ts";
import { expectStatus } from "./expect-status.ts";

/**
 * What a test asks for: one line of the Cart.
 *
 * `sku` names a Variant of the catalog behind the Cart, and defaults to the first one — so a
 * test with one Variant never has to say which.
 */
export type TestCartLineSpec = {
  readonly sku?: string;
  /** Defaults to 1, which is what a Shopper who clicked once has. */
  readonly quantity?: number;
};

/**
 * The Cart to seed.
 *
 * `quantity` is the one-line shorthand and `lines` is the general form; naming both is a type
 * error rather than a precedence rule nobody would remember, exactly as `seedTestCatalog`'s
 * `prices` and `variants` are.
 */
export type TestCartOptions = {
  /**
   * Something to sell, already seeded.
   *
   * Handed over when a test has arranged its own catalog — several Variants, an unpriced one,
   * particular amounts — or when it holds the deployment's one Merchant already. Left out, the
   * helper seeds the default catalog: one Product, one `POSTER-A2`, one Price of 1250.
   */
  readonly catalog?: TestCatalog;
  /**
   * The key to build the Cart with. Defaults to the catalog's, which is secret.
   *
   * A test whose subject is the *kind* of key should name the one it means — attaching a
   * Shopper needs a secret key and everything else here does not (ADR-0020) — because leaning
   * on the default would hide the point.
   */
  readonly apiKey?: TestApiKey;
  /**
   * Who the Cart is for, asserted the way a storefront does. Needs a secret key.
   *
   * Left out, the Cart is a guest's, which is the ordinary path and what Core assumes
   * everywhere.
   */
  readonly shopper?: { readonly email: string; readonly externalId?: string };
} & (
  | { readonly quantity?: number; readonly lines?: never }
  | { readonly lines?: readonly TestCartLineSpec[]; readonly quantity?: never }
);

export type TestCartLineItem = {
  readonly id: string;
  readonly variantId: string;
  readonly sku: string;
  readonly quantity: number;
};

export type TestCart = {
  /** The Cart's identifier, and the whole of the authority to act on it (ADR-0020). */
  readonly id: string;
  /** What is in the Store behind this Cart — its Merchant and its API key included. */
  readonly catalog: TestCatalog;
  /** The key the Cart was built with, and the one a test should keep using on it. */
  readonly apiKey: TestApiKey;
  /** In the order they were added, which is the order the API reports them. */
  readonly lineItems: readonly TestCartLineItem[];
  /** The line for this SKU, or a failure naming the ones there are. */
  lineItem(sku: string): TestCartLineItem;
};

/**
 * A Cart with something in it, built through the store surface a storefront actually calls.
 *
 * Every ticket in the commerce spine past this one starts from a Cart, and building one by
 * hand is a catalog, a key, a `POST /store/carts` and a `POST …/line-items` in front of the
 * assertion that matters:
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const cart = await seedTestCart(kobai);
 *
 * const response = await kobai.request(`/store/carts/${cart.id}`, {
 *   headers: cart.apiKey.headers,
 * });
 * ```
 *
 * That is the default catalog — one Product `A poster`, one Variant `POSTER-A2`, one Price of
 * `1250` — and a Cart carrying one of it, for a guest, over a secret key.
 *
 * The interesting cases stay expressible, because a helper must hide the arrangement a test
 * does not care about and never the thing the test is about:
 *
 * ```ts
 * await seedTestCart(kobai, { quantity: 3 });            // three of the one Variant
 * await seedTestCart(kobai, { lines: [] });              // an empty Cart
 * await seedTestCart(kobai, { catalog });                // a catalog already seeded
 * await seedTestCart(kobai, {                            // several Variants, named by SKU
 *   catalog,
 *   lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
 * });
 * await seedTestCart(kobai, { shopper: { email: "…" } }); // not a guest's (ADR-0020)
 * ```
 *
 * Everything goes through the public API, like every other helper here — so a test can never
 * prove a capability the API does not have, and a Plugin's test is doing exactly what a
 * Plugin can do. What it does *internally* is promised to nobody; what it returns is.
 */
export async function seedTestCart(
  kobai: Kobai,
  options?: TestCartOptions,
): Promise<TestCart> {
  const catalog = options?.catalog ?? (await seedTestCatalog(kobai));
  const apiKey = options?.apiKey ?? catalog.apiKey;
  const json = { ...apiKey.headers, "content-type": "application/json" };

  const created = (await expectStatus(
    await kobai.request("/store/carts", {
      method: "POST",
      headers: json,
      body: JSON.stringify(options?.shopper ? { shopper: options.shopper } : {}),
    }),
    201,
    "starting a Cart",
  )) as { id: string };

  const asked = options?.lines ?? [{ quantity: options?.quantity }];

  let lineItems: readonly TestCartLineItem[] = [];
  // In series rather than in parallel: adding a line answers with the whole Cart, and the
  // order the lines arrive in is the order the Cart then reports them.
  for (const line of asked) {
    const sku = line.sku ?? catalog.variants[0]?.sku;
    if (sku === undefined) {
      throw new Error("unreachable: a seeded catalog has at least one Variant");
    }

    const cart = (await expectStatus(
      await kobai.request(`/store/carts/${created.id}/line-items`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          variantId: catalog.variant(sku).id,
          quantity: line.quantity,
        }),
      }),
      200,
      `adding ${sku} to the Cart`,
    )) as { lineItems: readonly LineItemBody[] };

    // Read off the answer rather than assembled here, so what the helper reports is what the
    // API says — including the ids, which are the API's to mint.
    lineItems = cart.lineItems.map((item) => ({
      id: item.id,
      variantId: item.variant.id,
      sku: item.variant.sku,
      quantity: item.quantity,
    }));
  }

  return {
    id: created.id,
    catalog,
    apiKey,
    lineItems,
    lineItem: (sku) => {
      const found = lineItems.find((candidate) => candidate.sku === sku);
      if (found === undefined) {
        throw new Error(
          `this Cart carries no line for ${sku}: ${lineItems.map((candidate) => candidate.sku).join(", ") || "it is empty"}`,
        );
      }
      return found;
    },
  };
}

/** One line as the store surface reports it — the shape this helper reads and re-reports. */
type LineItemBody = {
  readonly id: string;
  readonly variant: { readonly id: string; readonly sku: string };
  readonly quantity: number;
};
