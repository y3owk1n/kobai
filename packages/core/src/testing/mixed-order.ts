import type { Kobai } from "../kobai.ts";
import { seedTestCatalog } from "./catalog.ts";
import type { TestSession } from "./merchant.ts";
import { seedTestOrder, type TestOrder } from "./order.ts";

/**
 * **An Order for one physical thing and one digital one** — the arrangement every test about a
 * Fulfilment doing something on its own needs (#320, #321).
 *
 * A poster and a PDF in one Order, so an Order with **two Fulfilments** is one line rather than
 * seven. That is the whole of what it is for, and the reason it is a helper rather than a
 * fixture in one test file: *each Fulfilment moves independently* and *there is no shipping
 * charge on a download* are two different tickets' assertions about the same shape, and asserting
 * them against two conveniently-different Orders would prove neither. A mixed Order is the case
 * that can disagree.
 *
 * ```ts
 * await using kobai = await createTestKobai();
 * const order = await seedTestMixedOrder(kobai);
 *
 * const read = await kobai.request(`/admin/orders/${order.id}`, {
 *   headers: order.catalog.merchant.headers,
 * });
 * ```
 *
 * `POSTER-A2` is `physical` and `PDF` is `digital`, one of each, at `seedTestCatalog`'s own
 * default Price. What comes back is an ordinary {@link TestOrder} — the identifier, the lines by
 * SKU, the Cart it came from and the catalog behind that, so `order.catalog.merchant` is the
 * session for anything on `/admin`. **Ask for a line by SKU**, never by position.
 *
 * **The two Variants are one Product**, because that is what makes them one Cart's worth without
 * a second catalog and a second Merchant — and it changes nothing about the Fulfilments, which
 * are grouped by what the Strategy answered rather than by what the line was a Variant of.
 *
 * Three things it deliberately does not do. It counts **no stock**, so the physical line holds no
 * Reservation — a Variant nobody has counted sells freely (ADR-0018), and a test about stock says
 * so with `PUT /admin/variants/{id}/inventory` in the open. It gives the Cart **no Address**,
 * because nothing about an Address is mandatory (#319) and a test about a destination arranges
 * one where it can be seen. And it takes **no options at all**: a mixed Order is a fact about the
 * Fulfilment Strategies its lines point at, and everything else is `seedTestCatalog`'s and
 * `seedTestOrder`'s to arrange for a test that needs it.
 */
export type TestMixedOrderOptions = {
  /** One already signed in, for a test that has a Merchant (ADR-0041). */
  readonly merchant?: TestSession;
};

/** The SKU of the line that ships — `physical`, so its Fulfilment requires shipping. */
export const MIXED_ORDER_PHYSICAL_SKU = "POSTER-A2";

/** The SKU of the line that is sent rather than shipped — `digital`, so nothing is scarce. */
export const MIXED_ORDER_DIGITAL_SKU = "PDF";

export async function seedTestMixedOrder(
  kobai: Kobai,
  options?: TestMixedOrderOptions,
): Promise<TestOrder> {
  const catalog = await seedTestCatalog(kobai, {
    ...(options?.merchant === undefined ? {} : { merchant: options.merchant }),
    variants: [
      { sku: MIXED_ORDER_PHYSICAL_SKU },
      { sku: MIXED_ORDER_DIGITAL_SKU, fulfilmentStrategy: "digital" },
    ],
  });

  return seedTestOrder(kobai, {
    catalog,
    lines: [{ sku: MIXED_ORDER_PHYSICAL_SKU }, { sku: MIXED_ORDER_DIGITAL_SKU }],
  });
}
