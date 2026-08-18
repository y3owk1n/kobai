import type { Kobai } from "../kobai.ts";
import type { TestApiKey } from "./api-key.ts";
import { seedTestCart, type TestCart, type TestCartOptions } from "./cart.ts";
import type { TestCatalog } from "./catalog.ts";
import { expectStatus } from "./expect-status.ts";

/**
 * The Order to place.
 *
 * `cart` is a Cart already built and everything beside it shapes the one this helper builds;
 * naming both is a type error rather than a precedence rule nobody would remember, exactly as
 * `seedTestCart`'s `quantity` and `lines` are. Everything in the second branch is
 * `seedTestCart`'s own, passed through untouched — so a Cart this helper builds is the Cart
 * `seedTestCart` would have built.
 */
export type TestOrderOptions =
  | ({
      /**
       * A Cart already built, which this helper places rather than seeding another.
       *
       * How a test that arranged its own Cart — several lines, a Shopper, a browser's key —
       * turns it into an Order without saying any of it twice.
       */
      readonly cart: TestCart;
    } & { [K in keyof TestCartOptions]?: never })
  | (TestCartOptions & { readonly cart?: never });

/** One line of the Order, as Capture snapshotted it (ADR-0009). */
export type TestOrderLineItem = {
  readonly id: string;
  /** For navigation only, and `null` once the Variant is deleted. */
  readonly variantId: string | null;
  readonly sku: string;
  /** Minor units — what one of it cost. */
  readonly unitAmount: number;
  readonly quantity: number;
  /** What the line came to, its Adjustments and its tax accounted for. */
  readonly total: number;
};

export type TestOrder = {
  /** The Order's identifier — what `/store/orders/{id}` and `/admin/orders/{id}` take. */
  readonly id: string;
  /** The Order **number**, which is what a Shopper quotes and is not the identifier. */
  readonly number: number;
  /** The Store's currency, which is the only one an Order can be in. */
  readonly currency: string;
  /** What the Order came to, in minor units of `currency`. */
  readonly total: number;
  /** The Cart it was placed from. */
  readonly cart: TestCart;
  /**
   * What is in the Store behind it, so `order.catalog.merchant` is the session for `/admin`.
   *
   * The same reach `cart.catalog.merchant` is, at the same depth — an Order is read by a
   * Merchant as a matter of course (`/admin/orders`), so the walk to that session should not
   * get longer for having placed one.
   */
  readonly catalog: TestCatalog;
  /** The **secret** key it was placed with, and the one to read it back with (ADR-0055). */
  readonly apiKey: TestApiKey;
  /** In the order the API reports them, which is by SKU. */
  readonly lineItems: readonly TestOrderLineItem[];
  /** The line for this SKU, or a failure naming the ones there are. */
  lineItem(sku: string): TestOrderLineItem;
};

/**
 * A Cart turned into the Order it becomes, over the store surface a storefront actually calls.
 *
 * Everything downstream of Capture — the Admin's view of the books, a Fulfilment, a refund —
 * starts from an Order that exists, and placing one by hand is a catalog, a Cart and a
 * `POST /store/orders` in front of the assertion that matters:
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const order = await seedTestOrder(kobai);
 *
 * const response = await kobai.request(`/admin/orders/${order.id}`, {
 *   headers: order.catalog.merchant.headers,
 * });
 * ```
 *
 * That is the default catalog — one Product `A poster`, one Variant `POSTER-A2`, one Price of
 * `1250` — in a guest's Cart, placed.
 *
 * The interesting cases stay expressible, because a helper must hide the arrangement a test
 * does not care about and never the thing the test is about:
 *
 * ```ts
 * await seedTestOrder(kobai, { quantity: 2 });   // an Order for two of the one Variant
 * await seedTestOrder(kobai, { catalog });       // a catalog already seeded (ADR-0041)
 * await seedTestOrder(kobai, { cart });          // a Cart already built
 * await seedTestOrder(kobai, {                   // several Variants, named by SKU
 *   catalog,
 *   lines: [{ sku: "POSTER-A2" }, { sku: "MUG", quantity: 2 }],
 * });
 * ```
 *
 * **It places with a secret key, always.** The Cart's own if that key can place — so a test
 * that named one is placing with the key it named — and the catalog's when it cannot, because
 * a publishable key is refused here (`403 secret-key-required`, ADR-0055) and is exactly what a
 * browser holds. `seedTestOrder(kobai, { catalog, apiKey: publishable })` is therefore the
 * storefront pattern itself: the browser builds the Cart and the server places it. A test whose
 * subject *is* the gate calls the route itself with the key it means.
 *
 * Three things it deliberately does not do:
 *
 * - **It configures no Payment Provider.** A provider belongs to the deployment rather than to
 *   a Cart (ADR-0053), and `createTestKobai` already wires `testPaymentProvider` unless the
 *   test said otherwise — a helper that wired one would be doing it at a seam that has already
 *   closed by the time it is called. On a deployment that has none, placing is refused with
 *   `no-payment-provider` and this fails saying so, which is the honest answer: that
 *   deployment cannot take an Order, and a test about it is a test about the refusal.
 * - **It sends no `Idempotency-Key`.** A test about a retry is a test about the key, so it
 *   names its own — the same line `seedTestCatalog` draws over a Price.
 * - **It is not what a test whose subject is the placement itself should reach for.** Every
 *   refusal `POST /store/orders` makes is a status this never returns, and the 201 body carries
 *   an account of the Workflow run that this deliberately drops — so `place-order.test.ts`,
 *   `idempotency.test.ts`, `payment.test.ts` and the tests in `order.test.ts` that assert on
 *   what placing *answered* all call the route by hand, for the same reason `cart.test.ts`
 *   builds its Carts by hand.
 *
 * Everything goes through the public API, like every other helper here — so a test can never
 * prove a capability the API does not have, and a Plugin's test is doing exactly what a
 * Plugin can do. What it does *internally* is promised to nobody; what it returns is.
 */
export async function seedTestOrder(
  kobai: Kobai,
  options?: TestOrderOptions,
): Promise<TestOrder> {
  const cart = options?.cart ?? (await seedTestCart(kobai, options));
  // The key that built the Cart, unless it cannot place: a publishable key is refused here
  // (ADR-0055), and that is the storefront pattern rather than a mistake — the browser builds
  // the Cart and the server places it — so the catalog's own secret key takes over. A secret
  // key a test named is never swapped out, because then it could not name the one it meant.
  const apiKey = cart.apiKey.kind === "secret" ? cart.apiKey : cart.catalog.apiKey;

  const placed = (await expectStatus(
    await kobai.request("/store/orders", {
      method: "POST",
      headers: { ...apiKey.headers, "content-type": "application/json" },
      body: JSON.stringify({ cartId: cart.id }),
    }),
    201,
    "placing the Cart",
  )) as OrderBody;

  // Read off the answer rather than assembled here, so what the helper reports is what the API
  // says — including the number, which is the database's to mint.
  const lineItems: readonly TestOrderLineItem[] = placed.lineItems.map((line) => ({
    id: line.id,
    variantId: line.variantId,
    sku: line.sku,
    unitAmount: line.unitAmount,
    quantity: line.quantity,
    total: line.total,
  }));

  return {
    id: placed.id,
    number: placed.number,
    currency: placed.currency,
    total: placed.total,
    cart,
    catalog: cart.catalog,
    apiKey,
    lineItems,
    lineItem: (sku) => {
      const found = lineItems.find((candidate) => candidate.sku === sku);
      if (found === undefined) {
        throw new Error(
          `this Order carries no line for ${sku}: ${lineItems.map((candidate) => candidate.sku).join(", ")}`,
        );
      }
      return found;
    },
  };
}

/** The Order as the store surface reports it — the shape this helper reads and re-reports. */
type OrderBody = {
  readonly id: string;
  readonly number: number;
  readonly currency: string;
  readonly total: number;
  readonly lineItems: readonly {
    readonly id: string;
    readonly variantId: string | null;
    readonly sku: string;
    readonly unitAmount: number;
    readonly quantity: number;
    readonly total: number;
  }[];
};
