import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { price, product, variant } from "../db/schema.ts";
import { readStore } from "../store/read.ts";
import { isUuid, type Price, type ProductDetail, readProduct } from "./read.ts";

/**
 * Changing the catalog: creating a Product, and pricing a Variant.
 *
 * Two operations, and the split is ADR-0008 showing through rather than an arbitrary
 * grouping:
 *
 * - **A Product and its first Variant are created together, in one transaction.** There is
 *   no route that creates a Product alone, so a Product with no Variant is not a state this
 *   API can produce — not "discouraged", not "cleaned up later", unreachable. That is what
 *   makes "there is always exactly one sellable thing" a fact the rest of kobai may assume
 *   instead of a case it must handle.
 * - **Pricing is adding a row.** `setPrice` inserts; it never updates a column, and calling
 *   it twice leaves two Prices rather than one overwritten one. This slice creates one per
 *   Variant, and the second one is representable on purpose: a sale price, a second
 *   currency, a quantity break and a Region-constrained price are all that same insert plus
 *   a constraint column, rather than a migration.
 */

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CreateProductInput = {
  readonly title?: unknown;
  readonly metadata?: unknown;
  readonly variants?: unknown;
};

export type ProductCreation =
  | { readonly ok: true; readonly product: ProductDetail }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "sku-taken";
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
): Promise<ProductCreation> {
  const title = trimmed(input.title);
  if (title === undefined) {
    return {
      ok: false,
      reason: "invalid",
      detail: "`title` must be a non-empty string.",
    };
  }

  const metadata = asMetadata(input.metadata);
  if (metadata === undefined) {
    return { ok: false, reason: "invalid", detail: metadataDetail("metadata") };
  }

  const variants = parseVariants(input.variants);
  if (!variants.ok) return variants;

  let productId: string;
  try {
    productId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(product)
        .values({ title, metadata })
        .returning({ id: product.id });
      if (!created) throw new Error("Inserting a Product returned no row.");

      const inserted = await tx
        .insert(variant)
        .values(
          variants.value.map((row) => ({
            productId: created.id,
            sku: row.sku,
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
    if (cause instanceof SkuTaken) {
      return {
        ok: false,
        reason: "sku-taken",
        detail: `A Variant already carries the SKU ${cause.skus.map((sku) => JSON.stringify(sku)).join(", ")}. A SKU identifies one Variant, so it cannot name two.`,
      };
    }
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
    return { ok: false, reason: "invalid", detail: metadataDetail("metadata") };
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
    // `for share` holds the row for the length of the transaction, so a Variant deleted
    // concurrently cannot vanish between this read and the insert below. Without it the
    // race surfaces as a foreign-key violation and a 500, which reports a broken server for
    // something that is only a Variant that is no longer there.
    const [found] = await tx
      .select({ id: variant.id })
      .from(variant)
      .where(eq(variant.id, variantId))
      .for("share")
      .limit(1);
    if (!found) return notThatVariant(variantId);

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
      .values({ variantId: found.id, amount, currency, metadata })
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

function notThatVariant(variantId: string): PriceCreation {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists. A Price is set on the Variant, which is the sellable thing, and never on the Product.`,
  };
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

    const sku = trimmed(entry.sku);
    if (sku === undefined) {
      return invalid("Each Variant's `sku` must be a non-empty string.");
    }
    if (seen.has(sku)) {
      return invalid(
        `\`variants\` names the SKU ${JSON.stringify(sku)} twice. A SKU identifies one Variant.`,
      );
    }
    seen.add(sku);

    const metadata = asMetadata(entry.metadata);
    if (metadata === undefined) {
      return invalid(metadataDetail("Each Variant's `metadata`"));
    }

    parsed.push({ sku, metadata });
  }

  return { ok: true, value: parsed };
}

/** A non-empty string, trimmed, or `undefined` when it is neither. */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result === "" ? undefined : result;
}

/** A JSON object — not an array, not null, not a primitive. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ADR-0004's escape hatch, on the way in: any JSON object, absent meaning `{}`.
 *
 * Nothing is validated beyond "it is an object", which is the point — a shape here would be
 * a promise, and a Plugin that needs a promise needs its own table. `undefined` means the
 * caller sent something that is not an object at all.
 */
function asMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return {};
  return isJsonObject(value) ? value : undefined;
}

function metadataDetail(what: string): string {
  return `${what} must be a JSON object. It is unindexed and untyped by design — anything needing an index or a type needs its own table.`;
}
