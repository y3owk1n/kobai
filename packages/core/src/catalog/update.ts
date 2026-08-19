import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { violatesUniqueIndex } from "../db/errors.ts";
import { product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type FulfilmentStrategies,
  fulfilmentStrategyFor,
} from "../fulfilment/strategy.ts";
import { changesFrom, changesNothing, type Field, openData, text } from "../patch.ts";
import { type ProductDetail, readVariants, type Variant } from "./read.ts";
import { parseFulfilment, unknownFulfilmentStrategy } from "./write.ts";

/**
 * Correcting a catalog entry in place — a Variant, and the Product it hangs off.
 *
 * **The two are the same shape of question and the Product's is the easier one**, which is why
 * ADR-0062 settled the Variant's four fields and left this beside it: a Product has no SKU, no
 * Strategy and nothing claiming it, so `title` and `metadata` are free to move for the one
 * reason that makes any of this safe — an Order's Line Items snapshot the title they were
 * bought under, so nothing a Shopper or an accountant reads is joined to the row this changes.
 * Both `PATCH`es therefore behave identically: an absent field means "leave it", a named
 * `metadata` is replaced rather than merged, and a body naming nothing is refused.
 *
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
export type UpdateProductInput = {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly metadata?: unknown;
};

/**
 * Correcting a Product refuses in two ways, and neither is new.
 *
 * There is no `title-taken` and there is not going to be one: a title is what a Product is
 * called, not what identifies it, and two Products may perfectly well share one. The SKU on
 * the Variant below is the identifying string, and it is the one with an index behind it.
 */
export type ProductUpdate =
  | { readonly ok: true; readonly product: ProductDetail }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "product-not-found";
      readonly detail: string;
    };

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type UpdateVariantInput = {
  readonly sku?: unknown;
  readonly fulfilment?: unknown;
  readonly metadata?: unknown;
};

/**
 * The columns a body may correct, of which it names some — the **column** names, which is where
 * this differs from {@link UpdateVariantInput} in more than its types: a Variant's Strategy
 * arrives as `fulfilment` and is stored as `fulfilment_strategy`.
 */
type VariantColumns = {
  sku: string;
  fulfilmentStrategy: string;
  metadata: Record<string, unknown>;
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
 * A Product's description: `text`'s ordinary narrowing, plus `null` to take the copy back off.
 *
 * **The only field on this surface a correction may *remove*, and the reason it needs to be.**
 * An absent field means "leave it" (ADR-0062), so a field with no way to say *remove* can be
 * rewritten for ever and never cleared — which is fine for a `title`, where there is no state
 * of having none, and wrong for copy a Merchant wrote by mistake. `""` is refused rather than
 * stored, because that would leave two spellings of "there is no copy here" and a storefront
 * branching on one of them renders an empty paragraph for the other.
 *
 * It composes {@link text} rather than restating it, so the words a Merchant is told when they
 * send a number are the words every other corrected string is refused with. It stays here
 * rather than in `patch.ts` because nothing else wants it yet: a second clearable field is when
 * it moves, and one caller is not a shared helper.
 */
const clearableDescription: Field<string | null> = (value) =>
  value === null ? { ok: true, value: null } : text("description")(value);

/**
 * Changes what this Product says about itself, and leaves its Variants alone.
 *
 * **One statement decides everything, so this takes no lock either** — `updateVariant`'s
 * argument one table up: existence is what the `update` answers, there is no uniqueness to
 * defend, and nothing here is asked of a second row. The transaction is for the read back, so
 * what this answers is the Product this write left rather than whatever the next request
 * leaves between the two statements.
 *
 * **Its Variants are not this route's business**, in either direction: it neither creates one
 * (`POST /admin/products/{id}/variants` does) nor touches the ones that are there. A `variants`
 * key in the body is stripped by the schema and so arrives as a body naming nothing, which is
 * exactly what the refusal below is for.
 */
export async function updateProduct(
  db: Database,
  productId: string,
  input: UpdateProductInput,
): Promise<ProductUpdate> {
  const usable = changesFrom(
    { title: input.title, description: input.description, metadata: input.metadata },
    {
      title: text("title"),
      description: clearableDescription,
      metadata: openData("metadata"),
    },
    // The judgement `updateVariant` makes and `cart/write.ts`'s two `PATCH`es made first, said
    // in one place since #185. It does a second job here — the schema strips a field this route
    // does not carry, so a body naming `variants` is this body, and the refusal is where a
    // Merchant who tried to add one is told which route adds one.
    changesNothing(
      "a `title`, a `description`, a `metadata`, or any of them",
      "A Variant is not changed here: add one with `POST /admin/products/{id}/variants`, correct one with `PATCH /admin/variants/{id}`, and remove one with `DELETE /admin/variants/{id}`.",
    ),
  );
  if (!usable.ok) return usable;
  const changes = usable.changes;

  if (!isUuid(productId)) return noSuchProduct(productId);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(product)
      .set(changes)
      .where(eq(product.id, productId))
      .returning({
        id: product.id,
        title: product.title,
        description: product.description,
        metadata: product.metadata,
      });
    if (!updated) return noSuchProduct(productId);

    // The Variants are read back rather than left out, so this answers what
    // `GET /admin/products/{id}` answers — one shape for a Product opened, whether it was just
    // corrected or merely looked at. `readProduct` is not called because the row is already
    // here, and asking for it again inside the same transaction would be a second read of what
    // this statement just returned.
    return {
      ok: true,
      product: { ...updated, variants: await readVariants(tx, productId) },
    } as const;
  });
}

function noSuchProduct(productId: string): ProductUpdate {
  return {
    ok: false,
    reason: "product-not-found",
    detail: `No Product ${JSON.stringify(productId)} exists, so there is nothing to correct.`,
  };
}

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
  // Keyed by the column and not by the wire, which is what `changesFrom` asks for and why the
  // literal below reads `input.fulfilment` into `fulfilmentStrategy`: the result is the very
  // object the `update` sets.
  const usable = changesFrom<VariantColumns, "unknown-fulfilment-strategy">(
    { sku: input.sku, fulfilmentStrategy: input.fulfilment, metadata: input.metadata },
    {
      sku: text("sku"),
      // Reached only when the key is there — `changesFrom` narrows nothing a body did not name
      // — because absent means "leave it", where on a create the same absence means `physical`.
      // The parse is creation's, so one body shape is read one way.
      fulfilmentStrategy: (value) => {
        const fulfilment = parseFulfilment(value, "`fulfilment`");
        if (!fulfilment.ok) return fulfilment;

        // The same question `createProduct` asks, at the same moment and for the same reason: a
        // Variant pointing at a Strategy this deployment has not wired is one nothing can
        // answer the three questions about, so it cannot be sold — and it is what `place-order`
        // already refuses a purchase over. Repairing that is this route's headline case, so it
        // must not be possible to *arrive* at it here.
        //
        // It is also the one field on this surface that refuses something other than `invalid`,
        // which is what the second type argument above is for: it widens `changesFrom`'s
        // refusal rather than replacing it, so `VariantUpdate` still binds under ADR-0060.
        if (!fulfilmentStrategyFor(strategies, fulfilment.value)) {
          return unknownFulfilmentStrategy(strategies, fulfilment.value);
        }
        return fulfilment;
      },
      metadata: openData("metadata"),
    },
    // Here the no-op refusal is also the shape a body naming a field this route does not carry
    // collapses to, a Price above all, because the schema strips it before the handler sees it.
    // So the refusal says both halves: what may be changed, and where a Price is set instead.
    changesNothing(
      "at least one of `sku`, `fulfilment` or `metadata`",
      "A Price is not changed here: set another with `POST /admin/variants/{id}/prices`, which supersedes it, and remove the old one with `DELETE /admin/variants/{id}/prices/{priceId}`.",
    ),
  );
  if (!usable.ok) return usable;
  const changes = usable.changes;

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
