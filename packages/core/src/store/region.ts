import { desc, eq } from "drizzle-orm";
import type { Database, Queryable } from "../db/client.ts";
import { violatesForeignKey } from "../db/errors.ts";
import {
  cursorAt,
  type Page,
  type PageRequest,
  pageSize,
  rowsAfter,
  takePage,
} from "../db/page.ts";
import { region } from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import {
  type Changes,
  changesFrom,
  changesNothing,
  mustBeText,
  type NotUsable,
  notUsable,
  openData,
  text,
} from "../patch.ts";
import { currencyIsEnabled } from "./currency.ts";

/**
 * Regions: making one, reading them, renaming one, moving one onto another currency, removing
 * one (#291, ADR-0005, ADR-0074).
 *
 * A **Region** is a geography this Store sells into. ADR-0005 said Channel and Region were
 * modelled "from day one" and neither was a table until this ticket; ADR-0074 settled what one
 * carries, and it is deliberately little: a name, the currency it **selects** out of the Store's
 * enabled set, and the place tax treatment (spec 7) and shipping methods (spec 5) will hang off.
 *
 * Three things here are decisions rather than implementation:
 *
 * **A Region selects a currency and never declares one.** {@link currencyIsEnabled} is asked at
 * the create and at the correction alike, and the foreign key onto `core_store_currency` is the
 * same sentence in the database — so `currency-not-enabled` is one word for one fact whichever
 * route reaches it. It is **422** rather than 400 on `unknown-fulfilment-strategy`'s
 * distinction: the body is well formed and what refuses it is the state of the Store.
 *
 * **It is not `unsupported-currency`**, the word `setPrice` already answers with, and that is
 * ADR-0065's own argument one noun along: there, a *Price* names a currency this Store does not
 * price in and the repair is to send the Store's; here the repair is to enable the currency, or
 * to pick one that already is. A client branching on a shared word would offer the wrong advice
 * for one of them.
 *
 * **A Region is not a tenant.** ADR-0005 is explicit and this is the spec most likely to be read
 * as an invitation, so nothing scopes by a Region and `region.test.ts` asks
 * `foreignKeysTargeting` what points at one — the Store's own `default_region_id`, and since
 * #292 `core_price.region_id`, which is a constraint on a row rather than a scope: a Price
 * naming no Region applies in all of them. A scoping key arriving here reddens the build rather
 * than shipping unnoticed.
 */

/** The word a Region operation is refused with when there is no such Region. */
export const REGION_NOT_FOUND = "region-not-found";

/** The word both writes are refused with when the currency is not one the Store has enabled. */
export const CURRENCY_NOT_ENABLED = "currency-not-enabled";

/** The word a deletion is refused with while the Store falls back to this Region. */
export const REGION_IN_USE = "region-in-use";

/** A Region as the admin surface reports it — the whole row, minus what nobody reads. */
export type Region = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly metadata: Record<string, unknown>;
};

/**
 * The Region a price was asked for — what it is called and what it prices in, and nothing else.
 *
 * `VariantIdentity`'s shape one noun along, and there for the same reason: this travels through
 * `resolve-price` and out to a storefront, so it carries what a Developer reading the answer
 * recognises and leaves `metadata` — which is the Merchant's and the Project's — behind. The
 * currency is here because it is the rule: a Price denominated in something else does not apply
 * in this Region, and kobai converts nothing (ADR-0074).
 */
export type RegionIdentity = {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
};

export type RegionCreation =
  | { readonly ok: true; readonly region: Region }
  | {
      readonly ok: false;
      readonly reason: "invalid" | typeof CURRENCY_NOT_ENABLED;
      readonly detail: string;
    };

export type RegionUpdate =
  | { readonly ok: true; readonly region: Region }
  | {
      readonly ok: false;
      readonly reason: "invalid" | typeof REGION_NOT_FOUND | typeof CURRENCY_NOT_ENABLED;
      readonly detail: string;
    };

/**
 * Deleting a Region refuses two ways, and the second is ADR-0059's shape.
 *
 * A Region the Store falls back to is refused rather than cascaded or nulled: the fallback is
 * what makes `GET /store/variants/{id}/price` answerable with no `?region=` at all, so silently
 * removing it would leave every storefront that sends no parameter refused instead. The repair
 * is a control the Merchant already has — point the Store at another Region, then delete this
 * one — which is exactly the test ADR-0059 applies.
 */
export type RegionDeletion =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: typeof REGION_NOT_FOUND | typeof REGION_IN_USE;
      readonly detail: string;
    };

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type CreateRegionInput = {
  readonly name?: unknown;
  readonly currency?: unknown;
  readonly metadata?: unknown;
};

export type UpdateRegionInput = CreateRegionInput;

/** The columns a body names, of which a `PATCH` names some and a create names all it means to. */
type RegionColumns = {
  name: string;
  currency: string;
  metadata: Record<string, unknown>;
};

/** Said once, because two paths reach it: a create naming no name, and either path given a blank. */
const NAME_MUST_BE_A_NAME = mustBeText("name");

/** The columns a Region is reported by. Named once, because four queries answer with them. */
const REPORTED = {
  id: region.id,
  name: region.name,
  currency: region.currency,
  metadata: region.metadata,
} as const;

export async function createRegion(
  db: Database,
  input: CreateRegionInput,
): Promise<RegionCreation> {
  const usable = readRegionInput(input);
  if (!usable.ok) return usable;

  const { name, currency, metadata = {} } = usable.changes;
  if (name === undefined) return notUsable(NAME_MUST_BE_A_NAME);
  if (currency === undefined) {
    return notUsable(
      '`currency` must be an ISO 4217 code this Store has enabled, e.g. "USD". `GET /admin/store` lists them.',
    );
  }

  if (!(await currencyIsEnabled(db, currency))) return currencyNotEnabled(currency);

  const [created] = await db
    .insert(region)
    .values({ name, currency, metadata })
    .returning(REPORTED);
  // Unreachable — an `insert … returning` of one row answers with one row — and typed rather
  // than asserted away.
  if (!created) throw new Error("unreachable: creating a Region answered no row");
  return { ok: true, region: created };
}

/**
 * A page of Regions, newest first — the same ordering and the same cursor every other list on
 * this surface uses (ADR-0064), ending in `id` so it cannot tie.
 */
export async function listRegions(
  db: Database,
  page: PageRequest,
): Promise<Page<Region>> {
  const rows = await db
    .select({ ...REPORTED, cursorAt: cursorAt(region.createdAt) })
    .from(region)
    .where(rowsAfter(page, region.createdAt, region.id))
    .orderBy(desc(region.createdAt), desc(region.id))
    .limit(pageSize(page));

  const { rows: found, nextCursor } = takePage(rows, page);

  // Field by field rather than by spread, so the column the cursor is cut from cannot reach a
  // response by being forgotten about.
  return {
    items: found.map((row) => ({
      id: row.id,
      name: row.name,
      currency: row.currency,
      metadata: row.metadata,
    })),
    nextCursor,
  };
}

/**
 * One Region, or `undefined` when there is no such Region — including when `id` is not an
 * identifier at all, which is the same answer to the caller.
 */
export async function readRegion(db: Queryable, id: string): Promise<Region | undefined> {
  if (!isUuid(id)) return undefined;

  const [row] = await db.select(REPORTED).from(region).where(eq(region.id, id)).limit(1);
  return row;
}

/**
 * Renames a Region, moves it onto another enabled currency, or replaces its metadata.
 *
 * The same `PATCH` every other correction on this surface is (ADR-0062): an absent field means
 * "leave it", a named `metadata` **replaces** what is stored rather than merging into it, and a
 * body naming nothing is refused rather than answered 200.
 *
 * **A Region's currency moves and the Store's does not**, which is the asymmetry worth reading
 * twice. ADR-0065 fixes the Store's default because every unconstrained Price is denominated in
 * it; a Region selects rather than declares, so moving the selection **re-selects which Prices
 * apply** rather than reinterpreting any of them — a Price denominated in the currency this
 * Region used to select simply stops applying here (#292). ADR-0074 says as much: a Region's
 * currency changing must not reprice a live Cart, which is why a Cart will carry its currency as
 * well as its Region.
 */
export async function updateRegion(
  db: Database,
  id: string,
  input: UpdateRegionInput,
): Promise<RegionUpdate> {
  const usable = readRegionInput(input);
  if (!usable.ok) return usable;

  const changes = usable.changes;
  // Asked here rather than inside `readRegionInput`, which `createRegion` shares: there an
  // empty result is a missing `name` rather than a no-op, and it is answered as one.
  if (Object.keys(changes).length === 0) {
    return changesNothing("a `name`, a `currency`, a `metadata`, or any of them");
  }

  if (!isUuid(id)) return noSuchRegion(id);

  if (
    changes.currency !== undefined &&
    !(await currencyIsEnabled(db, changes.currency))
  ) {
    return currencyNotEnabled(changes.currency);
  }

  const [updated] = await db
    .update(region)
    .set(changes)
    .where(eq(region.id, id))
    .returning(REPORTED);
  if (!updated) return noSuchRegion(id);
  return { ok: true, region: updated };
}

/**
 * Deletes a Region, unless the Store falls back to it.
 *
 * **One statement, and the violation is read rather than asked for first** — `role-in-use`'s
 * shape and its reason: a `select` then a `delete` lets a concurrent `PATCH /admin/store`
 * point the Store at this Region in between, and the foreign key is the only thing that cannot
 * be raced.
 *
 * **Every Price constrained to this Region goes with it** (#292, re-argued in #310), and the
 * argument is `db/schema.ts`'s at the column rather than a second copy of it here. The one thing
 * to know at this end: `GET /admin/prices?region=` is where a Merchant reads what the deletion
 * will cost, **before** making it.
 */
export async function deleteRegion(db: Database, id: string): Promise<RegionDeletion> {
  if (!isUuid(id)) return noSuchRegion(id);

  try {
    const [deleted] = await db
      .delete(region)
      .where(eq(region.id, id))
      .returning({ id: region.id });
    if (!deleted) return noSuchRegion(id);
    return { ok: true };
  } catch (cause) {
    if (!violatesForeignKey(cause, "core_store_default_region_id_core_region_id_fk")) {
      throw cause;
    }
    return {
      ok: false,
      reason: REGION_IN_USE,
      detail:
        "This Store's default Region is this one, and a storefront that asks for a price without naming a Region is answered for it. Point the Store at another Region with `PATCH /admin/store` — `defaultRegion` — and then delete this one.",
    };
  }
}

/**
 * The columns a body names, narrowed — the one place a Region's input is read, so creating one
 * and correcting one cannot disagree about what a currency is.
 *
 * The code is upper-cased for `parseEnabledCurrencies`' reason: `usd` and `USD` are one code.
 */
function readRegionInput(input: CreateRegionInput): Changes<RegionColumns> {
  return changesFrom(
    { name: input.name, currency: input.currency, metadata: input.metadata },
    {
      name: text("name"),
      currency: (value) => {
        const code = typeof value === "string" ? value.trim().toUpperCase() : "";
        return code.length === 3
          ? { ok: true, value: code }
          : notUsable(
              '`currency` must be an ISO 4217 code — three letters, e.g. "USD" — and one this Store has enabled.',
            );
      },
      metadata: openData("metadata"),
    },
  );
}

function noSuchRegion(id: string): {
  ok: false;
  reason: typeof REGION_NOT_FOUND;
  detail: string;
} {
  return {
    ok: false,
    reason: REGION_NOT_FOUND,
    detail: `No Region with the identifier ${JSON.stringify(id)} exists. \`GET /admin/regions\` lists the ones this Store has.`,
  };
}

function currencyNotEnabled(code: string): {
  ok: false;
  reason: typeof CURRENCY_NOT_ENABLED;
  detail: string;
} {
  return {
    ok: false,
    reason: CURRENCY_NOT_ENABLED,
    detail: `This Store has not enabled ${JSON.stringify(code)}, and a Region prices in one of the currencies it has. \`GET /admin/store\` lists them, and \`PATCH /admin/store\` — \`currencies\` — is where another is enabled.`,
  };
}

/**
 * The refusal for a `defaultRegion` naming no Region — or `undefined` where it names one.
 *
 * Exported because `PATCH /admin/store` asks it: **422**, on `collection-not-found`'s
 * distinction, and the same word `GET /admin/regions/{id}` answers 404 with, because it is one
 * fact asked from two ends and one fact gets one word (ADR-0060).
 */
export async function unknownRegion(
  db: Queryable,
  id: string,
): Promise<{ ok: false; reason: typeof REGION_NOT_FOUND; detail: string } | undefined> {
  return (await readRegion(db, id)) === undefined ? noSuchRegion(id) : undefined;
}

/**
 * The refusal for a `?region=` naming no Region — or `undefined` where it names one (#310).
 *
 * **A different answer from {@link unknownRegion}, and the difference is where the value came
 * from.** A `regionId` on a *body* names a record this Store has not got and is refused **422
 * `region-not-found`**, the Region's own word; a **query parameter** it cannot use does not fit
 * the endpoint at all and is refused **400 `invalid`**, which is what `?collection=` and the
 * price routes' `?region=` already answer. That line is drawn on the surface rather than here —
 * `catalog/collection.ts`'s `unknownCollection` is the shape this copies — and the reason a
 * `reason` of its own was not minted is ADR-0060's: a new one is permanent, and *stop sending
 * this value* is a distinction no client can act on differently.
 *
 * **One answer covers a value that is not a UUID and a UUID naming nothing**, because they are
 * one mistake: this parameter takes the identifier of a Region this Store has, and neither of
 * those is one.
 *
 * It is asked **before** the page is read rather than folded into it, so an unknown Region
 * cannot arrive as a 200 with an empty `prices` — the filtering convention's second promise,
 * and the answer a caller would read as the truth.
 */
export async function unusableRegion(
  db: Queryable,
  regionId: string,
): Promise<NotUsable | undefined> {
  return (await readRegion(db, regionId)) === undefined
    ? notUsable(
        `\`region\` names ${JSON.stringify(regionId)}, which is not a Region this Store has. Send the \`id\` of one — \`GET /admin/regions\` lists them — or leave the parameter out for every Price this Store holds.`,
      )
    : undefined;
}
