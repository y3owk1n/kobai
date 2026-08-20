import { eq } from "drizzle-orm";
import type { Database, Transaction } from "../db/client.ts";
import { violatesUniqueIndex } from "../db/errors.ts";
import { product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type FulfilmentStrategies,
  fulfilmentStrategyFor,
} from "../fulfilment/strategy.ts";
import type { MediaStorage } from "../media/storage.ts";
import { changesFrom, changesNothing, type Field, openData, text } from "../patch.ts";
import { handleField, handleTaken } from "./handle.ts";
import { lockProduct, lockVariant } from "./lock.ts";
import {
  lockMediaOf,
  mediaThisStoreDoesNotHave,
  parseMediaAttachments,
  readProductMedia,
  setProductMedia,
  setVariantMedia,
} from "./media.ts";
import {
  correctProductOptions,
  lockProductOptions,
  type ProductOption,
  parseOptionCorrections,
  parseOptionValues,
  readProductOptions,
  replaceVariantOptionValues,
  variantOptionsMismatch,
} from "./options.ts";
import { type Product, type ProductDetail, readVariants, type Variant } from "./read.ts";
import { type ProductStatus, productStatusField } from "./status.ts";
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
 * **Almost nothing here is refused that creation would allow**: `sku-taken` and
 * `unknown-fulfilment-strategy` are creation's own words, which is deliberate under ADR-0060 —
 * a client that already branches on the catalog family's set needed no new arm the day this
 * route shipped. The one word both corrections added is `media-not-found`, and it is here rather
 * than at a create for the reason `catalog/media.ts` gives: Media is attached to a Product or a
 * Variant that already exists, because the bytes go up at a route of their own first.
 */

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type UpdateProductInput = {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly handle?: unknown;
  readonly status?: unknown;
  readonly options?: unknown;
  readonly media?: unknown;
  readonly metadata?: unknown;
};

/**
 * Correcting a Product refuses four ways, and the last two are about the state of the Store.
 *
 * There is no `title-taken` and there is not going to be one: a title is what a Product is
 * called, not what identifies it, and two Products may perfectly well share one. The **handle**
 * is the Product's identifying string, and it is the one with a unique constraint behind it —
 * which is why `handle-taken` is here and is creation's own word, exactly as `sku-taken` is the
 * Variant's on both routes (ADR-0060).
 *
 * A handle is corrected rather than fixed for ever, because a Merchant who accepted a proposed
 * one and then thought better of it has nowhere else to go — and it is the remedy the backfill
 * in `0037` points at for a Product it had to number.
 *
 * **`media-not-found` is the fourth**, and it is the byte route's own word said about the same
 * fact from the other end: `media` names an asset this Store has none of. It is 422 rather than
 * 400 — the body is well formed and the Store is what refuses it — and rather than 404, which
 * belongs to the Product this request addressed and found.
 */
export type ProductUpdate =
  | { readonly ok: true; readonly product: ProductDetail }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "product-not-found"
        | "handle-taken"
        | "media-not-found";
      readonly detail: string;
    };

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type UpdateVariantInput = {
  readonly sku?: unknown;
  readonly fulfilment?: unknown;
  readonly options?: unknown;
  readonly media?: unknown;
  readonly metadata?: unknown;
};

/**
 * The columns of a Product a body may correct, of which it names some.
 *
 * Named because two things now read it: {@link changesFrom} fills it, and
 * {@link correctProductColumns} takes what it filled. `options` is deliberately not in it — the
 * options are rows rather than a column, so there is nothing here for a `set` to be given.
 */
type ProductColumns = {
  title: string;
  description: string | null;
  handle: string;
  status: ProductStatus;
  metadata: Record<string, unknown>;
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
 * Correcting a Variant refuses six ways, and only `media-not-found` is not a word creation
 * already answers with — because only Media is attached to a Variant that already exists.
 */
export type VariantUpdate =
  | { readonly ok: true; readonly variant: Variant }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "variant-not-found"
        | "sku-taken"
        | "unknown-fulfilment-strategy"
        | "variant-options-mismatch"
        | "media-not-found";
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
 * **One statement decides the columns, and the options are the one thing here that needs a
 * lock.** Existence is what the `update` answers and uniqueness is what the constraint on
 * `handle` answers, so a body naming only columns is as lock-free as it ever was. A body naming
 * `options` is not: it reads the list this Product has and writes the list it should have, and
 * two of those landing at once would each write over what the other had read — so it holds the
 * Product `for share` first, which is `lock.ts`'s head of chain and ADR-0018's other answer.
 * The transaction is for the read back either way, so what this answers is the Product this
 * write left rather than whatever the next request leaves between two statements.
 *
 * **`options` is the whole list, in the order it should end up in.** An entry carrying an `id`
 * is the option that already has it — renamed, moved, or both, and its Variants' answers stay
 * attached to it, which is the reason identity is on the wire at all. One without an `id` is a
 * new option, and one this Product has that the list does not name is removed with every
 * Variant's answer to it. **Adding an option leaves the Variants under it unanswered**, and
 * that is deliberate: judging them here would refuse the correction for every Variant at once
 * with the only remedy being to rebuild the Product, and a refusal whose advice names no
 * reachable control is a finding rather than something to word around. Correcting each Variant
 * is what ends it, and `catalog/options.ts` is where the whole argument lives.
 *
 * **Its Variants are not this route's business** otherwise, in either direction: it neither
 * creates one (`POST /admin/products/{id}/variants` does) nor touches the ones that are there.
 * A `variants` key in the body is stripped by the schema and so arrives as a body naming
 * nothing, which is exactly what the refusal below is for.
 */
export async function updateProduct(
  db: Database,
  storage: MediaStorage,
  productId: string,
  input: UpdateProductInput,
): Promise<ProductUpdate> {
  const usable = changesFrom<ProductColumns>(
    {
      title: input.title,
      description: input.description,
      handle: input.handle,
      status: input.status,
      metadata: input.metadata,
    },
    {
      title: text("title"),
      description: clearableDescription,
      // Creation's own narrowing, so a handle a Merchant could have created this Product with
      // is one they can correct it to. There is deliberately no `null` here as there is for the
      // description beside it: a Product with no address is not a state that exists.
      handle: handleField,
      // **This is where a Product is published and where it is archived**, and it is an ordinary
      // field of an ordinary correction rather than two routes of its own. Publishing is a
      // decision (story 6) and archiving is a decision (story 7); what makes them one field is
      // that they are the same decision asked twice, and a `POST …/publish` beside a
      // `POST …/archive` would be two more paths promised for ever (ADR-0060) saying what
      // `status` already says. There is no `null` here either: a Product with no status is not a
      // state kobai has.
      status: productStatusField,
      metadata: openData("metadata"),
    },
    // No `whenNothing`, because `options` is not a column and so is not one of these — a body
    // naming only that one has named something, and the emptiness question is asked below once
    // both halves have been read. `updateStore` waits for the same reason from the other side.
  );
  if (!usable.ok) return usable;
  const changes = usable.changes;

  // Read here rather than through `changesFrom`, because these are rows rather than a column:
  // what comes back is not a value to `set` but a list to reconcile against the one stored.
  const options =
    input.options === undefined ? undefined : parseOptionCorrections(input.options);
  if (options !== undefined && !options.ok) return options;

  // The same, one table along: `media` is the whole list of what this Product shows, in the
  // order it should be shown in, so attaching, reordering and detaching are all this one field.
  const shown =
    input.media === undefined ? undefined : parseMediaAttachments(input.media);
  if (shown !== undefined && !shown.ok) return shown;

  // The judgement `updateVariant` makes and `cart/write.ts`'s two `PATCH`es made first, said
  // in one place since #185. It does a second job here — the schema strips a field this route
  // does not carry, so a body naming `variants` is this body, and the refusal is where a
  // Merchant who tried to add one is told which route adds one.
  if (Object.keys(changes).length === 0 && options === undefined && shown === undefined) {
    return changesNothing(
      "a `title`, a `description`, a `handle`, a `status`, an `options`, a `media`, a `metadata`, or any of them",
      "A Variant is not changed here: add one with `POST /admin/products/{id}/variants`, correct one with `PATCH /admin/variants/{id}`, and remove one with `DELETE /admin/variants/{id}`.",
    );
  }

  if (!isUuid(productId)) return noSuchProduct(productId);

  try {
    return await db.transaction(async (tx) => {
      // **The advisory locks first and the row lock after them.** Each of the two is taken only
      // where the body asked for it — the options and the Media are two lists corrected by two
      // fields, and a Merchant renaming an option must not wait behind one reordering pictures
      // on a different Product. The row lock underneath is taken once for either, because it
      // answers one question for both: the rows written below reference this Product, and one
      // deleted in between would be a foreign-key violation and a 500 on a route that declares a
      // 404. **Both advisory keys before the row lock**, and in this order every time, so two
      // requests naming both lists cannot each hold the key the other is waiting for.
      if (options !== undefined) await lockProductOptions(tx, productId);
      if (shown !== undefined) await lockMediaOf(tx, productId);
      if (options !== undefined || shown !== undefined) {
        if (!(await lockProduct(tx, productId))) return noSuchProduct(productId);
      }

      // **Every judgement this request makes, before the first write it makes.** A refusal
      // *returned* from inside a transaction commits it, so a `media` judged after the options
      // had been corrected would answer 422 over a Product whose options really had been
      // renamed — which is why `catalog/media.ts` exports the question apart from the write.
      if (shown !== undefined) {
        const missing = await mediaThisStoreDoesNotHave(tx, shown.value);
        if (missing) return missing;
      }

      if (options !== undefined) {
        // The advisory lock is what serialises corrections of *this Product's* option list
        // against each other, because the condition is about other rows and a `select` does not
        // lock those — a row lock cannot stand in for it, and `lockProductOptions` is where that
        // is argued at length.
        const corrected = await correctProductOptions(tx, productId, options.value);
        // Every judgement it makes comes before every write it makes, so a refusal leaves the
        // Product exactly as it was and needs no throw to unwind anything.
        if (!corrected.ok) return corrected;
      }

      // Detaching is what an entry left out of this list *is*, and what it removes is the
      // attachment rather than the Media: the asset stays in the Store's library and may still
      // be showing on another Product (ADR-0082).
      if (shown !== undefined) await setProductMedia(tx, productId, shown.value);

      const row = await correctProductColumns(tx, productId, changes);
      if (!row) return noSuchProduct(productId);

      // The options and the Variants are read back rather than left out, so this answers what
      // `GET /admin/products/{id}` answers — one shape for a Product opened, whether it was just
      // corrected or merely looked at.
      return {
        ok: true,
        product: {
          ...row,
          media: (await readProductMedia(tx, storage, [productId])).get(productId) ?? [],
          options: await readProductOptions(tx, productId),
          variants: await readVariants(tx, storage, productId),
        },
      } as const;
    });
  } catch (cause) {
    // The unique constraint is the check, and this is how its answer is read — `updateVariant`'s
    // mechanism one table up, in the one form an `update` has: Postgres offers no `on conflict`
    // here, so the loser of two simultaneous corrections finds out by being thrown at. A
    // select-then-update would let both pass and surface as a 500 rather than as the conflict it
    // is (ADR-0018).
    //
    // Read out here rather than inside the transaction: a statement Postgres refused has already
    // aborted it, so a refusal decided in there would be returned from a transaction that can no
    // longer run anything.
    // `changes.handle` is asked first to narrow it rather than to condition the refusal: this
    // constraint is the only one on the table, so a body that named no handle cannot have
    // violated it, and if one somehow did the error travels as itself.
    if (
      changes.handle !== undefined &&
      violatesUniqueIndex(cause, ONE_PRODUCT_PER_HANDLE)
    ) {
      return handleTaken(changes.handle);
    }
    throw cause;
  }
}

/**
 * The Product's own columns, corrected — or read exactly as they stand where none was named.
 *
 * **Two statements for one job, because a body may now correct a Product without naming a single
 * column of it**: `options` is rows, so `{ options: [...] }` leaves `changes` empty, and
 * `set({})` is not a statement Drizzle will build. Reading instead is what makes such a request
 * answer with the whole Product rather than with less for having asked for less — and it is a
 * read inside the transaction that has already held the row, so it is the Product this write
 * left rather than whatever the next request leaves between two statements.
 *
 * `undefined` is "no such Product", from whichever of the two asked.
 *
 * It answers the Product **without its Media**, which is the one field of that shape that is
 * rows rather than a column: the caller reads those back beside the options and the Variants,
 * from the same transaction and in the same breath.
 */
async function correctProductColumns(
  tx: Transaction,
  productId: string,
  changes: Partial<ProductColumns>,
): Promise<Omit<Product, "media"> | undefined> {
  const columns = {
    id: product.id,
    title: product.title,
    description: product.description,
    handle: product.handle,
    status: product.status,
    metadata: product.metadata,
  } as const;

  if (Object.keys(changes).length === 0) {
    const [found] = await tx
      .select(columns)
      .from(product)
      .where(eq(product.id, productId))
      .limit(1);
    return found;
  }

  const [updated] = await tx
    .update(product)
    .set(changes)
    .where(eq(product.id, productId))
    .returning(columns);
  return updated;
}

/** The unique constraint that makes a handle name one Product — see `db/schema.ts`. */
const ONE_PRODUCT_PER_HANDLE = "core_product_handle_unique";

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
 * **A body naming only columns still decides everything in one statement, and takes no lock of
 * its own** (ADR-0018). Existence is answered by the `update` itself — nothing came back, so
 * there is no such Variant — and a SKU another Variant holds is answered by the unique index,
 * which is the same check `createProduct` reads off an `onConflictDoNothing`. There is nothing
 * there for a `select` to have found out first.
 *
 * **A body naming `options` is the field that needed a second row, which `lock.ts` said would
 * have to settle the ordering before it was written.** The values are judged against the
 * options this Variant's *Product* declares and are then written as rows pointing at them, so
 * two statements have to be one operation: a Product's options corrected in between would make
 * the second a foreign-key violation and a 500 on a route that declares a 404. It takes
 * `core_product` and then `core_variant`, in that order and both `for share`, which is the
 * chain at the head of `lock.ts` and the order every other site in this repository takes them
 * in. The Product is found by a plain read of `product_id` first, which is safe because no
 * route moves a Variant between Products — and both locks then answer whether the two rows are
 * still there.
 *
 * The transaction is for the **read back** either way: it makes the Variant this answers with
 * the row this write left, rather than whatever the next request leaves between two statements.
 */
export async function updateVariant(
  db: Database,
  storage: MediaStorage,
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
    // No `whenNothing`, for `updateProduct`'s reason: `options` is rows rather than a column,
    // so a body naming only that one has named something and the emptiness question waits.
  );
  if (!usable.ok) return usable;
  const changes = usable.changes;

  // Creation's own reading of the same field, so a Variant's values are judged the same way
  // whichever route wrote them. *Which* options they must be is asked below, against the
  // Product, because that is the half this body does not carry.
  const values =
    input.options === undefined ? undefined : parseOptionValues(input.options, "");
  if (values !== undefined && !values.ok) return values;

  // What this Variant shows, whole and in order — the field that makes picking Red show the red
  // one (story 10). Read the same way the Product's is, by the same function, because it is the
  // same list of the same Store's assets attached to a different row.
  const shown =
    input.media === undefined ? undefined : parseMediaAttachments(input.media);
  if (shown !== undefined && !shown.ok) return shown;

  // Here the no-op refusal is also the shape a body naming a field this route does not carry
  // collapses to, a Price above all, because the schema strips it before the handler sees it.
  // So the refusal says both halves: what may be changed, and where a Price is set instead.
  if (Object.keys(changes).length === 0 && values === undefined && shown === undefined) {
    return changesNothing(
      "at least one of `sku`, `fulfilment`, `options`, `media` or `metadata`",
      "A Price is not changed here: set another with `POST /admin/variants/{id}/prices`, which supersedes it, and remove the old one with `DELETE /admin/variants/{id}/prices/{priceId}`.",
    );
  }

  // Asked after the body and before the database, exactly as `setPrice` asks it: a request
  // that is wrong in itself is wrong whatever the Store holds, so nothing is looked up to
  // answer it. `delete.ts` asks first because it has no body to be wrong.
  if (!isUuid(variantId)) return noSuchVariant(variantId);

  try {
    return await db.transaction(async (tx) => {
      let productId: string | undefined;
      let declared: readonly ProductOption[] | undefined;

      // **The advisory lock first, then the two row locks**, which is `updateProduct`'s order
      // and every other site's. It is taken only for a body naming `media`, because it is what
      // makes that field's delete-and-insert one operation (`catalog/media.ts`); the row locks
      // are taken for either list, and answer one question for both — are these two rows still
      // there for the rows written below to reference.
      if (shown !== undefined) await lockMediaOf(tx, variantId);

      if (values !== undefined || shown !== undefined) {
        // `product_id` is read plainly and then both rows are held, in `lock.ts`'s order. No
        // route moves a Variant between Products, so the value cannot go stale; what the locks
        // answer is whether the two rows are still there at all.
        const [found] = await tx
          .select({ productId: variant.productId })
          .from(variant)
          .where(eq(variant.id, variantId))
          .limit(1);
        if (!found) return noSuchVariant(variantId);
        if (!(await lockProduct(tx, found.productId))) return noSuchVariant(variantId);
        if (!(await lockVariant(tx, variantId))) return noSuchVariant(variantId);

        productId = found.productId;
      }

      if (values !== undefined) {
        // The branch above sets it for exactly this case, and a missing one would mean skipping
        // a refusal the route declares rather than merely reading nothing — so it is a throw and
        // not a silent `if`.
        if (productId === undefined) {
          throw new Error("A Variant's options were judged against no Product.");
        }
        declared = await readProductOptions(tx, productId);

        // Nothing has been written, so a refusal here leaves the Variant exactly as it was and
        // the transaction is committed rather than unwound.
        const mismatch = variantOptionsMismatch(declared, values.value, "This Variant");
        if (mismatch) return mismatch;
      }

      // **Every judgement before the first write**, which is `updateProduct`'s ordering and is
      // what makes each of these refusals safe to *return*: a refusal returned from inside a
      // transaction commits it.
      if (shown !== undefined) {
        const missing = await mediaThisStoreDoesNotHave(tx, shown.value);
        if (missing) return missing;
      }

      // What a list left short detaches is an attachment and never the Media (ADR-0082).
      if (shown !== undefined) await setVariantMedia(tx, variantId, shown.value);

      if (Object.keys(changes).length > 0) {
        const [updated] = await tx
          .update(variant)
          .set(changes)
          .where(eq(variant.id, variantId))
          .returning({ productId: variant.productId });
        if (!updated) return noSuchVariant(variantId);
        productId = updated.productId;
      }

      if (productId === undefined || (values !== undefined && declared === undefined)) {
        // Unreachable: a body names columns, or it names values, or it was refused above for
        // naming nothing at all — and the values branch sets both of these.
        throw new Error("A Variant was corrected by a request that asked for nothing.");
      }

      if (values !== undefined && declared !== undefined) {
        await replaceVariantOptionValues(tx, variantId, values.value, declared);
      }

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
      const corrected = (await readVariants(tx, storage, productId)).find(
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
