import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client.ts";
import { shippingMethod } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { asMetadata, isJsonObject, metadataDetail, trimmed } from "../input.ts";
import { type NotUsable, notUsable } from "../patch.ts";
import { readDefaultRegion } from "./read.ts";

/**
 * **Shipping methods** — the named, flat-rated ways of delivering into one Region (#321).
 *
 * A Region is where geography is already modelled (ADR-0005), so this is where what it costs to
 * get something there lives. Three things here are decisions rather than implementation:
 *
 * **They are a field of the Region rather than a list route of their own.** `Region` carries
 * them, `POST /admin/regions` and `PATCH /admin/regions/{id}` write them, and there is no
 * `GET /admin/regions/{id}/shipping-methods` — which is the same boundary
 * `store/currency.ts` draws for the enabled set and the same bargain a Product's `options` take.
 * The consequence is the one worth stating: because there is no plural route over this table,
 * ADR-0064's cursor and the filtering convention have nothing to attach to, and a Merchant reads
 * a Region's rates by reading the Region.
 *
 * **The list is the whole fact on the way in**, so adding, renaming, repricing, reordering and
 * removing are one request. An entry carrying an `id` is the method that already has it, one
 * without is new, and one this Region has that the list does not name is removed with it —
 * `options`' rule exactly, because identity on the wire is what makes a rename a rename rather
 * than a removal and an addition. A Cart that had chosen a removed method is left choosing
 * again, which is `core_cart.shipping_method_id`'s `set null`.
 *
 * **A rate carries no currency**, because the Region it belongs to selects exactly one and a
 * Cart in that Region is stamped in it (ADR-0074). See `core_shipping_method.amount`.
 */

/**
 * A shipping method as a **storefront** sees one: what it is called and what it costs.
 *
 * Declared apart from {@link ShippingMethod} on #207's split, and here it does real work rather
 * than being a symmetry: this is what `GET /store/carts/{id}/shipping-options` offers and what a
 * Cart reports as its choice, both of which a **publishable** key opens — so `metadata`, which is
 * the Merchant's and the Project's, would be published to a browser by the deploy that put
 * something in it.
 */
export type ShippingOption = {
  readonly id: string;
  readonly name: string;
  /** Minor units of the **Region's** currency. Never negative; zero is free delivery. */
  readonly amount: number;
};

/** A shipping method as the admin surface reports one — the whole row, minus what nobody reads. */
export type ShippingMethod = ShippingOption & {
  readonly metadata: Record<string, unknown>;
};

/**
 * One method as a storefront sees it — field by field, so the next column added for a Merchant
 * reaches a browser only by somebody editing this function (`asStoreMedia`'s rule).
 */
export function asShippingOption(method: ShippingMethod): ShippingOption {
  return { id: method.id, name: method.name, amount: method.amount };
}

/** The word a correction naming a method this Region has not got is refused with. */
export const SHIPPING_METHOD_NOT_FOUND = "shipping-method-not-found";

/** One entry of a `shippingMethods` list, narrowed. */
type AskedMethod = {
  /** The method this entry *is*, where the Merchant named one; absent is a new method. */
  readonly id?: string;
  readonly name: string;
  readonly amount: number;
  readonly metadata?: Record<string, unknown>;
};

export type ShippingMethodsAsked =
  | { readonly ok: true; readonly value: readonly AskedMethod[] }
  | NotUsable;

/** How writing a Region's methods can be refused past the request's own `invalid`. */
export type ShippingMethodSetRefusal = NotUsable<typeof SHIPPING_METHOD_NOT_FOUND>;

/**
 * The `shippingMethods` a body asked for, or why the list is unusable.
 *
 * Structural only, in the one place both writes read it, so a create and a correction cannot
 * disagree about what a rate is. What is **not** judged here is whether an `id` names a method
 * this Region has: that is a fact about the Store rather than about the body, and
 * {@link setShippingMethods} answers it with a word of its own.
 *
 * **A list naming one method twice *is* judged here, and is `invalid` at 400** — the line
 * `POST /admin/products` already draws for a SKU named twice: a body conflicting with itself is
 * not the Store refusing anything, and no retry of it as it stands will be taken. Calling it
 * `shipping-method-not-found` would have been the Store's word about ids the Store has.
 */
export function parseShippingMethods(value: unknown): ShippingMethodsAsked {
  if (!Array.isArray(value)) {
    return notUsable(
      '`shippingMethods` must be the complete list of the ways this Store delivers into this Region — e.g. [{ "name": "Standard", "amount": 500 }]. It replaces what the Region has rather than adding to it, so an entry left out is a method taken away.',
    );
  }

  const asked: AskedMethod[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      return notUsable(
        'Each entry in `shippingMethods` must be an object with a `name` and an `amount` — e.g. { "name": "Standard", "amount": 500 }.',
      );
    }

    const name = trimmed(entry.name);
    if (name === undefined) {
      return notUsable(
        "Each entry in `shippingMethods` must carry a non-empty `name` — what a Shopper reads when they choose how it should reach them.",
      );
    }

    const amount = entry.amount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      return notUsable(
        `Each entry in \`shippingMethods\` must carry an \`amount\` — a whole number of the Region's currency's minor units, 500 being 5.00, and never negative. ${JSON.stringify(amount)} is not one. Zero is free delivery.`,
      );
    }

    const named: {
      id?: string;
      name: string;
      amount: number;
      metadata?: Record<string, unknown>;
    } = { name, amount };

    if (entry.id !== undefined && entry.id !== null) {
      const id = trimmed(entry.id);
      if (id === undefined) {
        return notUsable(
          "An entry's `id` names the shipping method this Region already has — leave it out for a new one. It must be that method's identifier.",
        );
      }
      named.id = id;
    }

    if (entry.metadata !== undefined) {
      const metadata = asMetadata(entry.metadata);
      if (metadata === undefined) {
        return notUsable(metadataDetail("Each entry's `metadata`"));
      }
      named.metadata = metadata;
    }

    asked.push(named);
  }

  const named = asked.flatMap((entry) => (entry.id === undefined ? [] : [entry.id]));
  if (new Set(named).size !== named.length) {
    return notUsable(
      "`shippingMethods` names one method more than once, and a method is one row — the second spelling would win and the list would read back differently from the one that was sent. Send each `id` exactly once, in the order they should be offered in.",
    );
  }

  return { ok: true, value: asked };
}

/**
 * Every entry that names a method this Region has not got, in the order they were sent.
 *
 * Split from the write for the reason every refusal on this surface is asked before the first
 * one: a refusal handed back out of a transaction **commits** it, so `createRegion` asks this
 * *before* it inserts the Region rather than after — otherwise a create refused for naming a
 * stranger `id` would answer 422 over a Region it had just made.
 */
export async function shippingMethodsThisRegionHasNot(
  db: Queryable,
  regionId: string | null,
  asked: readonly AskedMethod[],
): Promise<ShippingMethodSetRefusal | undefined> {
  const named = asked.flatMap((entry) => (entry.id === undefined ? [] : [entry.id]));
  if (named.length === 0) return undefined;

  // `null` is a Region that does not exist yet — `createRegion` asking before its insert — so
  // every `id` is a stranger, which is the honest answer: a Region being created carries none.
  const held =
    regionId === null
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: shippingMethod.id })
              .from(shippingMethod)
              .where(eq(shippingMethod.regionId, regionId))
          ).map((row) => row.id),
        );

  const strangers = named.filter((id) => !held.has(id));
  if (strangers.length === 0) return undefined;

  return {
    ok: false,
    reason: SHIPPING_METHOD_NOT_FOUND,
    detail: `${strangers.map((id) => JSON.stringify(id)).join(", ")} ${strangers.length === 1 ? "is not a shipping method" : "are not shipping methods"} this Region has. An entry's \`id\` names one it already carries — renaming or repricing one keeps its identifier, so a Cart that has chosen it keeps its choice — and an entry with no \`id\` is a new method.`,
  };
}

/**
 * Writes exactly these methods onto a Region, or says why it will not.
 *
 * **Reconciled rather than deleted and rewritten**, which is the opposite call from
 * `setEnabledCurrencies` and is `options`' argument: a currency is identified by its own code, so
 * writing the set whole preserves identity for free, where a shipping method is identified by a
 * row — and a delete-then-insert would give every method a new `id`, taking the Cart of every
 * Shopper mid-checkout off the method they had chosen. So an entry naming an `id` **updates** the
 * row, one naming none inserts, and what is left over is deleted.
 *
 * **It refuses nothing**, which is the point: both callers have already asked
 * {@link shippingMethodsThisRegionHasNot}, so by the time this runs there is nothing left that
 * could turn the request back after a row had been written. That is `writeAddress`'s shape one
 * noun along, and it exists for the reason `collection-not-found` already carries: a refusal
 * handed back out of a transaction **commits** it.
 *
 * **Its caller holds the Region row `for update`**, which is what makes the read of what this
 * Region already carries safe to write against: the condition is about *other rows*, and a
 * `select` locks none of them — so two Merchants correcting one Region's rates at the same
 * instant would otherwise each write against a list the other had already changed, and one rate
 * would go missing with nothing saying so.
 */
export async function setShippingMethods(
  tx: Transaction,
  regionId: string,
  asked: readonly AskedMethod[],
): Promise<void> {
  const surviving = asked.flatMap((entry) => (entry.id === undefined ? [] : [entry.id]));

  // Removed first, so a Region ending up with fewer methods never holds two at one `position`
  // in between — nothing reads it inside this transaction, but a partial state is not one to
  // leave available to an unmediated reader either (ADR-0004).
  await tx
    .delete(shippingMethod)
    .where(
      surviving.length === 0
        ? eq(shippingMethod.regionId, regionId)
        : and(
            eq(shippingMethod.regionId, regionId),
            notInArray(shippingMethod.id, surviving),
          ),
    );

  for (const [position, entry] of asked.entries()) {
    if (entry.id === undefined) {
      await tx.insert(shippingMethod).values({
        regionId,
        name: entry.name,
        amount: entry.amount,
        position,
        metadata: entry.metadata ?? {},
      });
      continue;
    }

    await tx
      .update(shippingMethod)
      .set({
        name: entry.name,
        amount: entry.amount,
        position,
        // Absent leaves it, exactly as a named `metadata` anywhere else on this surface does
        // (ADR-0062) — the entry is a correction of one row rather than a replacement of it.
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      })
      // The Region as well as the row, although the identifier is unique on its own: this
      // statement is the only one here that could reach a method of *another* Region, and a
      // `where` that says so costs nothing and cannot go stale the way the read above could.
      .where(and(eq(shippingMethod.id, entry.id), eq(shippingMethod.regionId, regionId)));
  }
}

/** The columns a shipping method is reported by. Named once, because three queries answer with them. */
const REPORTED = {
  id: shippingMethod.id,
  name: shippingMethod.name,
  amount: shippingMethod.amount,
  metadata: shippingMethod.metadata,
} as const;

/**
 * The methods a Region carries, in the order the Merchant declared them.
 *
 * Ending in `id`, for the reason every ordering in this repository does: two rows written in one
 * transaction share a `position` only if somebody wrote them by hand, and a tie that fell to a
 * random uuid would report a Region's rates in a different order every time it was read.
 */
export async function readShippingMethods(
  db: Queryable,
  regionId: string,
): Promise<readonly ShippingMethod[]> {
  return db
    .select(REPORTED)
    .from(shippingMethod)
    .where(eq(shippingMethod.regionId, regionId))
    .orderBy(asc(shippingMethod.position), asc(shippingMethod.id));
}

/** The methods each of these Regions carries, keyed by Region — one query for a whole page. */
export async function readShippingMethodsOf(
  db: Queryable,
  regionIds: readonly string[],
): Promise<Map<string, ShippingMethod[]>> {
  const byRegion = new Map<string, ShippingMethod[]>();
  if (regionIds.length === 0) return byRegion;

  const rows = await db
    .select({ regionId: shippingMethod.regionId, ...REPORTED })
    .from(shippingMethod)
    .where(inArray(shippingMethod.regionId, [...regionIds]))
    .orderBy(asc(shippingMethod.position), asc(shippingMethod.id));

  for (const { regionId, ...method } of rows) {
    const held = byRegion.get(regionId);
    if (held) held.push(method);
    else byRegion.set(regionId, [method]);
  }
  return byRegion;
}

/**
 * **Which Region's rates apply to a Cart** — its own, or the Store's default where it names
 * none.
 *
 * `marketOfCart`'s fallback one noun along, and it is exported so that there is exactly one
 * answer: a Cart with `region_id` `null` is *priced* for the Store's default Region, so it has
 * to be *delivered* by that Region's rates too. Two readers that disagreed would leave such a
 * Cart offered a method it could not then choose, and refused `shipping-method-required` at the
 * quote and at the placement — a Cart nothing could place, reached by nobody doing anything
 * wrong. `null` is a deployment with neither, which is a database migrated and never booted
 * against (`store/seed.ts`).
 */
export async function shippingRegionOf(
  db: Queryable,
  regionId: string | null,
): Promise<string | null> {
  if (regionId !== null) return regionId;
  return (await readDefaultRegion(db))?.id ?? null;
}

/**
 * One shipping method **of one Region**, or `undefined` where that Region has no such method.
 *
 * The Region is part of the question rather than a check afterwards, because a method belongs to
 * exactly one geography: a Cart in Malaysia offered a rate somebody defined for the Eurozone
 * would be charged in the wrong currency, and there is nothing on the row that would say so.
 */
export async function readShippingMethodOf(
  db: Queryable,
  regionId: string,
  id: string,
): Promise<ShippingMethod | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db
    .select(REPORTED)
    .from(shippingMethod)
    .where(and(eq(shippingMethod.id, id), eq(shippingMethod.regionId, regionId)))
    .limit(1);
  return row;
}
