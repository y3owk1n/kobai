import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { price, product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { variantsWithClaimedStock } from "../reservation/inventory.ts";

/**
 * Removing a catalog entry — a Product, a Variant, a Price.
 *
 * Its own module rather than more of `write.ts`, because deleting is where the catalog's two
 * hard rules meet and neither is visible from a create: ADR-0008's "every Product has at
 * least one Variant", which creation guarantees by making the zero-Variant state unreachable,
 * and ADR-0009's "catalog data is freely deletable", which is only true because an Order's
 * Line Items snapshot everything they display.
 *
 * **What a delete leaves behind, and why that is right.** `core_reservation.subject` is text
 * with no foreign key (ADR-0018), so the Reservations a deleted Variant's stock was claimed
 * under survive it — and they should. A Reservation is Core's *record* that a claim happened,
 * consumed or released on a day nothing can change now; deleting the Variant does not make it
 * not have happened, exactly as it does not un-place the Orders. What is refused below is a
 * claim that is still **live**, because that one is about to become an Order or lapse.
 */

/** Deleting a Product refuses in two ways, and each names something a Merchant can act on. */
export type ProductDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "product-not-found" | "stock-is-reserved";
      readonly detail: string;
    };

/** Deleting a Variant refuses in three ways, and each names something a Merchant can act on. */
export type VariantDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "variant-not-found" | "last-variant" | "stock-is-reserved";
      readonly detail: string;
    };

/**
 * Deletes a Product, and every Variant of it, by cascade.
 *
 * This is the route ADR-0008 leaves for the Variant one to point at: a Product's last Variant
 * cannot be deleted on its own, because a Product with none is a catalog entry nothing can
 * buy, and the way to be rid of both is to address the Product.
 */
export async function deleteProduct(
  db: Database,
  productId: string,
): Promise<ProductDeletion> {
  if (!isUuid(productId)) return noSuchProduct(productId);

  return db.transaction(async (tx) => {
    // Locked in the same order `deleteVariant` takes them — the Product, then its Variants —
    // so the two cannot deadlock each other, and a Variant delete in flight against this
    // Product waits here rather than racing.
    const [found] = await tx
      .select({ id: product.id })
      .from(product)
      .where(eq(product.id, productId))
      .for("update")
      .limit(1);
    if (!found) return noSuchProduct(productId);

    const variants = await tx
      .select({ id: variant.id })
      .from(variant)
      .where(eq(variant.productId, productId))
      .for("update");

    // Asked here as well as in `deleteVariant`, or the refusal would be one call wide: every
    // Variant of this Product is about to go, so every one of them has to be free to go.
    const claimed = await variantsWithClaimedStock(
      tx,
      variants.map((row) => row.id),
    );
    if (claimed.length > 0) {
      return {
        ok: false,
        reason: "stock-is-reserved",
        detail: `${stockIsClaimed(claimed)} This Product cannot be deleted until they have.`,
      } as const;
    }

    await tx.delete(product).where(eq(product.id, productId));
    return { ok: true } as const;
  });
}

/**
 * Deletes a Variant, and with it everything that only means anything while it is sellable —
 * its Prices, its Inventory row and any Cart line that selected it, all by cascade.
 *
 * What it deliberately does not touch is an Order: `core_order_line_item.variant_id` is
 * nullable and `set null`, so the reference kept for navigation goes and the snapshot —
 * title, SKU, unit amount, tax, total — stays exactly as Capture wrote it (ADR-0009).
 *
 * **A Product's last Variant is refused rather than taken** (ADR-0008). `write.ts` guarantees
 * that a Product with no Variant is unreachable by giving the API no way to create one, and
 * this is the other end of the same guarantee: the alternative — quietly deleting the Product
 * too — would have a route delete a resource its caller never addressed, which is a worse
 * thing for a `DELETE` to do than to refuse. Deleting the Product is one call away and says so.
 */
export async function deleteVariant(
  db: Database,
  variantId: string,
): Promise<VariantDeletion> {
  if (!isUuid(variantId)) return noSuchVariant(variantId);

  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ productId: variant.productId })
      .from(variant)
      .where(eq(variant.id, variantId))
      .limit(1);
    if (!found) return noSuchVariant(variantId);

    // The Product row is the lock, and counting siblings without it would be a check that two
    // requests can both pass: two Merchants deleting the two Variants of one Product at the
    // same instant would each see the other's and delete anyway, leaving the Product with
    // none — the state this refusal exists to prevent.
    await tx
      .select({ id: product.id })
      .from(product)
      .where(eq(product.id, found.productId))
      .for("update");

    // Unlocked, and safe because of the lock above: the only thing that can change this count
    // is another delete, both routes take the Product first, and there is no route that adds a
    // Variant to a Product that already exists.
    const siblings = await tx
      .select({ id: variant.id })
      .from(variant)
      .where(eq(variant.productId, found.productId));
    if (!siblings.some((row) => row.id === variantId)) return noSuchVariant(variantId);
    if (siblings.length === 1) {
      return {
        ok: false,
        reason: "last-variant",
        detail: `Variant ${JSON.stringify(variantId)} is the only Variant of its Product, and every Product has at least one. Delete the Product instead — \`DELETE /admin/products/${found.productId}\` — which takes this Variant with it.`,
      } as const;
    }

    // This Variant and no other, so deleting one does not hold up a Capture of the ones beside
    // it. Taken **before** its Inventory row is, because `capture-order` takes the same two in
    // the same order and the opposite order is a deadlock — and taken here rather than left to
    // the `DELETE` below, which would take it after.
    const [locked] = await tx
      .select({ id: variant.id })
      .from(variant)
      .where(eq(variant.id, variantId))
      .for("update")
      .limit(1);
    if (!locked) return noSuchVariant(variantId);

    const claimed = await variantsWithClaimedStock(tx, [variantId]);
    if (claimed.length > 0) {
      return {
        ok: false,
        reason: "stock-is-reserved",
        detail: `${stockIsClaimed(claimed)} This Variant cannot be deleted until they have.`,
      } as const;
    }

    await tx.delete(variant).where(eq(variant.id, variantId));
    return { ok: true } as const;
  });
}

/** Deleting a Price refuses in two ways, one for each half of the address it is asked by. */
export type PriceDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "variant-not-found" | "price-not-found";
      readonly detail: string;
    };

/**
 * Removes one Price from a Variant.
 *
 * Addressed through the Variant it prices, exactly as setting one is, so a Price identifier
 * belonging to another Variant is not found here rather than deleted from under a Variant
 * nobody named. **The last Price is not a special case**: a Variant with no Price is a state
 * the API already produces at creation, and it is what a Merchant reaches for to stop selling
 * something at once — an unpriced Variant cannot be quoted and cannot be put in a Cart.
 */
export async function deletePrice(
  db: Database,
  variantId: string,
  priceId: string,
): Promise<PriceDeletion> {
  if (!isUuid(variantId)) return noSuchVariant(variantId);
  if (!isUuid(priceId)) return noSuchPrice(variantId, priceId);

  const deleted = await db
    .delete(price)
    .where(and(eq(price.id, priceId), eq(price.variantId, variantId)))
    .returning({ id: price.id });
  if (deleted.length > 0) return { ok: true };

  // Nothing went, and the two ways that happens are not the same answer. Asked only now,
  // because it is a question about a refusal rather than about the ordinary case — and the
  // more fundamental half is answered first, for `setPrice`'s reason: a caller told only that
  // the Price is not there would go looking for it under a Variant that is not there either.
  const [found] = await db
    .select({ id: variant.id })
    .from(variant)
    .where(eq(variant.id, variantId))
    .limit(1);
  return found ? noSuchPrice(variantId, priceId) : noSuchVariant(variantId);
}

/**
 * The half of the refusal both routes share: which Variants are spoken for, and what ends it.
 *
 * Deliberately the same sentence `PUT /admin/variants/{id}/inventory` answers with about the
 * same units, because it is the same fact and it clears itself the same way — the Orders being
 * placed either complete or lapse.
 */
function stockIsClaimed(variantIds: readonly string[]): string {
  return `${variantIds.length === 1 ? `Variant ${JSON.stringify(variantIds[0])} has` : `The Variants ${variantIds.map((id) => JSON.stringify(id)).join(", ")} have`} stock currently claimed by Reservations being placed. Those either become Orders or lapse.`;
}

function noSuchProduct(productId: string): ProductDeletion {
  return {
    ok: false,
    reason: "product-not-found",
    detail: `No Product ${JSON.stringify(productId)} exists, so there is nothing to delete.`,
  };
}

/**
 * Not found, in the one shape both routes that address a Variant answer with.
 *
 * `as const` rather than a return type, because it is the answer to two questions whose
 * refusals are different unions — annotating it as either would make it unusable by the other.
 */
function noSuchVariant(variantId: string) {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists.`,
  } as const;
}

function noSuchPrice(variantId: string, priceId: string) {
  return {
    ok: false,
    reason: "price-not-found",
    detail: `Variant ${JSON.stringify(variantId)} carries no Price ${JSON.stringify(priceId)}. A Price is addressed through the Variant it prices, so a Price of another Variant is not found here.`,
  } as const;
}
