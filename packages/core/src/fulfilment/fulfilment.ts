import { asc, eq, inArray } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client.ts";
import { fulfilment, orderLineItem } from "../db/schema.ts";
import type { AppliedFulfilment } from "./strategy.ts";

/**
 * **Fulfilment** — the entity ADR-0014 asks for, and the shape of it rather than the feature.
 *
 * One Order has many, on independent timelines: a poster ships, a PDF is emailed, a print job is
 * made and then shipped. Modelling that as a status column on the Order would force one
 * lifecycle onto parts that do not share one — an ADR-0009-class mistake, cheap now and
 * unfixable once there is order history — so it is a row per way this Order is delivered, and
 * the Line Items that go together point at the same one.
 *
 * **Nothing here fulfils anything.** There is no state, no transition and no dispatch: fulfilling
 * is its own spec (#98 puts it out of scope), and what this ticket owes is the record it will be
 * written against. What exists today is the grouping and the snapshot.
 */

/** One Fulfilment of an Order, as a caller reads it. */
export type Fulfilment = {
  readonly id: string;
  /**
   * The Fulfilment Strategy that produced it, by the name the deployment wired it under.
   *
   * Copied at Capture and never looked up again: a Project may rewire `physical`, or remove the
   * Plugin that offered `made-to-order`, and this Order still says what it was fulfilled by.
   */
  readonly strategy: string;
  /**
   * What that Strategy answered about these lines, **as at Capture** (ADR-0009).
   *
   * The answers rather than a reference to the Strategy, for the same reason a Line Item holds a
   * title rather than a join: a record that asked the live Strategy would be rewritten by a
   * config change and destroyed by an uninstall.
   */
  readonly requiresShipping: boolean;
  readonly tracksInventory: boolean;
  readonly hasLeadTime: boolean;
  /**
   * The Order's Line Items this Fulfilment covers, in SKU order — the order the Order reports
   * its lines in, so the two lists read against each other.
   *
   * Every line of an Order this version of kobai placed is in exactly one Fulfilment. A line
   * belonging to none is one placed before Fulfilment existed.
   */
  readonly lineItemIds: readonly string[];
};

/**
 * The Fulfilments of an Order, each with the lines it covers.
 *
 * Two queries rather than a join, exactly as an Order's Adjustments are read: a Fulfilment
 * multiplied by its lines would have to be folded apart in TypeScript anyway.
 *
 * **In a fixed order**: by the Strategy's name, then by what it answered. Capture writes every
 * row in one transaction, so `created_at` is identical across all of them and the tie would fall
 * to a random uuid — an Order would report its Fulfilments differently every time it was read.
 * The four columns together are a total order, because no two rows on one Order can share all
 * four: that is precisely what `writeFulfilments` groups by.
 */
export async function readFulfilmentsOf(
  db: Queryable,
  orderId: string,
): Promise<Fulfilment[]> {
  const rows = await db
    .select({
      id: fulfilment.id,
      strategy: fulfilment.strategy,
      requiresShipping: fulfilment.requiresShipping,
      tracksInventory: fulfilment.tracksInventory,
      hasLeadTime: fulfilment.hasLeadTime,
    })
    .from(fulfilment)
    .orderBy(
      asc(fulfilment.strategy),
      asc(fulfilment.requiresShipping),
      asc(fulfilment.tracksInventory),
      asc(fulfilment.hasLeadTime),
    )
    .where(eq(fulfilment.orderId, orderId));
  if (rows.length === 0) return [];

  const lines = await db
    .select({ id: orderLineItem.id, fulfilmentId: orderLineItem.fulfilmentId })
    .from(orderLineItem)
    // By SKU, which is how the Order reports its lines — so `lineItemIds` and `lineItems` are
    // in the same order rather than in two orders a caller has to reconcile.
    .orderBy(asc(orderLineItem.sku), asc(orderLineItem.id))
    .where(
      inArray(
        orderLineItem.fulfilmentId,
        rows.map((row) => row.id),
      ),
    );

  return rows.map((row) => ({
    ...row,
    lineItemIds: lines
      .filter((line) => line.fulfilmentId === row.id)
      .map((line) => line.id),
  }));
}

/**
 * Writes an Order's Fulfilments, and says which one each line belongs to.
 *
 * **Grouped by the Strategy's name *and* its answers**, not by the name alone. A Strategy is
 * asked about each Variant and may answer differently — that is why it is an interface rather
 * than a record of flags (ADR-0014) — so two lines fulfilled by one Strategy that answered
 * differently about them are two Fulfilments, and stamping one line's answers on the other's
 * snapshot would be a record of something that never happened.
 *
 * In the transaction that writes the Order, before its Line Items, because a line names the
 * Fulfilment it is part of. Nothing here can fail in a way a compensation could undo — it is
 * inside Capture, and the database unwinds it with everything else (ADR-0018).
 */
export async function writeFulfilments(
  tx: Transaction,
  orderId: string,
  lines: readonly { readonly fulfilment: AppliedFulfilment }[],
): Promise<Map<string, string>> {
  const distinct = new Map<string, AppliedFulfilment>();
  for (const line of lines) distinct.set(keyOf(line.fulfilment), line.fulfilment);

  const written = await tx
    .insert(fulfilment)
    .values(
      [...distinct.values()].map((applied) => ({
        orderId,
        strategy: applied.strategy,
        requiresShipping: applied.requiresShipping,
        tracksInventory: applied.tracksInventory,
        hasLeadTime: applied.hasLeadTime,
      })),
    )
    .returning({
      id: fulfilment.id,
      strategy: fulfilment.strategy,
      requiresShipping: fulfilment.requiresShipping,
      tracksInventory: fulfilment.tracksInventory,
      hasLeadTime: fulfilment.hasLeadTime,
    });

  // Keyed by what each row says rather than by the position it came back in, for the reason the
  // Line Items are keyed by SKU: `returning` promises no order, and a mapping that assumed one
  // would attach lines to the wrong Fulfilment silently.
  return new Map(written.map((row) => [keyOf(row), row.id]));
}

/**
 * What makes two lines part of one Fulfilment: the same Strategy, answering the same way.
 *
 * A string rather than a tuple because it is a `Map` key, and it is built from all four fields
 * rather than from the name so that a Strategy answering per Variant cannot have one Variant's
 * answers recorded against another's line.
 */
export function keyOf(applied: AppliedFulfilment): string {
  return JSON.stringify([
    applied.strategy,
    applied.requiresShipping,
    applied.tracksInventory,
    applied.hasLeadTime,
  ]);
}
