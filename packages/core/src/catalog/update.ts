import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { violatesUniqueIndex } from "../db/errors.ts";
import { variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type FulfilmentStrategies,
  fulfilmentStrategyFor,
} from "../fulfilment/strategy.ts";
import { asMetadata, metadataDetail, trimmed } from "../input.ts";
import { readVariants, type Variant } from "./read.ts";
import { parseFulfilment, unknownFulfilmentStrategy } from "./write.ts";

/**
 * Correcting a Variant — its SKU, the Fulfilment Strategy it points at, and its metadata.
 *
 * Its own module for `delete.ts`'s reason: what a *create* may say is one question and what a
 * record Orders hold snapshots of may *become* is another, and the second is answered
 * field by field. **ADR-0062 is where the four decisions live** — that a SKU is free to move
 * because nothing holds one by value, that a Strategy swaps in both directions and the
 * `core_inventory` row stays exactly where it is, that a Price is superseded rather than
 * corrected and so is absent from this body, and that no update is refused for a live
 * Reservation. Read it before adding a field here or a refusal to it.
 *
 * **Nothing here is refused that creation would allow**, and the two refusals it can make are
 * creation's own words: `sku-taken` and `unknown-fulfilment-strategy`. That is deliberate under
 * ADR-0060 — this route adds no `reason` to the promised surface, so a client that already
 * branches on the catalog family's set needs no new arm for it.
 */

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type UpdateVariantInput = {
  readonly sku?: unknown;
  readonly fulfilment?: unknown;
  readonly metadata?: unknown;
};

/**
 * Correcting a Variant refuses in four ways, and every one of them is a word creation already
 * answers with.
 */
export type VariantUpdate =
  | { readonly ok: true; readonly variant: Variant }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "variant-not-found"
        | "sku-taken"
        | "unknown-fulfilment-strategy";
      readonly detail: string;
    };

/**
 * Changes what this Variant says about itself, and leaves everything that refers to it alone.
 *
 * **One statement decides everything, and so this takes no lock of its own** (ADR-0018).
 * Existence is answered by the `update` itself — nothing came back, so there is no such
 * Variant — and a SKU another Variant holds is answered by the unique index, which is the same
 * check `createProduct` reads off an `onConflictDoNothing`. There is nothing here for a
 * `select` to have found out first, so `catalog/lock.ts` is deliberately not called: it exists
 * for a write that *references* a Variant and must still be right that it is there, and this
 * write is the row itself.
 *
 * The transaction around it is for the **read back**, not for the decision: it makes the
 * Variant this answers with the row this write left, rather than whatever the next request
 * leaves between the two statements.
 *
 * That is also what keeps this out of the `core_cart` hazard `lock.ts` names. A cycle needs a
 * site that holds one lock and then asks for another; this one takes the single row lock its
 * `update` implies, reads through plain `select`s that block on nothing, and commits — so it
 * can be waited *for* and can never be half of a deadlock. **A field that ever needs a second
 * row is a field that has to settle that ordering first**, which is the concrete reason the
 * Inventory row is left alone rather than a squeamishness about deleting it.
 */
export async function updateVariant(
  db: Database,
  variantId: string,
  input: UpdateVariantInput,
  strategies: FulfilmentStrategies,
): Promise<VariantUpdate> {
  const changes: {
    sku?: string;
    fulfilmentStrategy?: string;
    metadata?: Record<string, unknown>;
  } = {};

  if (input.sku !== undefined) {
    const sku = trimmed(input.sku);
    if (sku === undefined) {
      return {
        ok: false,
        reason: "invalid",
        detail: "`sku` must be a non-empty string.",
      };
    }
    changes.sku = sku;
  }

  if (input.fulfilment !== undefined) {
    // Only when the key is there: absent means "leave it", where on a create the same absence
    // means `physical`. The parse is creation's, so one body shape is read one way.
    const fulfilment = parseFulfilment(input.fulfilment, "`fulfilment`");
    if (!fulfilment.ok) return fulfilment;

    // The same question `createProduct` asks, at the same moment and for the same reason: a
    // Variant pointing at a Strategy this deployment has not wired is one nothing can answer
    // the three questions about, so it cannot be sold — and it is what `place-order` already
    // refuses a purchase over. Repairing that is this route's headline case, so it must not be
    // possible to *arrive* at it here.
    if (!fulfilmentStrategyFor(strategies, fulfilment.value)) {
      return unknownFulfilmentStrategy(strategies, fulfilment.value);
    }
    changes.fulfilmentStrategy = fulfilment.value;
  }

  if (input.metadata !== undefined) {
    const metadata = asMetadata(input.metadata);
    if (metadata === undefined) {
      return { ok: false, reason: "invalid", detail: metadataDetail("metadata") };
    }
    // Replaced whole rather than merged. A merge would leave no way to remove a key a
    // Merchant put there by mistake, and "send the object you want" is the only rule that
    // does not need the caller to know what is already stored.
    changes.metadata = metadata;
  }

  // A `PATCH` naming no field is refused rather than answered 200 with the row unchanged —
  // the judgement `cart/write.ts`'s two `PATCH`es already make, in the same words: a request
  // that changes nothing is likelier a mistake than an intention. Here it is also the shape a
  // body naming a field this route does not carry collapses to, a Price above all, because the
  // schema strips it before the handler sees it. So the refusal says both halves: what may be
  // changed, and where a Price is set instead.
  if (Object.keys(changes).length === 0) {
    return {
      ok: false,
      reason: "invalid",
      detail:
        "Name at least one of `sku`, `fulfilment` or `metadata`. A Price is not changed here: set another with `POST /admin/variants/{id}/prices`, which supersedes it, and remove the old one with `DELETE /admin/variants/{id}/prices/{priceId}`.",
    };
  }

  // Asked after the body and before the database, exactly as `setPrice` asks it: a request
  // that is wrong in itself is wrong whatever the Store holds, so nothing is looked up to
  // answer it. `delete.ts` asks first because it has no body to be wrong.
  if (!isUuid(variantId)) return noSuchVariant(variantId);

  try {
    return await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(variant)
        .set(changes)
        .where(eq(variant.id, variantId))
        .returning({ productId: variant.productId });
      if (!updated) return noSuchVariant(variantId);

      // Read back rather than assembled from what went in, so a correction reports the same
      // bytes the next read reports — `createProduct`'s reason, and the reason this asks for
      // the Product's Variants rather than composing a shape of its own: there is one function
      // that says what a Variant looks like, and the Prices and the stock count it carries are
      // exactly the two things this route did not touch.
      //
      // **Inside the transaction**, so it is a read of the row this write left. Outside it, a
      // `DELETE` landing between the two statements would find nothing to read back and answer
      // 500 on a write that succeeded — the same two-loose-statements shape #145 found on the
      // count path, arrived at from the other side.
      const corrected = (await readVariants(tx, updated.productId)).find(
        (row) => row.id === variantId,
      );
      if (!corrected)
        throw new Error("A Variant was updated and could not be read back.");
      return { ok: true, variant: corrected } as const;
    });
  } catch (cause) {
    // The unique index is the check, and this is how its answer is read — the same mechanism
    // creation uses, in the one form an `update` has: Postgres has no `on conflict` here, so
    // the loser of two simultaneous renames finds out by being thrown at. A select-then-update
    // would let both pass and surface as a 500 rather than as the conflict it is (ADR-0018).
    //
    // Read out here rather than inside the transaction, for `setInventory`'s reason: a
    // statement Postgres refused has already aborted it, so a refusal decided in there would be
    // returned from a transaction that can no longer run anything.
    if (violatesUniqueIndex(cause, ONE_VARIANT_PER_SKU)) {
      return {
        ok: false,
        reason: "sku-taken",
        detail: `A Variant already carries the SKU ${JSON.stringify(changes.sku)}. A SKU identifies one Variant, so it cannot name two.`,
      };
    }
    throw cause;
  }
}

/** The unique constraint that makes a SKU name one Variant — see `db/schema.ts`. */
const ONE_VARIANT_PER_SKU = "core_variant_sku_unique";

function noSuchVariant(variantId: string): VariantUpdate {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists, so there is nothing to correct.`,
  };
}
