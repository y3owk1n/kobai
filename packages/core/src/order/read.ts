import { asc, eq } from "drizzle-orm";
import type { Queryable } from "../db/client.ts";
import { order, orderAdjustment, orderLineItem } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";

/**
 * Reading an Order.
 *
 * One shape, and both routes answer with it: placing an Order hands the whole thing back so a
 * confirmation renders without a second round trip, and reading one later hands back exactly
 * the same bytes so reloading that page needs no client-side cache.
 *
 * **Nothing here joins the catalog.** Every field a person reads was copied onto the row at
 * Capture, which is ADR-0009's whole point — an Order whose rendering joined the catalog would
 * be rewritten by a rename and destroyed by a delete. `variantId` is carried for navigation
 * and is `null` once the Variant is gone; nothing is computed from it.
 */

/**
 * An **Adjustment** as a caller reads it — a discount or a surcharge, on its own line.
 *
 * The `id` is the difference from the `Adjustment` a Step declares: a Step describes one and
 * Capture writes it, so this is the row rather than the intent. Nothing here is computed —
 * `amount` is what the Step said, signed, and the line's `total` beside it is what it came to.
 */
export type OrderAdjustment = {
  readonly id: string;
  /** Machine-readable, and the Step's own — Core defines none of these. */
  readonly code: string;
  readonly description: string;
  /** Signed minor units: negative discounts, positive surcharges. */
  readonly amount: number;
  readonly metadata: Record<string, unknown>;
};

/** One line of an Order: what was bought, as it was described and priced at Capture. */
export type OrderLineItem = {
  readonly id: string;
  /**
   * The Variant this line was for — **for navigation only**, and `null` once it is deleted.
   *
   * Never for display or arithmetic: `title`, `sku` and `unitAmount` beside it are the
   * snapshot, and they are what a Shopper and an accountant read (ADR-0009).
   */
  readonly variantId: string | null;
  readonly title: string;
  readonly sku: string;
  /** Minor units of `currency` — 1250 is USD 12.50. */
  readonly unitAmount: number;
  readonly quantity: number;
  /** Zero until the tax spec replaces `calculate-tax`; present so that adding it is not a change. */
  readonly tax: number;
  /**
   * The discounts and surcharges on **this line**, in the order they were applied.
   *
   * Each is a line rather than a number folded into `unitAmount` (ADR-0022), which is why
   * `unitAmount` above still says what one of it cost. `total` is what the line came to with
   * all of them and the tax accounted for.
   */
  readonly adjustments: readonly OrderAdjustment[];
  readonly total: number;
  readonly metadata: Record<string, unknown>;
};

/** Who the storefront said the Order was for, copied from the Cart at Capture. */
export type OrderShopper = {
  readonly email: string;
  readonly externalId: string | null;
};

export type Order = {
  readonly id: string;
  /**
   * The **Order number** — what a Shopper reads over the phone, and not the identifier.
   *
   * Monotonic and stable forever, and **not gapless**: it comes from a sequence, which
   * advances for an attempt that rolled back. Gapless numbering is an invoicing requirement
   * and invoicing is not Core's.
   */
  readonly number: number;
  readonly shopper: OrderShopper | null;
  readonly currency: string;
  /** What was charged, in minor units of `currency`. */
  readonly total: number;
  /**
   * **In SKU order**, the way a Product reports its Variants — never in the order they were
   * added to the Cart.
   *
   * Capture writes every line in one transaction, so there is no moment that distinguishes one
   * line from another to order by; a SKU is unique across the deployment and a Cart holds one
   * line per Variant, so it is the total order that is actually available. Read a line by its
   * `sku`, never by position.
   */
  readonly lineItems: readonly OrderLineItem[];
  /**
   * The Adjustments on the **Order as a whole** — the ones that belong to no single line.
   *
   * A line's own are on the line, not here, and the split is not presentational: an Adjustment
   * on a line is part of what that line came to, and one here is not attributable to any of
   * them. `total` accounts for both.
   */
  readonly adjustments: readonly OrderAdjustment[];
  readonly metadata: Record<string, unknown>;
  /**
   * The moment of **Capture**, when this Order came into existence and became immutable.
   *
   * There is deliberately no `updatedAt` beside it. An Order is never edited (ADR-0009), so a
   * second timestamp on this shape would be a field whose only honest value is the first one,
   * and the first thing anybody would take as permission to write to the row.
   */
  readonly createdAt: string;
};

/**
 * One Order with its Line Items, or `undefined` when there is no such Order — including when
 * `id` is not an identifier at all, which is the same answer for the caller.
 */
export async function readOrder(db: Queryable, id: string): Promise<Order | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select({
      id: order.id,
      number: order.number,
      shopperEmail: order.shopperEmail,
      shopperExternalId: order.shopperExternalId,
      currency: order.currency,
      total: order.total,
      metadata: order.metadata,
      createdAt: order.createdAt,
    })
    .from(order)
    .where(eq(order.id, id))
    .limit(1);
  if (!row) return undefined;

  const lines = await db
    .select({
      id: orderLineItem.id,
      variantId: orderLineItem.variantId,
      title: orderLineItem.title,
      sku: orderLineItem.sku,
      unitAmount: orderLineItem.unitAmount,
      quantity: orderLineItem.quantity,
      tax: orderLineItem.tax,
      total: orderLineItem.total,
      metadata: orderLineItem.metadata,
    })
    .from(orderLineItem)
    // **By SKU**, the way a Product reports its Variants — and deliberately not by
    // `created_at`, which is what a Cart's lines are ordered by. Capture writes every line in
    // one transaction, and `now()` is constant across one, so every row here carries the same
    // timestamp: ordering by it would leave the tie to be broken by a random uuid, and an Order
    // would report its lines in a different order from the Cart it was placed from and from
    // itself on a rebuild. A SKU is unique across the deployment and a Cart holds one line per
    // Variant, so this is a total order that never varies.
    .orderBy(asc(orderLineItem.sku), asc(orderLineItem.id))
    .where(eq(orderLineItem.orderId, row.id));

  // Every Adjustment on this Order in one query — the Order's own and its lines' alike, split
  // apart below. One round trip rather than one per line, and `order_id` is on every row for
  // exactly that reason.
  const adjustments = await db
    .select({
      id: orderAdjustment.id,
      orderLineItemId: orderAdjustment.orderLineItemId,
      code: orderAdjustment.code,
      description: orderAdjustment.description,
      amount: orderAdjustment.amount,
      metadata: orderAdjustment.metadata,
    })
    .from(orderAdjustment)
    // In the order they were applied, which is the order the Steps produced them in. Not by
    // `created_at`: Capture writes them all in one transaction, so every row carries the same
    // timestamp and the tie would fall to a random uuid — see `position` in `schema.ts`.
    .orderBy(asc(orderAdjustment.position), asc(orderAdjustment.id))
    .where(eq(orderAdjustment.orderId, row.id));

  const adjustmentsOf = (lineItemId: string | null): readonly OrderAdjustment[] =>
    adjustments
      .filter((one) => one.orderLineItemId === lineItemId)
      .map(({ orderLineItemId: _line, ...adjustment }) => adjustment);

  return {
    id: row.id,
    number: row.number,
    shopper:
      row.shopperEmail === null
        ? null
        : { email: row.shopperEmail, externalId: row.shopperExternalId },
    currency: row.currency,
    total: row.total,
    lineItems: lines.map((line) => ({ ...line, adjustments: adjustmentsOf(line.id) })),
    // The Order's own: the ones attached to no line at all.
    adjustments: adjustmentsOf(null),
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}
