import { asc, desc, eq, inArray } from "drizzle-orm";
import type { OrderAddress } from "../address/address.ts";
import type { Queryable } from "../db/client.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import {
  order,
  orderAddress,
  orderAdjustment,
  orderLineItem,
  payment,
} from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { type Fulfilment, readFulfilmentsOf } from "../fulfilment/fulfilment.ts";

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

/**
 * An Adjustment on the **Order as a whole** — and the only kind that carries a tax (#117).
 *
 * A delivery surcharge is on no line, so no Line Item's `tax` can hold what it was taxed; this
 * is where a replaced `calculate-tax` puts that figure, and the Order's `total` accounts for it.
 * A line's Adjustments are read as {@link OrderAdjustment} and have no `tax` of their own,
 * because `calculate-tax` taxes the adjusted line and their tax is already inside the line's.
 * That absence is the shape, not an omission: a field whose only honest value on a line's
 * Adjustment is zero would be the first thing somebody wrote a second tax figure into.
 */
export type OrderLevelAdjustment = OrderAdjustment & {
  /** Minor units, signed with `amount` — a taxed discount reduces the tax it is on. */
  readonly tax: number;
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

/**
 * The **Payment** taken for an Order — the record that money moved (ADR-0053).
 *
 * Core's record behind an interface Core does not implement, so everything here came from the
 * provider or from what Core charged it: `provider` names the system holding the money and
 * `reference` is that system's own handle on this payment, stored and never parsed.
 */
export type Payment = {
  readonly id: string;
  /** The provider's `name` as it was wired when the money moved — `manual`, `stripe`. */
  readonly provider: string;
  /** What the provider called this payment. Opaque to kobai; quote it at the provider. */
  readonly reference: string;
  /** What was taken, in minor units of the Order's currency. */
  readonly amount: number;
  readonly currency: string;
  /**
   * Whether the money **arrived**, or was only arranged for.
   *
   * `true` is a card charged; `false` is a provider that arranges out of band — an invoice, a
   * bank transfer, cash at the counter — so this Order is real and nobody has been paid. It is
   * the provider's answer at Capture and is never updated: an Order is immutable (ADR-0009),
   * and collecting an arranged payment happens where it always did, outside kobai.
   */
  readonly received: boolean;
  /** When the money moved, which is within the same request that captured the Order. */
  readonly createdAt: string;
};

/**
 * An Order as a **list** reports it — everything but its lines.
 *
 * The split a Product and a `ProductDetail` make, and for the same reason: a list is not a
 * detail view, and a Merchant scanning what has sold is looking for the number, the money and
 * the day rather than for every line of every Order at once. `payment` is here and not in the
 * detail alone, deliberately — whether the money actually arrived is exactly what somebody
 * reading a list of Orders is looking down the column for.
 */
export type OrderSummary = {
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
   * The money taken for this Order, or `null` if none is recorded against it.
   *
   * `place-order` takes payment before it captures and writes both in one transaction, so an
   * Order **this** version placed always has one — a declined payment leaves no Order at all.
   * `null` is what an Order placed before the Payment record existed reads as, which is every
   * Order already in a database kobai has just been upgraded in.
   *
   * Whether the money actually arrived is {@link Payment.received}, and that is the different
   * question: a Payment is present and unreceived when a provider arranged the money rather than
   * taking it, which is a real sale nobody has been paid for.
   */
  readonly payment: Payment | null;
  /**
   * The moment of **Capture**, when this Order came into existence and became immutable.
   *
   * There is deliberately no `updatedAt` beside it. An Order is never edited (ADR-0009), so a
   * second timestamp on this shape would be a field whose only honest value is the first one,
   * and the first thing anybody would take as permission to write to the row.
   */
  readonly createdAt: string;
};

/** An Order opened: everything a list carries, and what was actually bought. */
export type Order = OrderSummary & {
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
   *
   * These are the ones that carry a `tax` of their own, for the reason
   * {@link OrderLevelAdjustment} gives.
   */
  readonly adjustments: readonly OrderLevelAdjustment[];
  /**
   * How this Order gets to the Shopper — **one entry per way**, on independent timelines
   * (ADR-0014).
   *
   * A list rather than a status, because a mixed Order ships a poster and emails a PDF and those
   * do not share a lifecycle. Each says which of the lines above it covers, and what its
   * Fulfilment Strategy answered at Capture — a snapshot, like everything else here, so
   * rewiring a Strategy does not rewrite an Order.
   *
   * Empty for an Order placed before Fulfilment existed, which is every Order already in a
   * database kobai has just been upgraded in.
   */
  readonly fulfilments: readonly Fulfilment[];
  /**
   * Where this Order went — a **snapshot** taken at Capture, or `null` for one placed from a
   * Cart that carried no Address (#319, ADR-0009, ADR-0072).
   *
   * Read out of `core_order_address`, which holds copies rather than a reference: correcting the
   * Address on the Cart, replacing it, taking it off, or deleting the Region it named reaches
   * none of it. That is the same asymmetry a Line Item's `title` and `unitAmount` carry against
   * `core_variant`, one noun along.
   *
   * On the detail rather than on {@link OrderSummary}, deliberately. A list of Orders is a list
   * of numbers, money and days; a destination is several lines of prose, and a Merchant asking
   * where a parcel goes has opened the Order.
   */
  readonly address: OrderAddress | null;
  readonly metadata: Record<string, unknown>;
};

/**
 * A page of Orders, newest first — what the Admin lists (spec story 56).
 *
 * **The list a cursor was decided for** (ADR-0064). This is the one table guaranteed both to
 * grow without bound and to take concurrent inserts, from every `POST /store/orders` a
 * storefront makes — so a Merchant paging through it during a busy hour is the ordinary case,
 * and an offset would show them one Order twice and hide another with no error and no clue.
 * `page.after` names the record the last page ended at, so an Order captured since is simply
 * above the page being read.
 *
 * The Payments come back in a second query rather than a join, so that an Order with none is
 * an absence from a map rather than a row of nulls to interpret — and so that this reads the
 * same way {@link readOrder} does. It asks about the page's Orders rather than the table's,
 * which is the other half of what paging is for.
 */
export async function listOrders(
  db: Queryable,
  page: PageRequest,
): Promise<Page<OrderSummary>> {
  const fetched = await db
    .select({
      id: order.id,
      number: order.number,
      shopperEmail: order.shopperEmail,
      shopperExternalId: order.shopperExternalId,
      currency: order.currency,
      total: order.total,
      createdAt: order.createdAt,
      cursorAt: cursorAt(order.createdAt),
    })
    .from(order)
    .where(rowsAfter(page, order.createdAt, order.id))
    // `id` breaks the tie, so two Orders captured in the same instant still come back in one
    // stable order rather than in whichever order Postgres happened to read them — and so that
    // a cursor cut from the last of them names one row rather than a group of them.
    .orderBy(desc(order.createdAt), desc(order.id))
    .limit(pageSize(page));

  const { rows, nextCursor } = takePage(fetched, page);
  // Only to skip the second query, so the cursor still travels: an empty page carries no
  // cursor *today*, because nothing was filtered out on the way — and the day one of these
  // routes filters, that is exactly the page `nextCursor` has to keep speaking for.
  if (rows.length === 0) return { items: [], nextCursor };

  const payments = await db
    .select(paymentColumns)
    .from(payment)
    .where(
      inArray(
        payment.orderId,
        rows.map((row) => row.id),
      ),
    );
  const taken = new Map(payments.map((row) => [row.orderId, paymentOf(row)]));

  return {
    items: rows.map((row) => ({
      id: row.id,
      number: row.number,
      shopper: shopperOf(row),
      currency: row.currency,
      total: row.total,
      payment: taken.get(row.id) ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

/**
 * One Order with its Line Items, or `undefined` when there is no such Order — including when
 * `id` is not an identifier at all, which is the same answer for the caller.
 */
/**
 * The Order a Cart became, or `undefined` while it has not become one.
 *
 * There is at most one — `core_order.cart_id` is unique, which is what makes a Cart spent by the
 * Order it became (#102) — so this is a lookup rather than a search. It exists because the Order
 * is the **record** of that placement and an idempotency key is only a pointer at it: a request
 * that captured and then died before naming its Order on its key leaves the key saying nothing,
 * and this is how the answer is recovered from the thing that cannot be wrong.
 */
export async function readOrderPlacedFrom(
  db: Queryable,
  cartId: string,
): Promise<Order | undefined> {
  if (!isUuid(cartId)) return undefined;

  const [row] = await db
    .select({ id: order.id })
    .from(order)
    .where(eq(order.cartId, cartId))
    .limit(1);

  return row ? readOrder(db, row.id) : undefined;
}

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
      tax: orderAdjustment.tax,
      metadata: orderAdjustment.metadata,
    })
    .from(orderAdjustment)
    // In the order they were applied, which is the order the Steps produced them in. Not by
    // `created_at`: Capture writes them all in one transaction, so every row carries the same
    // timestamp and the tie would fall to a random uuid — see `position` in `schema.ts`.
    .orderBy(asc(orderAdjustment.position), asc(orderAdjustment.id))
    .where(eq(orderAdjustment.orderId, row.id));

  const fulfilments = await readFulfilmentsOf(db, row.id);

  // At most one, in DDL — see `core_order_address`'s unique index on `order_id`. Selected column
  // by column and **without a join onto `core_region`**, which is the whole of ADR-0009 on this
  // table: `region_name` is the copy a person reads, and `region_id` is navigation that goes
  // `null` when the Region does.
  const [destination] = await db
    .select({
      country: orderAddress.country,
      lines: orderAddress.lines,
      postalCode: orderAddress.postalCode,
      regionId: orderAddress.regionId,
      regionName: orderAddress.regionName,
    })
    .from(orderAddress)
    .where(eq(orderAddress.orderId, row.id))
    .limit(1);

  // At most one, in DDL — see `core_payment`'s unique index on `order_id`.
  const [paid] = await db
    .select(paymentColumns)
    .from(payment)
    .where(eq(payment.orderId, row.id))
    .limit(1);

  /**
   * One line's Adjustments — **without a tax**, which is the shape rather than an omission.
   *
   * `calculate-tax` taxes the adjusted line, so a line's Adjustments are already inside the
   * line's own `tax`; the column is zero on every one of them in DDL (#117).
   */
  const adjustmentsOf = (lineItemId: string): readonly OrderAdjustment[] =>
    adjustments
      .filter((one) => one.orderLineItemId === lineItemId)
      .map(({ orderLineItemId: _line, tax: _tax, ...adjustment }) => adjustment);

  /** The Order's own: the ones attached to no line at all, and the only ones with a tax. */
  const ownAdjustments: readonly OrderLevelAdjustment[] = adjustments
    .filter((one) => one.orderLineItemId === null)
    .map(({ orderLineItemId: _line, ...adjustment }) => adjustment);

  return {
    id: row.id,
    number: row.number,
    shopper: shopperOf(row),
    currency: row.currency,
    total: row.total,
    lineItems: lines.map((line) => ({ ...line, adjustments: adjustmentsOf(line.id) })),
    adjustments: ownAdjustments,
    fulfilments,
    address: destination ? addressOf(destination) : null,
    metadata: row.metadata,
    payment: paid ? paymentOf(paid) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One snapshotted destination as a caller reads it.
 *
 * `regionName` is what says whether there was a Region at all, and `regionId` is allowed to be
 * `null` beside a name that is not: that pair is the whole point of the snapshot, and it is what
 * an Order whose Region has since been deleted reads as.
 */
function addressOf(row: {
  readonly country: string;
  readonly lines: readonly string[];
  readonly postalCode: string | null;
  readonly regionId: string | null;
  readonly regionName: string | null;
}): OrderAddress {
  return {
    country: row.country,
    lines: row.lines,
    postalCode: row.postalCode,
    region: row.regionName === null ? null : { id: row.regionId, name: row.regionName },
  };
}

/**
 * What a Payment is read as, in one place, because two readers answer with the same shape.
 *
 * `orderId` is selected and not reported: the list needs it to say which Order each Payment
 * belongs to, and a caller already holding the Order has no use for it.
 */
const paymentColumns = {
  orderId: payment.orderId,
  id: payment.id,
  provider: payment.provider,
  reference: payment.reference,
  amount: payment.amount,
  currency: payment.currency,
  received: payment.received,
  createdAt: payment.createdAt,
} as const;

/**
 * One row as a caller reads it: the timestamp as an ISO string, and `orderId` left behind.
 *
 * Field by field rather than by spread, because a spread would carry `orderId` into a shape that
 * does not have one — the row is what the database holds and the {@link Payment} is what is
 * promised, and they are deliberately not the same object.
 */
function paymentOf(
  row: Omit<Payment, "createdAt"> & { readonly createdAt: Date },
): Payment {
  return {
    id: row.id,
    provider: row.provider,
    reference: row.reference,
    amount: row.amount,
    currency: row.currency,
    received: row.received,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `null` for a guest, which is the ordinary case — Core assumes a Shopper nowhere. */
function shopperOf(row: {
  readonly shopperEmail: string | null;
  readonly shopperExternalId: string | null;
}): OrderShopper | null {
  return row.shopperEmail === null
    ? null
    : { email: row.shopperEmail, externalId: row.shopperExternalId };
}
