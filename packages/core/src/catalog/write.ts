import type { Database } from "../db/client.ts";
import { price, product, variant } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  DEFAULT_FULFILMENT_STRATEGY,
  type FulfilmentStrategies,
  fulfilmentStrategyFor,
  fulfilmentStrategyNames,
} from "../fulfilment/strategy.ts";
import { asMetadata, isJsonObject, metadataDetail, trimmed } from "../input.ts";
import { text } from "../patch.ts";
import { readStore } from "../store/read.ts";
import { handleField, handleTaken, noHandleToPropose, proposeHandle } from "./handle.ts";
import { lockProduct, lockVariant } from "./lock.ts";
import {
  type Price,
  type ProductDetail,
  readProduct,
  readVariants,
  type Variant,
} from "./read.ts";

/**
 * Changing the catalog: creating a Product, adding a Variant to one, and pricing a Variant.
 *
 * Three operations, and the split is ADR-0008 showing through rather than an arbitrary
 * grouping:
 *
 * - **A Product and its first Variant are created together, in one transaction.** There is
 *   no route that creates a Product alone, so a Product with no Variant is not a state this
 *   API can produce — not "discouraged", not "cleaned up later", unreachable. That is what
 *   makes "there is always exactly one sellable thing" a fact the rest of kobai may assume
 *   instead of a case it must handle.
 * - **A later Variant is added to the Product that already exists.** The same request shape,
 *   read by the same code, refused by the same two words — because a second size is one more
 *   row and never a reason to recreate the Product, which would discard every Price and every
 *   stock count under it (#144's loss, arrived at from the other side).
 * - **Pricing is adding a row.** `setPrice` inserts; it never updates a column, and calling
 *   it twice leaves two Prices rather than one overwritten one. This slice creates one per
 *   Variant, and the second one is representable on purpose: a sale price, a second
 *   currency, a quantity break and a Region-constrained price are all that same insert plus
 *   a constraint column, rather than a migration.
 */

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CreateProductInput = {
  readonly title?: unknown;
  readonly description?: unknown;
  readonly handle?: unknown;
  readonly metadata?: unknown;
  readonly variants?: unknown;
};

export type ProductCreation =
  | { readonly ok: true; readonly product: ProductDetail }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "handle-taken"
        | "sku-taken"
        | "unknown-fulfilment-strategy";
      readonly detail: string;
    };

/** Unvalidated, and the same three keys a Variant of a create names. */
export type CreateVariantInput = {
  readonly sku?: unknown;
  readonly fulfilment?: unknown;
  readonly metadata?: unknown;
};

/**
 * Adding a Variant refuses in four ways, and three of them are creation's own words.
 *
 * The fourth is `product-not-found`, which is the whole difference between this and the
 * Variants of a create: there the Product is being made in the same transaction, and here it
 * is a row that has to still be there when this one is written.
 */
export type VariantCreation =
  | { readonly ok: true; readonly variant: Variant }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "product-not-found"
        | "sku-taken"
        | "unknown-fulfilment-strategy";
      readonly detail: string;
    };

export type SetPriceInput = {
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly metadata?: unknown;
};

export type PriceCreation =
  | { readonly ok: true; readonly price: Price }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "unsupported-currency" | "variant-not-found";
      readonly detail: string;
    };

/**
 * Creates a Product together with the Variants that make it sellable.
 *
 * At least one Variant is required. A Product with no options is not the exception to that —
 * it is the ordinary case, and it gets exactly one Variant like everything else, which is
 * precisely the special case ADR-0008 spends a row to avoid.
 */
export async function createProduct(
  db: Database,
  input: CreateProductInput,
  strategies: FulfilmentStrategies,
): Promise<ProductCreation> {
  const title = trimmed(input.title);
  if (title === undefined) {
    return {
      ok: false,
      reason: "invalid",
      detail: "`title` must be a non-empty string.",
    };
  }

  // Absent is `null` and not `""`: a Product created without copy has none, which is a
  // different fact from one whose copy is an empty string. Anything else goes through the very
  // narrowing `PATCH /admin/products/{id}` reads the same field with, so the same mistake is
  // refused in the same words whichever route a Merchant made it on.
  let description: string | null = null;
  if (input.description !== undefined) {
    const written = text("description")(input.description);
    if (!written.ok) return written;
    description = written.value;
  }

  // Proposed from the title where the body named none, and taken as given where it did — which
  // is the whole of story 3 and story 2 in three lines. The proposal is a convenience and never
  // a correction: a `handle` a Merchant did name goes through the same narrowing
  // `PATCH /admin/products/{id}` reads it with, so what may be created can be corrected to.
  let handle: string;
  if (input.handle === undefined) {
    const proposed = proposeHandle(title);
    if (proposed === undefined) return noHandleToPropose(title);
    handle = proposed;
  } else {
    const asked = handleField(input.handle);
    if (!asked.ok) return asked;
    handle = asked.value;
  }

  const metadata = asMetadata(input.metadata);
  if (metadata === undefined) {
    return { ok: false, reason: "invalid", detail: metadataDetail("`metadata`") };
  }

  const variants = parseVariants(input.variants);
  if (!variants.ok) return variants;

  // Refused at the moment of the mistake rather than at the first Order for it. A Variant
  // pointing at a Strategy this deployment has not wired is one nothing can answer the three
  // questions about, so it is a Variant that cannot be sold — and creating it anyway would put
  // the failure a week away from the line that caused it. Installing a Plugin is not what wires
  // its Strategy; a line of `kobai.config.ts` is (ADR-0017).
  const unwired = variants.value.find(
    (row) => !fulfilmentStrategyFor(strategies, row.fulfilmentStrategy),
  );
  if (unwired) return unknownFulfilmentStrategy(strategies, unwired.fulfilmentStrategy);

  let productId: string;
  try {
    productId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(product)
        .values({ title, description, handle, metadata })
        // The unique constraint is the check, and this is how its answer is read — exactly as
        // the SKUs below read theirs. A `select` for the handle and then an `insert` would let
        // two requests offering the same address both find nothing, and the loser would surface
        // as a 500 rather than as the conflict it is (ADR-0018).
        .onConflictDoNothing({ target: product.handle })
        .returning({ id: product.id });
      // Nothing else about this insert can decline it, so no row back *is* the conflict. It
      // throws for the Variants' reason one statement down: a Product half created is the
      // zero-Variant state this whole function exists to prevent.
      if (!created) throw new HandleTaken(handle);

      const inserted = await tx
        .insert(variant)
        .values(
          variants.value.map((row) => ({
            productId: created.id,
            sku: row.sku,
            fulfilmentStrategy: row.fulfilmentStrategy,
            metadata: row.metadata,
          })),
        )
        // The unique index on `sku` is the check, and this is how its answer is read. A
        // select-then-insert would let two requests offering the same SKU both find nothing,
        // and the loser would surface as a 500 rather than as the conflict it is.
        .onConflictDoNothing({ target: variant.sku })
        .returning({ sku: variant.sku });

      if (inserted.length !== variants.value.length) {
        const kept = new Set(inserted.map((row) => row.sku));
        // Rolls the Product back with it: a half-created Product — one whose Variants were
        // refused — is the zero-Variant state this whole function exists to prevent.
        throw new SkuTaken(
          variants.value.map((row) => row.sku).filter((sku) => !kept.has(sku)),
        );
      }

      return created.id;
    });
  } catch (cause) {
    if (cause instanceof HandleTaken) return handleTaken(cause.handle);
    if (cause instanceof SkuTaken) return skuTaken(cause.skus);
    throw cause;
  }

  // Read back rather than assemble the answer from what went in, so what a create reports is
  // the same bytes a subsequent read reports — same columns, same Variant order, produced by
  // the same code. Sorting the inserted rows here instead would sort them in JavaScript,
  // which compares UTF-16 code units while Postgres compares by collation, and two orders
  // for one list is one order too many.
  const created = await readProduct(db, productId);
  if (!created) throw new Error("A Product was created and could not be read back.");
  return { ok: true, product: created };
}

/**
 * Adds a Variant to a Product that already exists.
 *
 * **The Product is what this addresses**, because a Variant is a Variant *of* something: it
 * carries the foreign key, and there is no other way to say which Product a new one belongs
 * to. It answers with the Variant rather than with the whole Product for the reason
 * `setPrice` answers with the Price — the caller addressed the parent and made one child, and
 * the child is what it does not already have.
 *
 * **It refuses exactly what creating a Variant inside `createProduct` refuses**, because it is
 * the same request shape read by the same code: a SKU another Variant carries (`sku-taken`)
 * and a Strategy this deployment has not wired (`unknown-fulfilment-strategy`). Nothing about
 * *when* a Variant is made changes what a Variant may say, so no reason was added to the
 * promised surface for this route (ADR-0060).
 */
export async function addVariant(
  db: Database,
  productId: string,
  input: CreateVariantInput,
  strategies: FulfilmentStrategies,
): Promise<VariantCreation> {
  const parsed = parseVariant(input, "");
  if (!parsed.ok) return parsed;

  // The same question `createProduct` asks about every Variant of a create, at the same point
  // in the request and for the same reason: a Variant pointing at a Strategy nothing has wired
  // cannot be sold, so it must not be possible to *arrive* at one here either (ADR-0014).
  if (!fulfilmentStrategyFor(strategies, parsed.value.fulfilmentStrategy)) {
    return unknownFulfilmentStrategy(strategies, parsed.value.fulfilmentStrategy);
  }

  // Asked after the body and before the database, exactly as `setPrice` asks it: a request
  // that is wrong in itself is wrong whatever the Store holds.
  if (!isUuid(productId)) return noSuchProduct(productId);

  return db.transaction(async (tx) => {
    // **Held**, not merely read. The row inserted below references this Product, and one
    // deleted in between would make that a foreign-key violation and a 500 — a broken server
    // reported for what is only a Product no longer there. `lock.ts` is what the lock is and
    // what order these rows are taken in; this is the only row this operation locks.
    if (!(await lockProduct(tx, productId))) return noSuchProduct(productId);

    const [created] = await tx
      .insert(variant)
      .values({
        productId,
        sku: parsed.value.sku,
        fulfilmentStrategy: parsed.value.fulfilmentStrategy,
        metadata: parsed.value.metadata,
      })
      // The unique index is the check, exactly as it is for a create: a select-then-insert
      // would let two requests offering the same SKU both find nothing, and the loser would
      // surface as a 500 rather than as the conflict it is (ADR-0018).
      .onConflictDoNothing({ target: variant.sku })
      .returning({ id: variant.id });
    // Nothing was written, so there is nothing to roll back and this needs no throw — the
    // shape `createProduct` needs only because a refused Variant has to take a Product with it.
    if (!created) return skuTaken([parsed.value.sku]);

    // Read back rather than assembled from what went in, so what this answers is what a read
    // of the Product answers — `createProduct`'s property, and the reason this asks the one
    // function that says what a Variant looks like. **Inside the transaction**, for
    // `updateVariant`'s reason: a `DELETE` landing between the two statements would otherwise
    // find nothing to read back and answer 500 on a write that succeeded.
    const added = (await readVariants(tx, productId)).find(
      (row) => row.id === created.id,
    );
    if (!added) throw new Error("A Variant was added and could not be read back.");
    return { ok: true, variant: added } as const;
  });
}

/**
 * Adds a Price to a Variant.
 *
 * The currency must be the Store's default, and defaults to it when the caller says nothing.
 * That is narrower than the column allows on purpose: the row can hold any currency, which
 * is the shape ADR-0008 asks for, but multi-currency pricing is out of this slice's scope
 * and there is no rule yet for choosing between two Prices in different currencies. Storing
 * one anyway would be inventing that rule by accident, in the one place it is expensive to
 * be wrong. Relaxing this check when Regions arrive costs nothing; rows written under no
 * rule at all would have to be reinterpreted.
 */
export async function setPrice(
  db: Database,
  variantId: string,
  input: SetPriceInput,
): Promise<PriceCreation> {
  const amount = input.amount;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
    return {
      ok: false,
      reason: "invalid",
      detail:
        "`amount` must be a non-negative whole number of the currency's minor units — 1250 for USD 12.50.",
    };
  }

  const metadata = asMetadata(input.metadata);
  if (metadata === undefined) {
    return { ok: false, reason: "invalid", detail: metadataDetail("`metadata`") };
  }

  if (input.currency !== undefined && typeof input.currency !== "string") {
    return {
      ok: false,
      reason: "invalid",
      detail: '`currency` must be an ISO 4217 code, e.g. "USD".',
    };
  }
  const asked = input.currency?.trim().toUpperCase();

  if (!isUuid(variantId)) return notThatVariant(variantId);

  const store = await readStore(db);
  if (!store) {
    throw new Error(
      "No Store exists, so there is no default currency to price against. The database is migrated but unseeded.",
    );
  }

  return db.transaction(async (tx) => {
    // Looked up before the currency is judged, because "there is no such Variant" is the
    // more fundamental answer — a caller told only that the currency is wrong would fix it
    // and then be told the Variant does not exist.
    //
    // **Held**, not merely read: the Price inserted below references this Variant, and one
    // deleted in between would make that a foreign-key violation and a 500 — a broken server
    // reported for something that is only a Variant no longer there. `lock.ts` is what the
    // lock is and what order these rows are taken in; this is the only Variant row `setPrice`
    // touches, and it takes no other lock at all.
    if (!(await lockVariant(tx, variantId))) return notThatVariant(variantId);

    const currency = asked ?? store.defaultCurrency;
    if (currency !== store.defaultCurrency) {
      return {
        ok: false,
        reason: "unsupported-currency",
        detail: `This Store prices in ${store.defaultCurrency}. A Price in another currency belongs to a Region, and Regions are not in this Store yet.`,
      } as const;
    }

    const [created] = await tx
      .insert(price)
      .values({ variantId, amount, currency, metadata })
      .returning({
        id: price.id,
        amount: price.amount,
        currency: price.currency,
        metadata: price.metadata,
      });
    if (!created) throw new Error("Inserting a Price returned no row.");

    return { ok: true, price: created } as const;
  });
}

/**
 * What a request naming a SKU somebody else carries is told — creating a Product, and adding
 * a Variant to one.
 *
 * One sentence for both, because it is one fact about the Store: a SKU identifies one Variant.
 * A create can name several at once and this one can name one, which is why it takes a list.
 */
function skuTaken(skus: readonly string[]) {
  return {
    ok: false,
    reason: "sku-taken",
    detail: `A Variant already carries the SKU ${skus.map((sku) => JSON.stringify(sku)).join(", ")}. A SKU identifies one Variant, so it cannot name two.`,
  } as const;
}

function noSuchProduct(productId: string): VariantCreation {
  return {
    ok: false,
    reason: "product-not-found",
    detail: `No Product ${JSON.stringify(productId)} exists, so there is nothing to add a Variant to.`,
  };
}

function notThatVariant(variantId: string): PriceCreation {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists. A Price is set on the Variant, which is the sellable thing, and never on the Product.`,
  };
}

/** Thrown inside the transaction so the Variants go back with the Product that was refused. */
class HandleTaken extends Error {
  readonly handle: string;

  constructor(handle: string) {
    super(`Handle already taken: ${handle}`);
    this.handle = handle;
  }
}

/** Thrown inside the transaction so the Product goes back with the Variants that failed. */
class SkuTaken extends Error {
  readonly skus: readonly string[];

  constructor(skus: readonly string[]) {
    super(`SKUs already taken: ${skus.join(", ")}`);
    this.skus = skus;
  }
}

type ParsedVariant = {
  readonly sku: string;
  /**
   * The Strategy this Variant is delivered by, **by name** — `physical` unless it said.
   *
   * Named for the column rather than for the request's `fulfilment` key, because a bare name and
   * the `{ strategy }` object the body carries are two different things and this is the first.
   */
  readonly fulfilmentStrategy: string;
  readonly metadata: Record<string, unknown>;
};

type ParsedVariants =
  | { readonly ok: true; readonly value: readonly ParsedVariant[] }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

function parseVariants(value: unknown): ParsedVariants {
  const invalid = (detail: string) => ({ ok: false, reason: "invalid", detail }) as const;

  if (!Array.isArray(value) || value.length === 0) {
    // Not a defaulted-to-one-anonymous-Variant, because a Variant with no SKU is a Variant
    // nobody can identify, and story 20 wants one they can.
    return invalid(
      "`variants` must list at least one Variant, each with a `sku`. Every Product has at least one Variant — a Product with no options at all still has exactly one.",
    );
  }

  const parsed: ParsedVariant[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return invalid("Each entry in `variants` must be an object with a `sku`.");
    }

    const one = parseVariant(entry, "Each Variant's ");
    if (!one.ok) return one;

    // The one question a list asks and a single Variant cannot: two entries naming one SKU
    // would otherwise be refused by the unique index as `sku-taken`, which is the wrong word
    // for a request that conflicts with itself rather than with the Store.
    if (seen.has(one.value.sku)) {
      return invalid(
        `\`variants\` names the SKU ${JSON.stringify(one.value.sku)} twice. A SKU identifies one Variant.`,
      );
    }
    seen.add(one.value.sku);

    parsed.push(one.value);
  }

  return { ok: true, value: parsed };
}

type ParsedOneVariant =
  | { readonly ok: true; readonly value: ParsedVariant }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

/**
 * One Variant, out of whichever body it arrived in.
 *
 * **One reading rather than two**, for the reason `parseFulfilment` is exported: a Variant
 * added to an existing Product and a Variant named inside a create are the same three fields,
 * so they must not be able to come to different judgements about the same body. `possessive`
 * is the only difference — a create names a list and has to say *which* entry is wrong, and a
 * body that is one Variant says `sku` plainly.
 */
function parseVariant(
  entry: Record<string, unknown>,
  possessive: "" | "Each Variant's ",
): ParsedOneVariant {
  const invalid = (detail: string) => ({ ok: false, reason: "invalid", detail }) as const;

  const sku = trimmed(entry.sku);
  if (sku === undefined) {
    return invalid(`${possessive}\`sku\` must be a non-empty string.`);
  }

  const metadata = asMetadata(entry.metadata);
  if (metadata === undefined) return invalid(metadataDetail(`${possessive}\`metadata\``));

  // Read out of the body here; whether this deployment *has* that Strategy is asked once,
  // against the wired set, by the caller. A name and not an enum, because the set is open
  // (ADR-0014) — a schema listing Core's two would be exactly the closed set it rules out.
  const fulfilment = parseFulfilment(entry.fulfilment, `${possessive}\`fulfilment\``);
  if (!fulfilment.ok) return fulfilment;

  return { ok: true, value: { sku, fulfilmentStrategy: fulfilment.value, metadata } };
}

type ParsedFulfilment =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

/**
 * The Strategy a Variant points at, read out of the `fulfilment` object a request carries —
 * or `physical` when it carried none, which only a create may mean.
 *
 * `{ strategy: … }` rather than a bare name, so that the next thing a Variant needs to say
 * about how it is fulfilled goes beside it instead of forcing this field's shape after the
 * fact — the same reason `payments` and `session` are keys holding a subject (ADR-0050).
 *
 * **Exported for `catalog/update.ts`**, which reads the same object out of a different body:
 * one shape read one way, so a correction cannot come to a different judgement about a
 * `fulfilment` than the create that would have been written instead. `field` is how it says
 * which body it is reading — a create names a list of Variants and an update names one — and
 * it is the only difference between the two readings. **An update calls this only when the key
 * is present**, because there the default above would mean silently making a download a poster
 * again.
 */
export function parseFulfilment(value: unknown, field: string): ParsedFulfilment {
  if (value === undefined) return { ok: true, value: DEFAULT_FULFILMENT_STRATEGY };

  if (!isJsonObject(value)) {
    return {
      ok: false,
      reason: "invalid",
      detail: `${field} must be an object naming a Strategy, e.g. { "strategy": "digital" }.`,
    };
  }

  const strategy = trimmed(value.strategy);
  if (strategy === undefined) {
    return {
      ok: false,
      reason: "invalid",
      detail: `${field} must name a Strategy: its \`strategy\` must be a non-empty string.`,
    };
  }

  return { ok: true, value: strategy };
}

/**
 * What a Variant pointing at a Strategy this deployment has not wired is told — wherever it is
 * said, which is creating one and correcting one to it.
 *
 * One sentence rather than two, because it is one fact about the Store rather than about the
 * route: installing a Plugin is not what wires its Strategy, a line of `kobai.config.ts` is
 * (ADR-0017), and a Merchant told that in two different ways would reasonably wonder whether
 * they were two different problems.
 */
export function unknownFulfilmentStrategy(
  strategies: FulfilmentStrategies,
  strategy: string,
) {
  return {
    ok: false,
    reason: "unknown-fulfilment-strategy",
    detail: `This deployment has no Fulfilment Strategy called ${JSON.stringify(strategy)}. It has ${fulfilmentStrategyNames(
      strategies,
    )
      .map((name) => JSON.stringify(name))
      .join(
        ", ",
      )} — Core ships \`physical\` and \`digital\`, and a Plugin's is wired under \`fulfilment.strategies\` in this Project's \`kobai.config.ts\`.`,
  } as const;
}
