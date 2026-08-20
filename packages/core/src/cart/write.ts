import { and, eq, sql } from "drizzle-orm";
import type { ApiKeyKind } from "../auth/api-key.ts";
import { lockVariant } from "../catalog/lock.ts";
import { storeVariantExists } from "../catalog/store-read.ts";
import type { Database, Queryable, Transaction } from "../db/client.ts";
import { cart, cartLineItem, price } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { asMetadata, isJsonObject, metadataDetail, trimmed } from "../input.ts";
import { changesFrom, changesNothing, openData } from "../patch.ts";
import { type Cart, cartHasBeenPlaced, cartHasExpired, readCart } from "./read.ts";

/**
 * Changing a Cart: creating one, attaching a Shopper to it, and its Line Items.
 *
 * Four rules live here, and none of them is in a schema — a rule a client could be told about
 * but Core could no longer change is a rule in the wrong place:
 *
 * - **The same Variant twice is one Line Item with a higher quantity**, and that is a unique
 *   constraint plus an upsert rather than a read followed by a write. Two requests adding the
 *   same Variant at the same instant would otherwise both find nothing and both insert.
 * - **A Variant carrying no Price cannot be selected.** A Store cannot sell what it has not
 *   priced, and finding that out at Capture is finding it out from the Shopper.
 * - **A Shopper reference may be attached only over a secret key** (ADR-0020). A publishable
 *   key is shipped to a browser, so anything it asserted about who the Shopper is would be
 *   asserted by the Shopper.
 * - **An expired Cart refuses every change.** It still reads, so a storefront can say what
 *   happened; and its rows survive, because ADR-0028 makes abandoned cart a Plugin and a
 *   Plugin cannot recover what Core has deleted.
 * - **A Cart that has been placed refuses every change too**, and for a different reason: it is
 *   spent rather than stale. A Cart becomes exactly one Order (#102), and that Order is
 *   immutable — so a change here would change nothing about what was bought, while leaving a
 *   storefront looking at a Cart that appears to still be live.
 *
 * Each function's `reason` is narrowed to the refusals it can actually make, which is what
 * lets each route in `http/store.ts` declare exactly those statuses and no others.
 */

/**
 * How long a Cart is placeable for.
 *
 * A **lifetime** fixed at creation rather than an idle window that activity slides — the
 * distinction ADR-0045 draws for sessions, decided the other way here. "Abandoned" is then
 * measured from when the Cart was made, and no amount of touching one keeps it alive forever.
 *
 * Core's, and not a Project's: nothing in this slice's spec asks a deployment to set it, and a
 * configuration key is an interface promise. Seven days is long enough that a Shopper can come
 * back after a weekend and short enough that "abandoned" means something.
 *
 * **Days rather than minutes, and the spec says minutes.** #98's testing notes pair the Cart
 * expiry with the Reservation hold window as "both measured in minutes" — true of the hold,
 * which spans one attempt at placing an order, and wrong for a Cart, which ADR-0028 wants an
 * abandoned-cart Plugin to be able to act on later. A window a Shopper loses their basket
 * inside of over lunch is not the thing that ADR describes. The scale is the one number here
 * worth reopening; the mechanism does not change with it.
 */
const CART_LIFETIME = "7 days";

/**
 * Every way a Cart operation can be refused.
 *
 * A closed union, so the store surface has to turn each one into a status and cannot forget
 * one — see the `satisfies` maps in `http/store.ts`.
 */
export type CartRefusal =
  | "invalid"
  | "secret-key-required"
  | "cart-not-found"
  | "cart-expired"
  | "cart-placed"
  | "line-item-not-found"
  | "variant-not-found"
  | "variant-not-priced";

/** A refusal, narrowed to the reasons the operation that made it can produce. */
export type CartRefused<Reason extends CartRefusal> = {
  readonly ok: false;
  readonly reason: Reason;
  readonly detail: string;
};

export type CartResult<Reason extends CartRefusal> =
  | { readonly ok: true; readonly cart: Cart }
  | CartRefused<Reason>;

/** Refused before the Cart was even looked for. */
type BadRequest = CartRefused<"invalid">;

/** Refused by {@link mutate}, whatever the operation behind it was. */
type NotChangeable = "cart-not-found" | "cart-expired" | "cart-placed";

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CartInput = {
  readonly shopper?: unknown;
  readonly metadata?: unknown;
};

export type AddLineItemInput = {
  readonly variantId?: unknown;
  readonly quantity?: unknown;
  readonly metadata?: unknown;
};

export type UpdateLineItemInput = {
  readonly quantity?: unknown;
  readonly metadata?: unknown;
};

/** What a line is worth when the caller does not say: one of the thing they selected. */
const DEFAULT_QUANTITY = 1;

/**
 * Creates a Cart.
 *
 * It has no Shopper of any kind unless the caller asserts one, because Core assumes an
 * authenticated Shopper nowhere (ADR-0020) — a guest is not the exception, it is the path.
 */
export async function createCart(
  db: Database,
  input: CartInput,
  /** Which credential this request arrived on; a Shopper may be asserted only over `secret`. */
  keyKind: ApiKeyKind,
): Promise<CartResult<"invalid" | "secret-key-required">> {
  const parsed = parseCartInput(input, keyKind);
  if (!parsed.ok) return parsed;

  const [created] = await db
    .insert(cart)
    .values({
      // In SQL rather than from `Date.now()`, so one clock both sets the deadline and judges
      // it — `read.ts` asks Postgres whether `now()` has passed this value.
      expiresAt: sql`now() + ${CART_LIFETIME}::interval`,
      shopperEmail: parsed.value.shopper?.email ?? null,
      shopperExternalId: parsed.value.shopper?.externalId ?? null,
      metadata: parsed.value.metadata ?? {},
    })
    .returning({ id: cart.id });
  if (!created) throw new Error("Inserting a Cart returned no row.");

  return read(db, created.id);
}

/**
 * Attaches — or detaches — a Shopper, and rewrites the Cart's own open data.
 *
 * The route a storefront calls when a guest signs in half way through: the Cart is already
 * built, and what changes is who it is for. `shopper: null` puts it back to a guest's.
 */
export async function updateCart(
  db: Database,
  cartId: string,
  input: CartInput,
  keyKind: ApiKeyKind,
): Promise<CartResult<"invalid" | "secret-key-required" | NotChangeable>> {
  // Asked of the **keys the body carried** rather than of a narrowed set of changes, which is
  // the one `PATCH` on this surface that does it that way round and is deliberate (#185). A
  // Cart's fields do not narrow into columns one for one: `shopper` is three-valued and fills
  // *two*, and it is read by `parseCartInput`, which `createCart` shares and where an empty
  // result means a guest's Cart rather than a request that asks for nothing. The two orders are
  // indistinguishable to a caller — a body naming nothing is refused either way, and a body
  // naming something unusable reaches its own refusal either way — so what would be bought by
  // forcing the shape is a reading of `shopper` that two routes no longer agree on.
  if (input.shopper === undefined && input.metadata === undefined) {
    return changesNothing("a `shopper`, a `metadata`, or both");
  }

  const parsed = parseCartInput(input, keyKind);
  if (!parsed.ok) return parsed;

  return mutate<never>(db, cartId, async (tx) => {
    // Only what the caller named, so a request about `metadata` alone does not quietly blank
    // the Shopper off the Cart — which is what makes `shopper` three-valued above.
    const changes: Partial<typeof cart.$inferInsert> = {};
    if (parsed.value.shopper !== undefined) {
      changes.shopperEmail = parsed.value.shopper?.email ?? null;
      changes.shopperExternalId = parsed.value.shopper?.externalId ?? null;
    }
    if (parsed.value.metadata !== undefined) changes.metadata = parsed.value.metadata;

    await tx.update(cart).set(changes).where(eq(cart.id, cartId));
    return undefined;
  });
}

/**
 * Adds a Variant to a Cart, or raises the quantity of the line already carrying it.
 *
 * One statement does both. `on conflict (cart_id, variant_id) do update` is the whole of
 * "adding the same Variant twice is one Line Item": the unique index is the check, and reading
 * first to decide between an insert and an update is the version of this that two simultaneous
 * requests both lose.
 */
export async function addLineItem(
  db: Database,
  cartId: string,
  input: AddLineItemInput,
): Promise<
  CartResult<"invalid" | "variant-not-found" | "variant-not-priced" | NotChangeable>
> {
  const variantId = trimmed(input.variantId);
  if (variantId === undefined) {
    return invalid(
      "`variantId` must name the Variant to add. A Variant is the sellable thing; a Product is never sellable in itself (ADR-0008).",
    );
  }

  const quantity = parseQuantity(input.quantity);
  if (!quantity.ok) return quantity;

  const metadata = asMetadata(input.metadata);
  if (metadata === undefined) return invalid(metadataDetail("`metadata`"));

  return mutate<"variant-not-found" | "variant-not-priced">(db, cartId, async (tx) => {
    if (!isUuid(variantId)) return noSuchVariant(variantId);

    // **Held**, not merely read: the Line Item written below references this Variant, and one
    // deleted in between would make that a foreign-key violation and a 500 — a broken server
    // reported for a Variant that is simply no longer there. `catalog/lock.ts` is what the
    // lock is and what order these rows are taken in; a Cart write holds no Product row and
    // no Inventory row, so this is the only one this transaction takes.
    if (!(await lockVariant(tx, variantId))) return noSuchVariant(variantId);

    // **And whether a Shopper may select it at all** (#276). A Variant carries no status of its
    // own — whether it is on the storefront is its Product's answer — so this is the store
    // catalog's question rather than the Cart's, and it is asked of the module that owns it:
    // `GET /store/variants/{id}` and this route must not disagree about whether there is such a
    // Variant, or a storefront ends up holding a line it cannot render. The refusal is the
    // ordinary `variant-not-found` for the same reason a draft Product answers
    // `product-not-found` — invisible rather than forbidden, so nothing here tells a browser
    // that a Merchant is preparing something.
    if (!(await storeVariantExists(tx, variantId))) return noSuchVariant(variantId);

    // Asked after the Variant is known to exist and separately from it, because "there is no
    // such Variant" is the more fundamental answer — a caller told only that it is unpriced
    // would go and price something that is not there.
    const [priced] = await tx
      .select({ id: price.id })
      .from(price)
      .where(eq(price.variantId, variantId))
      .limit(1);
    if (!priced) {
      return {
        ok: false,
        reason: "variant-not-priced",
        detail:
          "This Variant carries no Price, so this Store cannot sell it. A Variant is sellable once a Price has been set on it.",
      } as const;
    }

    await tx
      .insert(cartLineItem)
      .values({ cartId, variantId, quantity: quantity.value, metadata })
      .onConflictDoUpdate({
        target: [cartLineItem.cartId, cartLineItem.variantId],
        set: {
          // `excluded` is the row this statement proposed, so the arithmetic is Postgres's and
          // two concurrent adds cannot both read the same "before" value.
          quantity: sql`${cartLineItem.quantity} + excluded.quantity`,
          // Only when the caller sent some: adding a Variant again with no `metadata` should
          // not blank what the first add put there.
          ...(input.metadata === undefined ? {} : { metadata }),
        },
      });

    return undefined;
  });
}

/**
 * Changes a Line Item — its quantity, its open data, or both.
 *
 * Quantity zero is refused rather than treated as a removal: removing a line is
 * {@link removeLineItem}, and a quantity that sometimes means "delete this row" is the kind of
 * overloading a storefront finds out about by having deleted something.
 */
export async function updateLineItem(
  db: Database,
  cartId: string,
  lineItemId: string,
  input: UpdateLineItemInput,
): Promise<CartResult<"invalid" | "line-item-not-found" | NotChangeable>> {
  // Unlike `updateCart` above, this one's two fields do narrow into columns one for one, so it
  // reads them the way every other `PATCH` on the surface does — and `changes` is then the very
  // object the `update` sets, which is what the spread below used to assemble by hand.
  //
  // `parseQuantity` is creation's, so one field is read one way. Its `undefined` branch — the
  // default of one — is unreachable from here, because a field the body did not name is never
  // narrowed at all: that absence means "leave it", where on an add it means "one of them".
  const usable = changesFrom(
    { quantity: input.quantity, metadata: input.metadata },
    { quantity: parseQuantity, metadata: openData("metadata") },
    changesNothing("a `quantity`, a `metadata`, or both"),
  );
  if (!usable.ok) return usable;
  const changes = usable.changes;

  return mutate<"line-item-not-found">(db, cartId, async (tx) => {
    if (!isUuid(lineItemId)) return noSuchLineItem(lineItemId);

    const changed = await tx
      .update(cartLineItem)
      .set(changes)
      // Both, so a Line Item of *another* Cart is not reachable by naming it here — holding a
      // Cart's identifier is authority over that Cart and over nothing else.
      .where(and(eq(cartLineItem.id, lineItemId), eq(cartLineItem.cartId, cartId)))
      .returning({ id: cartLineItem.id });

    return changed.length === 0 ? noSuchLineItem(lineItemId) : undefined;
  });
}

/** Removes a Line Item, and answers with what is left — a storefront re-renders from it. */
export async function removeLineItem(
  db: Database,
  cartId: string,
  lineItemId: string,
): Promise<CartResult<"line-item-not-found" | NotChangeable>> {
  return mutate<"line-item-not-found">(db, cartId, async (tx) => {
    if (!isUuid(lineItemId)) return noSuchLineItem(lineItemId);

    const removed = await tx
      .delete(cartLineItem)
      .where(and(eq(cartLineItem.id, lineItemId), eq(cartLineItem.cartId, cartId)))
      .returning({ id: cartLineItem.id });

    return removed.length === 0 ? noSuchLineItem(lineItemId) : undefined;
  });
}

/**
 * The three things every Cart mutation does before its own work, and the read after it.
 *
 * Finding the Cart, refusing an expired one and answering with the whole Cart are the same in
 * all four, and each is a rule rather than a formality — so they are written once here instead
 * of four times, where the fourth copy is the one that forgets the expiry check.
 *
 * The Cart row is locked `for update` for the length of the transaction. Two requests changing
 * one Cart is the ordinary case for a storefront with a tab open twice, and the lock is what
 * makes them a queue rather than a race.
 */
async function mutate<Reason extends CartRefusal>(
  db: Database,
  cartId: string,
  change: (tx: Transaction) => Promise<CartRefused<Reason> | undefined>,
): Promise<CartResult<Reason | NotChangeable>> {
  return db.transaction(async (tx): Promise<CartResult<Reason | NotChangeable>> => {
    if (!isUuid(cartId)) return noSuchCart(cartId);

    const [found] = await tx
      .select({ id: cart.id, expired: cartHasExpired, placed: cartHasBeenPlaced })
      .from(cart)
      .where(eq(cart.id, cartId))
      .for("update")
      .limit(1);
    if (!found) return noSuchCart(cartId);
    if (found.expired) {
      return {
        ok: false,
        reason: "cart-expired",
        detail:
          "This Cart has expired, so it can no longer be changed or placed. It is still readable and its Line Items are still there — start a new Cart.",
      };
    }
    if (found.placed) {
      return {
        ok: false,
        reason: "cart-placed",
        detail:
          "This Cart has already been placed, and a Cart becomes exactly one Order. Changing it now would change nothing about what was bought — start a new Cart.",
      };
    }

    const refusal = await change(tx);
    // Read back **inside** the transaction, still holding the lock. Reading after the commit
    // would answer with whatever a concurrent request had done in between, so the caller
    // would be handed a Cart that is not the one their own request produced.
    return refusal ?? read(tx, cartId);
  });
}

/**
 * Reads back rather than assembling the answer from what went in.
 *
 * So what a mutation reports is the same bytes a subsequent `GET` reports — same columns, same
 * line order, produced by the same code — which is what makes "answer with the whole Cart"
 * worth doing at all.
 */
async function read(db: Queryable, cartId: string): Promise<{ ok: true; cart: Cart }> {
  const found = await readCart(db, cartId);
  if (!found) throw new Error("A Cart was written and could not be read back.");
  return { ok: true, cart: found };
}

/**
 * The Cart's own fields once they are narrowed.
 *
 * `shopper` is three-valued on purpose: absent leaves whoever is on the Cart alone, `null`
 * detaches them, and an object attaches one. Collapsing the first two would make a request
 * about `metadata` blank the Shopper off the Cart.
 */
type ParsedCartInput = {
  readonly shopper?: AssertedShopper | null;
  readonly metadata?: Record<string, unknown>;
};

/** Named apart from `read.ts`'s `CartShopper`: this is what a caller sent, not what is stored. */
type AssertedShopper = { readonly email: string; readonly externalId: string | null };

type ParsedCart =
  | { readonly ok: true; readonly value: ParsedCartInput }
  | CartRefused<"invalid" | "secret-key-required">;

/**
 * The Cart's own fields, and the one rule about them that is not structural.
 *
 * **Attaching a Shopper is refused over a publishable key.** That is ADR-0020's boundary: Core
 * trusts the identity a storefront asserts *over a secret server-side key*, and a publishable
 * key is the one a browser holds — so over that key the assertion would be the Shopper's own.
 * This is the first behavioural difference between the two kinds; until now they differed only
 * in how visible they are.
 *
 * **Detaching is not.** `shopper: null` asserts nothing about who anybody is, so the rule it
 * would be enforcing does not apply to it — and a browser signing a Shopper out has no secret
 * key to reach for.
 */
function parseCartInput(input: CartInput, keyKind: ApiKeyKind): ParsedCart {
  const value: { shopper?: AssertedShopper | null; metadata?: Record<string, unknown> } =
    {};

  if (input.shopper === null) {
    value.shopper = null;
  } else if (input.shopper !== undefined) {
    if (keyKind !== "secret") {
      return {
        ok: false,
        reason: "secret-key-required",
        detail:
          'Attaching a Shopper to a Cart needs a secret key (`kobai_sk_…`). kobai stores no Shopper credential and trusts the identity a storefront asserts (ADR-0020), which it can only do over a key a browser never holds. Detaching one — `"shopper": null` — asserts nothing and needs no such key.',
      };
    }

    if (!isJsonObject(input.shopper)) {
      return invalid(
        "`shopper` must be an object with an `email`, or `null` to make this Cart a guest's again.",
      );
    }

    // Stored as the storefront wrote it, not normalised: Core does not own this identity and
    // has no Shopper table to make one spelling of it canonical against.
    const email = trimmed(input.shopper.email);
    if (email === undefined) {
      return invalid(
        "`shopper.email` must be a non-empty string. It is the key of a reference kobai stores, and never a credential kobai holds (ADR-0020).",
      );
    }

    const asked = input.shopper.externalId;
    const externalId = asked === undefined || asked === null ? null : trimmed(asked);
    if (externalId === undefined) {
      return invalid(
        "`shopper.externalId` must be a non-empty string, `null`, or absent. It is this Shopper's identity in whatever system your storefront actually authenticates against.",
      );
    }

    value.shopper = { email, externalId };
  }

  if (input.metadata !== undefined) {
    const metadata = asMetadata(input.metadata);
    if (metadata === undefined) return invalid(metadataDetail("`metadata`"));
    value.metadata = metadata;
  }

  return { ok: true, value };
}

type ParsedQuantity = { readonly ok: true; readonly value: number } | BadRequest;

function parseQuantity(value: unknown): ParsedQuantity {
  if (value === undefined) return { ok: true, value: DEFAULT_QUANTITY };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid(
      "`quantity` must be a whole number of at least 1. Removing a line is `DELETE`, not a quantity of zero.",
    );
  }
  return { ok: true, value };
}

function invalid(detail: string): BadRequest {
  return { ok: false, reason: "invalid", detail };
}

function noSuchCart(cartId: string): CartRefused<"cart-not-found"> {
  return {
    ok: false,
    reason: "cart-not-found",
    detail: `No Cart ${JSON.stringify(cartId)} exists. A Cart is addressed by the identifier it was created with, and holding that identifier is the whole of the authority to act on it.`,
  };
}

function noSuchLineItem(lineItemId: string): CartRefused<"line-item-not-found"> {
  return {
    ok: false,
    reason: "line-item-not-found",
    detail: `This Cart carries no Line Item ${JSON.stringify(lineItemId)}.`,
  };
}

function noSuchVariant(variantId: string): CartRefused<"variant-not-found"> {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists. A Line Item selects the Variant, which is the sellable thing, and never the Product.`,
  };
}
