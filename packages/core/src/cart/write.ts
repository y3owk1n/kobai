import { and, asc, eq, sql } from "drizzle-orm";
import { type ParsedAddress, parseAddress } from "../address/address.ts";
import type { ApiKeyKind } from "../auth/api-key.ts";
import { lockVariant } from "../catalog/lock.ts";
import { storeVariantExists } from "../catalog/store-read.ts";
import type { Database, Queryable, Transaction } from "../db/client.ts";
import {
  address,
  cart,
  cartLineItem,
  price,
  reservation,
  variant,
} from "../db/schema.ts";
import { isUuid } from "../db/uuid.ts";
import { asMetadata, isJsonObject, metadataDetail, trimmed } from "../input.ts";
import { changesFrom, changesNothing, openData } from "../patch.ts";
import type { PriceMarket } from "../pricing/resolve-price.ts";
import { liveHoldOfCart, lockCartHold } from "../reservation/reservation.ts";
import { readDefaultCurrency, readDefaultRegion } from "../store/read.ts";
import {
  REGION_NOT_FOUND,
  type RegionIdentity,
  readRegionIdentity,
} from "../store/region.ts";
import {
  readShippingMethodOf,
  SHIPPING_METHOD_NOT_FOUND,
  shippingRegionOf,
} from "../store/shipping-method.ts";
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
 * - **A Cart is denominated when it is created and switches Region in place** (#293,
 *   ADR-0074's amendment). Its currency is **stamped** from the Region it is in rather than
 *   read through one, so a Merchant moving a Region onto another currency does not reprice a
 *   Cart that already exists; and `PATCH /store/carts/{id}` moves a Cart to another Region
 *   keeping its identifier and every line on it, because a Cart's Line Items carry no price
 *   snapshot (ADR-0009) and so cost nothing to re-price. Two things refuse that switch and
 *   both are below: something already denominated against the Cart, and a line the new Region
 *   could not price.
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
  | "variant-not-priced"
  | typeof REGION_NOT_FOUND
  | typeof CART_IS_DENOMINATED
  | typeof VARIANT_NOT_PRICED_IN_REGION
  | typeof SHIPPING_METHOD_NOT_FOUND;

/**
 * The word a Region switch is refused with while something is already denominated against this
 * Cart (#293, ADR-0074's amendment).
 *
 * **One word, and its prose names which of the two is holding it** — a live Reservation, or the
 * Payment behind a placement. ADR-0070 has stock held and a bank redirect in flight against a
 * Cart totalled in the old currency, and moving that Cart underneath them is how a Shopper pays
 * the right number in the wrong one: `place-order`'s `oneCurrency` guard would catch the
 * mismatch only after the money had moved.
 *
 * **It refuses rather than releasing the hold.** Releasing one by hand is what kobai has decided
 * never to offer — it takes stock from a Shopper who may already have paid — and the sweeper
 * already releases on expiry, so the repair is to wait the hold out or to start a new Cart.
 * Refusing is also the direction ADR-0060 permits to be relaxed later; allowing is not one that
 * can be tightened.
 *
 * **A Cart whose Payment exists is a Cart that has been placed**, and that is refused one door
 * earlier: Core writes `core_payment` inside the transaction that writes the Order (ADR-0009),
 * so `cart-placed` is the word for that half of the guard and it already refuses every change to
 * such a Cart. Two facts, two words, each naming which one is holding the Cart — which is what
 * the amendment asks for, said in the vocabulary this surface already has.
 *
 * **What that leaves open is a named limit rather than an oversight, and it is worth reading
 * before relying on this guard.** The payment ADR-0070 has in flight is a *PaymentIntent the
 * **Project** created*, before any Order exists — kobai holds no row for it and cannot, since
 * the storefront starts it at a route of the deployment's own. So what this guard actually sees
 * is the **hold** that flow takes first, which covers every Cart holding something scarce and
 * covers **nothing** in a Cart whose lines claim no stock at all: a Cart of digital Variants
 * with a bank redirect in flight can still be moved. Two things bound it and neither is this
 * module's: `@kobai/plugin-stripe`'s `charge` compares the intent's amount **and currency**
 * against what Core is about to charge and declines a mismatch *before* confirming anything, so
 * the money does not move; and a Project that starts payments knows it has, and is the only
 * party that could refuse a switch on that ground. Closing it inside Core would mean Core
 * recording a payment it did not start, which is the pending Order ADR-0070 rejected.
 */
export const CART_IS_DENOMINATED = "cart-is-denominated";

/**
 * The word a Region switch is refused with when a line would have no Price in the new Region.
 *
 * Named apart from `variant-not-priced` — the word an *add* is refused with — because the two
 * are different repairs: there, a Variant carries no Price at all and a Merchant prices it;
 * here, it carries Prices and none of them applies in the Region being switched to, so the
 * repair is to price it there or to choose another Region. It names every line that would be
 * left unpriceable rather than the first, because a storefront can only act on the whole list.
 *
 * **Refused rather than allowed**, which is the case #293 asked to be decided out loud: a Cart
 * moved into a Region it cannot be priced in is one whose quote and whose placement both refuse,
 * and a Shopper would meet that at the last step rather than at the moment they chose the
 * market.
 */
export const VARIANT_NOT_PRICED_IN_REGION = "variant-not-priced-in-region";

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
  /** The Region this Cart is in — absent means the Store's default at a create, and *leave it* at a correction. */
  readonly regionId?: unknown;
  /**
   * Where what is in this Cart is to be delivered — **three-valued, exactly as `shopper` is**
   * (#319, ADR-0072).
   *
   * Absent leaves whatever Address is on the Cart alone, `null` takes it off, and an object
   * replaces the whole of it. There is no merge: an address is one fact, and a correction that
   * merged would leave no way to take a postal code back out — which is the rule ADR-0062
   * already states about a named `metadata`.
   */
  readonly address?: unknown;
  /**
   * The way this Cart is to be delivered — **three-valued, exactly as `address` is** (#321).
   *
   * Absent leaves whatever the Cart has chosen alone, `null` unchooses, and an identifier
   * chooses one of the methods its Region carries.
   * `GET /store/carts/{id}/shipping-options` is what lists them, and a method belonging to any
   * other Region is refused — a rate is denominated in the Region that carries it.
   *
   * **It is on the correction and not on the create**, which is `media`'s absence rather than
   * `collections`': the options a Cart may be delivered by depend on what is in it and on where
   * it is going, so nothing could honestly be chosen at the moment a Cart is started and empty.
   * Adding it later is additive under ADR-0060.
   */
  readonly shippingMethodId?: unknown;
};

/**
 * What a Region switch has to ask of the rest of the deployment before it can be allowed.
 *
 * Passed in rather than reached for, exactly as the store surface threads its Workflow
 * declarations: a module that imported `resolve-price` would ask **Core's** pricing rule whether
 * a line can be priced in the new Region, and a Project that replaced `select-price` would then
 * be refused a switch its own deployment could have priced (ADR-0017, ADR-0054).
 */
export type CartMarketDependencies = {
  /** The Channel this request's key was minted into — half the market a line is judged in (ADR-0020). */
  readonly channel: PriceMarket["channel"];
  /**
   * Whether this deployment's own `resolve-price` can price this Variant in this market.
   *
   * A boolean rather than the price: what a switch needs to know is whether the Cart would
   * still be quotable, and the amount is a question `POST /store/carts/{id}/quote` answers a
   * moment later with the Steps that produced it.
   */
  readonly priceable: (variantId: string, market: PriceMarket) => Promise<boolean>;
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
 * Creates a Cart, denominated in the currency of the Region it is in.
 *
 * It has no Shopper of any kind unless the caller asserts one, because Core assumes an
 * authenticated Shopper nowhere (ADR-0020) — a guest is not the exception, it is the path.
 *
 * **A Cart that names no Region takes the Store's default**, so a storefront selling into one
 * market never mentions a Region at all and is answered exactly as it was before Regions
 * existed (#293). Naming one is how a storefront that has already asked a Shopper where they
 * are starts the Cart there rather than starting it in the wrong currency and switching.
 */
export async function createCart(
  db: Database,
  input: CartInput,
  /** Which credential this request arrived on; a Shopper may be asserted only over `secret`. */
  keyKind: ApiKeyKind,
): Promise<CartResult<"invalid" | "secret-key-required" | typeof REGION_NOT_FOUND>> {
  const parsed = parseCartInput(input, keyKind);
  if (!parsed.ok) return parsed;

  const denominated = await denominate(db, parsed.value.regionId);
  if (!denominated.ok) return denominated;

  // **In a transaction, because an Address is a second row.** A Cart pointing at an Address that
  // was never written, or an Address no Cart names, are both states nothing in kobai can repair;
  // the two writes go together or neither does.
  return db.transaction(
    async (
      tx,
    ): Promise<
      CartResult<"invalid" | "secret-key-required" | typeof REGION_NOT_FOUND>
    > => {
      // Resolved before anything is written, which is the rule this whole surface follows for
      // the reason `collection-not-found` already carries: a refusal returned out of a
      // transaction **commits** it, so a write in front of one leaves its row behind.
      let addressId: string | null = null;
      if (parsed.value.address != null) {
        const falls = await addressFallsIn(tx, parsed.value.address);
        if (!falls.ok) return falls;
        addressId = await writeAddress(tx, null, parsed.value.address, falls.regionId);
      }

      const [created] = await tx
        .insert(cart)
        .values({
          // In SQL rather than from `Date.now()`, so one clock both sets the deadline and judges
          // it — `read.ts` asks Postgres whether `now()` has passed this value.
          expiresAt: sql`now() + ${CART_LIFETIME}::interval`,
          shopperEmail: parsed.value.shopper?.email ?? null,
          shopperExternalId: parsed.value.shopper?.externalId ?? null,
          // Stamped, never read through the Region afterwards — see `db/schema.ts`.
          currency: denominated.currency,
          regionId: denominated.regionId,
          addressId,
          metadata: parsed.value.metadata ?? {},
        })
        .returning({ id: cart.id });
      if (!created) throw new Error("Inserting a Cart returned no row.");

      return read(tx, created.id);
    },
  );
}

/** The Region an Address falls in, or the one word saying this Store has not got it. */
type AddressRegion =
  | { readonly ok: true; readonly regionId: string | null }
  | CartRefused<typeof REGION_NOT_FOUND>;

/**
 * Which of the Store's Regions an Address falls in — **the whole of what writing one can
 * refuse**, asked apart from the write for that reason.
 *
 * `mutate` and `createCart` both return a refusal *out of* the transaction they are inside, so a
 * refusal commits whatever has already been written — the rule `collection-not-found` follows on
 * the admin surface, one noun along. Splitting the question from the write is what keeps a
 * refused correction from leaving an Address row no Cart points at.
 *
 * `null` for an Address that named no Region, which is an ordinary Address.
 */
async function addressFallsIn(
  tx: Transaction,
  parsed: ParsedAddress,
): Promise<AddressRegion> {
  if (parsed.regionId === undefined) return { ok: true, regionId: null };
  // In front of the read for the reason every other one on this surface is: a malformed uuid
  // raises inside Postgres, and an unhandled raise is a 500 about something that is not there.
  if (!isUuid(parsed.regionId)) return noSuchAddressRegion(parsed.regionId);

  const named = await readRegionIdentity(tx, parsed.regionId);
  return named === undefined
    ? noSuchAddressRegion(parsed.regionId)
    : { ok: true, regionId: named.id };
}

/**
 * Writes the Address a Cart is to carry — **the row it already has, where it has one**.
 *
 * A Cart carries one Address, so setting one again *replaces* it rather than leaving the old row
 * behind: nothing in kobai lists or deletes an Address of its own, so a create-per-correction
 * would accumulate rows no route can reach and no sweep knows about.
 *
 * **Updating the row in place is safe precisely because an Order holds no reference to it**
 * (ADR-0009). `core_order_address` is a copy taken at Capture, so a Shopper correcting the
 * Address on a Cart they placed from — or on a Cart they are still filling — reaches nothing
 * that has already been bought.
 *
 * **It refuses nothing**, which is the point: every caller has already asked
 * {@link addressFallsIn}, so by the time this runs there is nothing left that could turn the
 * request back after the row had been written.
 */
async function writeAddress(
  tx: Transaction,
  /** The Address this Cart already carries, or `null` for one that carries none. */
  existing: string | null,
  parsed: ParsedAddress,
  regionId: string | null,
): Promise<string> {
  const values = {
    country: parsed.country,
    // Copied out of the readonly array Drizzle will not take as it stands.
    lines: [...parsed.lines],
    postalCode: parsed.postalCode,
    regionId,
  };

  if (existing === null) {
    const [written] = await tx
      .insert(address)
      .values(values)
      .returning({ id: address.id });
    if (!written) throw new Error("Inserting an Address returned no row.");
    return written.id;
  }

  await tx.update(address).set(values).where(eq(address.id, existing));
  return existing;
}

/**
 * An `address.regionId` naming no Region this Store has.
 *
 * The same word and the same status a `regionId` on the Cart itself is refused with, because it
 * is the same fact — this Store has not got that Region — reached from one field along
 * (ADR-0060). The prose is its own, because the repairs read differently: one is about where the
 * Cart is bought and this is about where it goes.
 */
function noSuchAddressRegion(regionId: string): CartRefused<typeof REGION_NOT_FOUND> {
  return {
    ok: false,
    reason: REGION_NOT_FOUND,
    detail: `No Region ${JSON.stringify(regionId)} exists. \`address.regionId\` says which of this Store's geographies the Address falls in, and \`GET /admin/regions\` lists the ones it has. Leave it out for an Address that names none.`,
  };
}

/** Where a new Cart is bought and what it is denominated in, once the body has been read. */
type Denomination =
  | { readonly ok: true; readonly regionId: string | null; readonly currency: string }
  | CartRefused<"invalid" | typeof REGION_NOT_FOUND>;

/**
 * The Region a new Cart is in and the currency stamped from it.
 *
 * Three answers, and the third is the one worth knowing about: a Region the caller named, the
 * Store's default where they named none, and — where this deployment has no default Region at
 * all — **no Region and the Store's own default currency**. That last is a database that has
 * been migrated and never booted against (`store/seed.ts` seeds the Region at boot), and it is
 * answered rather than refused for the same reason a Cart written before the column existed
 * reads back: such a Cart is priced for the Store's default Region the moment there is one, in
 * the currency every Price it could be priced from already carries.
 */
async function denominate(
  db: Queryable,
  regionId: string | undefined,
): Promise<Denomination> {
  if (regionId !== undefined) {
    const named = await namedRegion(db, regionId);
    if (!named.ok) return named;
    return { ok: true, regionId: named.region.id, currency: named.region.currency };
  }

  const fallback = await readDefaultRegion(db);
  if (fallback) {
    return { ok: true, regionId: fallback.id, currency: fallback.currency };
  }

  const currency = await readDefaultCurrency(db);
  if (currency === undefined) {
    // A database holding no Store at all: migrated, and never seeded. Nothing here can invent
    // a currency for a Cart, and answering one denominated in nothing is not available — the
    // column is `not null` precisely so that no Cart is ever in that state.
    throw new Error(
      "This database holds no Store, so a Cart cannot be denominated. It is migrated but unseeded — `0001_seed_store.sql` is what creates that row.",
    );
  }
  return { ok: true, regionId: null, currency };
}

/**
 * The Region a body named, or the refusal — the two lines both writes would otherwise each
 * spell for themselves.
 *
 * The `isUuid` check is in front of the read for the reason every other one on this surface is:
 * a malformed identifier raises inside Postgres, and an unhandled raise is a 500 reporting a
 * broken server for a request about something that does not exist.
 */
async function namedRegion(
  db: Queryable,
  regionId: string,
): Promise<
  | { readonly ok: true; readonly region: RegionIdentity }
  | CartRefused<typeof REGION_NOT_FOUND>
> {
  if (!isUuid(regionId)) return noSuchRegion(regionId);
  const named = await readRegionIdentity(db, regionId);
  return named === undefined ? noSuchRegion(regionId) : { ok: true, region: named };
}

/**
 * Attaches — or detaches — a Shopper, rewrites the Cart's own open data, and **moves a Cart to
 * another Region, in place**.
 *
 * The route a storefront calls when a guest signs in half way through: the Cart is already
 * built, and what changes is who it is for. `shopper: null` puts it back to a guest's.
 *
 * **A Region switch keeps the Cart and every line on it** (#293, ADR-0074's amendment). A
 * Shopper who moves from USD to MYR is answered rather than changed under: a Cart's Line Items
 * carry no price snapshot (ADR-0009's deliberate asymmetry with an Order), so they are
 * re-priced on every read already and the switch costs nothing but the two columns. The
 * alternative the record used to carry — a new Cart — put the burden of not losing a Shopper's
 * basket on every storefront that integrates.
 *
 * Two things refuse it, and each is written where it is made below: something already
 * denominated against this Cart ({@link CART_IS_DENOMINATED}), and a line the new Region could
 * not price ({@link VARIANT_NOT_PRICED_IN_REGION}).
 */
export async function updateCart(
  db: Database,
  cartId: string,
  input: CartInput,
  keyKind: ApiKeyKind,
  market: CartMarketDependencies,
): Promise<
  CartResult<
    | "invalid"
    | "secret-key-required"
    | typeof REGION_NOT_FOUND
    | typeof CART_IS_DENOMINATED
    | typeof VARIANT_NOT_PRICED_IN_REGION
    | typeof SHIPPING_METHOD_NOT_FOUND
    | NotChangeable
  >
> {
  // Asked of the **keys the body carried** rather than of a narrowed set of changes, which is
  // the one `PATCH` on this surface that does it that way round and is deliberate (#185). A
  // Cart's fields do not narrow into columns one for one: `shopper` is three-valued and fills
  // *two*, and it is read by `parseCartInput`, which `createCart` shares and where an empty
  // result means a guest's Cart rather than a request that asks for nothing. The two orders are
  // indistinguishable to a caller — a body naming nothing is refused either way, and a body
  // naming something unusable reaches its own refusal either way — so what would be bought by
  // forcing the shape is a reading of `shopper` that two routes no longer agree on.
  if (
    input.shopper === undefined &&
    input.metadata === undefined &&
    input.regionId === undefined &&
    input.address === undefined &&
    input.shippingMethodId === undefined
  ) {
    return changesNothing(
      "a `shopper`, a `metadata`, a `regionId`, an `address`, a `shippingMethodId`, or several of them",
    );
  }

  const parsed = parseCartInput(input, keyKind);
  if (!parsed.ok) return parsed;

  return mutate<
    | typeof REGION_NOT_FOUND
    | typeof CART_IS_DENOMINATED
    | typeof VARIANT_NOT_PRICED_IN_REGION
    | typeof SHIPPING_METHOD_NOT_FOUND
  >(db, cartId, async (tx) => {
    // Only what the caller named, so a request about `metadata` alone does not quietly blank
    // the Shopper off the Cart — which is what makes `shopper` three-valued above.
    const changes: Partial<typeof cart.$inferInsert> = {};
    if (parsed.value.shopper !== undefined) {
      changes.shopperEmail = parsed.value.shopper?.email ?? null;
      changes.shopperExternalId = parsed.value.shopper?.externalId ?? null;
    }
    if (parsed.value.metadata !== undefined) changes.metadata = parsed.value.metadata;

    // **Every refusal is made before the first write, and that ordering is the decision.**
    // `mutate` hands a refusal back *out of* the transaction it is inside rather than throwing,
    // so the transaction commits — which means a row written in front of a refusal survives a
    // request the caller was told was turned down. That is the rule `collection-not-found`
    // already follows on the admin surface ("asked before the first write either route makes"),
    // and here it would leave an Address row no Cart points at, or a destination silently
    // rewritten by a `PATCH` answered 422.

    // The row the Cart is pointing at now, read under the `for update` `mutate` is holding, so
    // a second correction of the same Cart replaces the row this one wrote rather than racing it.
    let destination:
      | { readonly existing: string | null; readonly regionId: string | null }
      | undefined;
    let detached: string | null = null;
    if (parsed.value.address !== undefined) {
      const [holding] = await tx
        .select({ addressId: cart.addressId })
        .from(cart)
        .where(eq(cart.id, cartId))
        .limit(1);
      // Unreachable: `mutate` found and locked this row a statement ago.
      if (!holding) throw new Error("A locked Cart could not be read back.");

      if (parsed.value.address === null) {
        // `null` takes the Address off and takes the row with it. Nothing else can reach an
        // Address row, so leaving it would leave a row no route lists, reads or deletes — and
        // the Order's copy is in a table of its own, so nothing that has been bought is touched.
        changes.addressId = null;
        detached = holding.addressId;
      } else {
        const falls = await addressFallsIn(tx, parsed.value.address);
        if (!falls.ok) return falls;
        destination = { existing: holding.addressId, regionId: falls.regionId };
      }
    }

    // Where this Cart will be bought once this request has been applied — the Region it is
    // switching to, or `undefined` for one it is not moving. Both the choice of a delivery
    // method and the unchoosing of one are decided against *that*, because a rate belongs to
    // exactly one Region.
    let switchingTo: string | undefined;

    if (parsed.value.regionId !== undefined) {
      // Inside the transaction that holds this Cart's row `for update`, so a line added while
      // the switch is being judged is either already in the check below or waiting behind it —
      // the alternative is a Cart moved into a Region that cannot price something somebody put
      // in it a millisecond earlier.
      const switched = await switchRegion(tx, cartId, parsed.value.regionId, market);
      if (!switched.ok) return switched;

      changes.regionId = switched.regionId;
      // The stamp is taken here and nowhere else: from this moment the Cart's own column is
      // what denominates it, and the Region's currency moving does not reach it.
      changes.currency = switched.currency;
      switchingTo = switched.regionId;

      // **A switch unchooses the delivery method** (#321), because a rate belongs to one
      // Region: the one chosen in the old market is not on offer in the new one, and carrying
      // it over would charge a figure denominated in a currency this Cart is no longer in.
      // Overridden a few lines down by a body that also names a `shippingMethodId`, which is
      // how a storefront moves a Cart and rechooses in one request.
      changes.shippingMethodId = null;
    }

    if (parsed.value.shippingMethodId === null) {
      changes.shippingMethodId = null;
    } else if (parsed.value.shippingMethodId !== undefined) {
      // **Of the Region this Cart will be in**, which is what makes a rate from anywhere else
      // `shipping-method-not-found` rather than a charge in the wrong currency. A Cart that
      // names no Region at all — one started before kobai recorded any — can choose nothing,
      // and is told the same thing for the same reason.
      const regionId = await shippingRegionOf(
        tx,
        switchingTo ?? (await regionOfCart(tx, cartId)),
      );
      const method =
        regionId === null
          ? undefined
          : await readShippingMethodOf(tx, regionId, parsed.value.shippingMethodId);
      if (!method) return noSuchShippingMethod(parsed.value.shippingMethodId);
      changes.shippingMethodId = method.id;
    }

    // Past every refusal, so the writes below are the whole of what this request does.
    if (destination !== undefined && parsed.value.address != null) {
      // Written even when it is the identifier the Cart already holds, so the Cart's own
      // `updated_at` advances for a correction that only moved the Address (ADR-0037).
      changes.addressId = await writeAddress(
        tx,
        destination.existing,
        parsed.value.address,
        destination.regionId,
      );
    }

    await tx.update(cart).set(changes).where(eq(cart.id, cartId));
    // After the Cart has stopped pointing at it, so the delete meets no reference at all rather
    // than relying on the column's `set null` to clear one.
    if (detached !== null) await tx.delete(address).where(eq(address.id, detached));
    return undefined;
  });
}

/** The two columns a switch writes, or the one word saying why it was refused. */
type SwitchedRegion =
  | { readonly ok: true; readonly regionId: string; readonly currency: string }
  | CartRefused<
      | typeof REGION_NOT_FOUND
      | typeof CART_IS_DENOMINATED
      | typeof VARIANT_NOT_PRICED_IN_REGION
    >;

/**
 * Whether this Cart may move to that Region, and what it would then be denominated in.
 *
 * Three questions in this order, and the order is the decision:
 *
 * 1. **Is there such a Region.** The most fundamental answer, and the one a storefront
 *    interpolating the wrong variable needs first — being told its Cart is holding stock would
 *    send it after the wrong repair.
 * 2. **Is anything denominated against this Cart already.** Asked before the lines, because it
 *    is about the Cart as a whole: a Cart holding stock is refused whether or not its lines
 *    could be priced in the new Region, and pricing them first would spend a Workflow run per
 *    line to reach the same answer.
 * 3. **Could every line still be priced there.** Asked last and asked of *this deployment's*
 *    `resolve-price`, never of `core_price` — a Project that replaced `select-price` prices by
 *    its own rule, and a query here would refuse a switch that deployment could have priced
 *    (ADR-0017). It is the same declaration the quote and the placement run, so a switch this
 *    allows is a Cart those two can still answer.
 *
 * **Switching to the Region the Cart is already in is not a switch**, and is allowed rather than
 * refused: a storefront submitting the whole state it is holding sends the Region it last read,
 * and refusing that would make an idempotent request fail once a Shopper is holding stock.
 * `PATCH /admin/store` takes the `defaultCurrency` it already has on the same argument.
 */
async function switchRegion(
  tx: Transaction,
  cartId: string,
  regionId: string,
  market: CartMarketDependencies,
): Promise<SwitchedRegion> {
  const asked = await namedRegion(tx, regionId);
  if (!asked.ok) return asked;
  const named = asked.region;

  const [current] = await tx
    .select({ regionId: cart.regionId, currency: cart.currency })
    .from(cart)
    .where(eq(cart.id, cartId))
    .limit(1);
  // Unreachable: `mutate` found and locked this row a statement ago.
  if (!current) throw new Error("A locked Cart could not be read back.");
  if (current.regionId === named.id) {
    return { ok: true, regionId: named.id, currency: current.currency };
  }

  const denominated = await denominatedAgainst(tx, cartId);
  if (denominated) return denominated;

  const lines = await tx
    .select({ variantId: cartLineItem.variantId, sku: variant.sku })
    .from(cartLineItem)
    .innerJoin(variant, eq(variant.id, cartLineItem.variantId))
    // The Cart's own order, so a refusal names the lines in the order a storefront is
    // rendering them in rather than in whatever order Postgres read them.
    .orderBy(asc(cartLineItem.createdAt), asc(cartLineItem.id))
    .where(eq(cartLineItem.cartId, cartId));

  const unpriceable: string[] = [];
  for (const line of lines) {
    // In series rather than in parallel, exactly as `price-lines` runs: a Cart has few lines,
    // and a Step of somebody else's is not something to fan out inside a transaction that is
    // holding this Cart's row.
    const priced = await market.priceable(line.variantId, {
      // The Region's own currency and not the Cart's: this is the market the Cart is being
      // moved *to*, so what is being asked is whether the lines can be priced there.
      region: { id: named.id, name: named.name, currency: named.currency },
      channel: market.channel,
    });
    if (!priced) unpriceable.push(line.sku);
  }

  if (unpriceable.length > 0) {
    return {
      ok: false,
      reason: VARIANT_NOT_PRICED_IN_REGION,
      detail: `${unpriceable.map((sku) => JSON.stringify(sku)).join(", ")} ${unpriceable.length === 1 ? "has" : "have"} no Price that applies in ${JSON.stringify(named.name)}, which prices in ${named.currency}, so this Cart was left where it was. kobai converts nothing: a Variant is sellable in a Region once a Price denominated in that Region's currency has been set on it. Remove those lines, or price them there, and ask again.`,
    };
  }

  return { ok: true, regionId: named.id, currency: named.currency };
}

/**
 * What is already denominated against this Cart, or `undefined` where nothing is.
 *
 * **A live Reservation is the reachable half of the guard and the Payment is the other**, and
 * the Payment is refused a door earlier — see {@link CART_IS_DENOMINATED}. The hold is read
 * through `liveHoldOfCart`, which is the same expression claim-or-adopt decides by, so *is this
 * Cart holding stock* has one answer rather than two that can disagree (ADR-0070).
 *
 * **The lock is taken before the read, and it is the hold's own key** (ADR-0018). The Cart row
 * this transaction is holding `for update` says nothing about `core_reservation`, and a `select`
 * over other rows locks none of them — so without this a hold arriving between the read and the
 * commit would land on a Cart that has just changed market, which is precisely the state the
 * guard exists to make impossible. `lockCartHold` is `holdReservations`' own key rather than a
 * second one, on `auth/administrators.ts`'s argument: two correct guards on two keys serialise
 * nothing against each other.
 *
 * **There is deliberately no concurrent test beside it, and that is a departure worth arguing.**
 * Every other lock in Core has one — `the-cart-that-held-twice`, `the-last-administrator`,
 * `the-last-unit` — because each guards a state a sequential run cannot reach and an assertion
 * *can* see: stock claimed twice, a Store with no administrator. This one has no such state. A
 * hold and a switch dispatched together have two legitimate outcomes — the switch wins and the
 * hold is then taken in the new market, or the hold wins and the switch is refused — and the
 * interleaving this lock prevents produces a database **identical** to the first of them: a Cart
 * in the new Region with a live hold on it, because nothing on a Reservation records which
 * currency it was claimed under. So a concurrent test here could only assert what is true either
 * way, which is the trap ADR-0049 names and what writing-tests.md means by a green run proving
 * less than you would think. The lock is kept on ADR-0018's rule rather than on evidence, and
 * this paragraph is the evidence's replacement.
 */
async function denominatedAgainst(
  tx: Transaction,
  cartId: string,
): Promise<CartRefused<typeof CART_IS_DENOMINATED> | undefined> {
  await lockCartHold(tx, cartId);

  const [holding] = await tx
    .select({ expiresAt: reservation.expiresAt })
    .from(reservation)
    .where(liveHoldOfCart(cartId))
    .limit(1);
  if (!holding) return undefined;

  return {
    ok: false,
    reason: CART_IS_DENOMINATED,
    detail: `This Cart is holding stock that was claimed in the currency it is in, so it cannot be moved to another Region. The hold lapses at ${holding.expiresAt.toISOString()} and kobai serves no way to give one back by hand — it would take stock from a Shopper who may already have paid — so either wait for it, or start a new Cart in the Region you want.`,
  };
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
  /**
   * The Region named, if one was — **two-valued**, unlike `shopper`.
   *
   * There is no `null` for it: a Cart is always bought somewhere, so *no Region* is not a state
   * a caller may ask for. Absent means the Store's default at a create and *leave it* at a
   * correction, which is ADR-0062's rule and the same absence `description` refuses a `null` on.
   */
  readonly regionId?: string;
  /** The Address named — three-valued like `shopper`, because a Cart may carry none. */
  readonly address?: ParsedAddress | null;
  /** The delivery method named — three-valued too, because a Cart may have chosen none. */
  readonly shippingMethodId?: string | null;
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
  const value: {
    shopper?: AssertedShopper | null;
    metadata?: Record<string, unknown>;
    regionId?: string;
    address?: ParsedAddress | null;
    shippingMethodId?: string | null;
  } = {};

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

  if (input.regionId !== undefined) {
    const regionId = trimmed(input.regionId);
    if (regionId === undefined) {
      return invalid(
        "`regionId` must name a Region this Store has — `GET /admin/regions` lists them. Leave it out to start this Cart in the Store's default Region, or to leave the Region of one that already exists alone; there is no `null`, because a Cart is always bought somewhere.",
      );
    }
    value.regionId = regionId;
  }

  // Structural only, and the module that owns an Address is where that is written down
  // (ADR-0072): what comes back is a reading of the body, never a judgement about whether the
  // place exists or whether the postal code fits the country's format.
  if (input.address === null) {
    value.address = null;
  } else if (input.address !== undefined) {
    const parsed = parseAddress(input.address);
    if (!parsed.ok) return invalid(parsed.detail);
    value.address = parsed.value;
  }

  if (input.shippingMethodId === null) {
    value.shippingMethodId = null;
  } else if (input.shippingMethodId !== undefined) {
    const chosen = trimmed(input.shippingMethodId);
    if (chosen === undefined) {
      return invalid(
        "`shippingMethodId` must name one of the ways this Cart may be delivered — `GET /store/carts/{id}/shipping-options` lists them — or be `null` to unchoose.",
      );
    }
    value.shippingMethodId = chosen;
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

/**
 * A `regionId` naming no Region this Store has.
 *
 * **422 and `region-not-found`, which is the word the admin surface already answers** — one
 * fact gets one word whichever end asks it (ADR-0060), exactly as `collection-not-found` is
 * 404 from the Collection routes and 422 from a `collections` list naming one. It is
 * deliberately *not* the `400 invalid` a `?region=` gets on the price routes: that is a query
 * parameter the endpoint could not use, and this is a body naming a record the Store has not
 * got, which is the line this surface already draws for `?collection=` and `collections`.
 */
function noSuchRegion(regionId: string): CartRefused<typeof REGION_NOT_FOUND> {
  return {
    ok: false,
    reason: REGION_NOT_FOUND,
    detail: `No Region ${JSON.stringify(regionId)} exists. \`regionId\` names the Region this Cart is bought in — it decides what the Cart is denominated in and what its lines are priced at — and \`GET /admin/regions\` lists the ones this Store has.`,
  };
}

/**
 * The Region this Cart names, read under the lock `mutate` is already holding.
 *
 * `null` for a Cart that names none, which is one started before kobai recorded a Region or one
 * whose Region has since been deleted. **`shippingRegionOf` is what turns that into the rates
 * that apply** — the Store's default — because that is what such a Cart is *priced* for, and a
 * Cart offered a method it could then not choose would be one nothing could place.
 */
async function regionOfCart(tx: Transaction, cartId: string): Promise<string | null> {
  const [row] = await tx
    .select({ regionId: cart.regionId })
    .from(cart)
    .where(eq(cart.id, cartId))
    .limit(1);
  // Unreachable: `mutate` found and locked this row a statement ago.
  if (!row) throw new Error("A locked Cart could not be read back.");
  return row.regionId;
}

/**
 * A `shippingMethodId` naming no method this Cart's Region carries.
 *
 * **The same word `PATCH /admin/regions/{id}` answers**, because it is one fact — this Store has
 * no such shipping method — reached from the other end, and one fact gets one word whichever end
 * asks it (ADR-0060). It is **422** for `region-not-found`'s reason on this surface: a body
 * naming a record the Store has not got, rather than a query parameter the endpoint could not
 * use.
 *
 * **One answer for a method that does not exist and one belonging to another Region**, because
 * they are one mistake: this field takes a method *this Cart may be delivered by*, and neither
 * is one. Telling them apart would also let a storefront enumerate the rates of markets it is
 * not in.
 */
function noSuchShippingMethod(id: string): CartRefused<typeof SHIPPING_METHOD_NOT_FOUND> {
  return {
    ok: false,
    reason: SHIPPING_METHOD_NOT_FOUND,
    detail: `${JSON.stringify(id)} is not a way this Cart may be delivered. A shipping method belongs to the Region the Cart is being bought in — \`GET /store/carts/{id}/shipping-options\` lists the ones on offer — and \`null\` unchooses whichever one was picked.`,
  };
}

function noSuchVariant(variantId: string): CartRefused<"variant-not-found"> {
  return {
    ok: false,
    reason: "variant-not-found",
    detail: `No Variant ${JSON.stringify(variantId)} exists. A Line Item selects the Variant, which is the sellable thing, and never the Product.`,
  };
}
