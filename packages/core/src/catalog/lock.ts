import { inArray } from "drizzle-orm";
import type { Transaction } from "../db/client.ts";
import { variant } from "../db/schema.ts";

/**
 * Holding a Variant still — the one way a write that *references* a Variant keeps it from
 * going, and the one place the order every site takes these rows in is written out in full.
 *
 * **`catalog/delete.ts` is the exception and is not a caller**: it takes `for update` on the
 * rows it is removing, which is a different lock for the opposite reason — one write depends on
 * the Variant continuing to exist, the other is what ends it. It takes them in the order below
 * like everything else, and ADR-0059 is where its side of the argument lives.
 *
 * Four writes need this one, and they are otherwise unrelated: `setPrice` inserts a Price,
 * `addLineItem` inserts a Cart line, `setInventory` upserts a count and `capture-order` writes
 * an Order's Line Items. Each asks whether a Variant is there and then writes a row referencing
 * it, and each has to still be right about that when its own statement lands — a Merchant may
 * delete a Variant at any moment (`catalog/delete.ts`). The failure is the same one every time:
 * a foreign key pointing at a row that has just gone, which Postgres refuses and which reaches
 * a caller as a **500** on a route that declares a 404.
 *
 * **A row lock is ADR-0018's other answer, and existence is why it is the one available here.**
 * The rule is that a check and the write it authorises are one operation — a unique constraint
 * or a lock, never a `select` followed by an `update`. Where the fact checked is a column the
 * same statement writes, one statement does it, which is how `inventoryProvider.hold` claims a
 * unit. Existence is not such a fact: no single statement can both check that a Variant is there
 * and depend on it still being there. So the lock is what makes two statements one operation.
 *
 * **`for share` rather than `for update`.** Two Captures, two Cart adds and two Merchants
 * counting the same shelf have no quarrel with each other — only with a `DELETE`, which takes
 * `for update` and which this is what blocks. Locking exclusively would serialise writers who
 * were never in conflict.
 *
 * ## The order these rows are taken in
 *
 * **`core_product` → `core_variant` → `core_inventory`.** Every site that holds more than one of
 * those rows takes them in that order — the delete routes (#115, ADR-0059), `capture-order`, and
 * the count path (#145) — because two sites taking two of them in opposite orders deadlock, and
 * Postgres resolves a deadlock by killing one of the two requests. A Shopper or a Merchant is
 * then told the server broke about something that was merely simultaneous.
 *
 * **A caller need not hold all three, and none of these three tables is a caller's to choose.**
 * What the order constrains is only the rows a site actually takes: **a prefix nobody holds
 * cannot make a cycle**, so a site that takes no Product lock is free not to. Concretely, a
 * fifth caller of this function has two things to get right:
 *
 * - take this lock **before** anything it does to `core_inventory` — a count, or
 *   `variantsWithClaimedStock`;
 * - take it **after** any lock on the Product, which today only `catalog/delete.ts` takes.
 *
 * **`core_cart` sits outside that chain, and only shared locks keep it there.** `addLineItem`
 * arrives here already holding its Cart row `for update` (`cart/write.ts`'s `mutate`), while
 * `capture-order` takes these rows *first* and touches its Cart row after — two orders that
 * disagree, and that do not deadlock only because what they both take on the Variant is
 * **shared** and so conflicts with neither. A site that ever needs `for update` on a Variant has
 * that to settle before it writes anything.
 *
 * Nothing in this repository would catch getting any of it wrong: a deadlock needs two sites
 * contending over the same rows at the same instant, and no test can be written against a site
 * that does not exist yet. This comment is the guardrail, which is why it is here rather than
 * restated at each call site — and why ADR-0059 and the delete routes state the rule too, from
 * the side they enforce it on.
 */

/**
 * Locks the Variant, and answers whether there is one — `false` is "no such Variant".
 *
 * The lock is held until the caller's transaction ends, so the answer is still true when the
 * row referencing it is written. **Take it after any lock on the Product and before anything
 * you do to `core_inventory`** — `core_product` → `core_variant` → `core_inventory`, argued at
 * the head of this file, where a fifth caller should read the rest before writing one.
 *
 * Why a given route needs it at all stays at that route, because the reason is different at
 * each of them.
 */
export async function lockVariant(tx: Transaction, variantId: string): Promise<boolean> {
  const found = await lockVariants(tx, [variantId]);
  return found.has(variantId);
}

/**
 * The same thing about several Variants at once: which of them are there, locked.
 *
 * One statement rather than a loop, so the set is one answer taken at one instant — and the
 * singular form above is this one with a list of one, rather than a second implementation that
 * would have to agree with it about the lock mode and the order. What comes back is only the
 * Variants that exist; a caller that named some which do not gets a smaller set, which is
 * exactly what `capture-order` writes a `null` reference for (ADR-0009).
 *
 * The same ordering rule applies, for the same reason: **after the Product, before
 * `core_inventory`.**
 */
export async function lockVariants(
  tx: Transaction,
  variantIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = [...new Set(variantIds)];
  // Nothing to hold, and `in ()` is not a query Postgres will run — an Order captured from a
  // Cart with no lines reaches here like any other.
  if (wanted.length === 0) return new Set();

  const rows = await tx
    .select({ id: variant.id })
    .from(variant)
    .where(inArray(variant.id, wanted))
    .for("share");

  return new Set(rows.map((row) => row.id));
}
