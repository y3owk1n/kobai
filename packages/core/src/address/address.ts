import { alias } from "drizzle-orm/pg-core";
import { joined } from "../db/join.ts";
import { address, region } from "../db/schema.ts";
import type { RegionIdentity } from "../store/region.ts";

/**
 * An **Address** — where something goes, and the one rule Core holds about one (ADR-0072).
 *
 * **Core owns the entity and validates only its shape.** ADR-0015 puts Shopper-supplied input on
 * the Project's side, and a delivery address is Shopper-supplied — ADR-0072 is where following
 * that letter was argued down, on the test that separates the two: the printing customer's
 * uploaded artwork has no meaning to Core and no two businesses want the same validation of it,
 * whereas an Address is an input to Core's own Steps. Shipping, tax and Fulfilment are all
 * computed *from* one.
 *
 * So what lives here is a **structural** reading and nothing else. Whether `"ZZZZZZ"` is a
 * postal code anybody in Malaysia would recognise is a rule for a Project or a Plugin, and kobai
 * refuses none of them — `cart/an-address-on-a-cart.test.ts` places an Order for an address no
 * postal authority would accept, which is what makes that a promise rather than an omission.
 * This is `http/contract.ts`'s existing rule in the module that owns it: schemas are structural,
 * and "whether an address looks like one" stays here.
 *
 * **There are two shapes and they are declared apart** (#207's split, and ADR-0009's).
 * {@link Address} is the live row a Cart carries; {@link OrderAddress} is the copy Capture took,
 * and it names its Region by a snapshotted name rather than by a join, so nothing underneath it
 * can be edited or deleted.
 */

/** The whole of an Address as a caller writes one — unvalidated, because it arrives as JSON. */
export type AddressInput = {
  readonly country?: unknown;
  readonly lines?: unknown;
  readonly postalCode?: unknown;
  readonly regionId?: unknown;
};

/** An Address once it has been read: the columns, with the Region still to be resolved. */
export type ParsedAddress = {
  readonly country: string;
  readonly lines: readonly string[];
  readonly postalCode: string | null;
  /** Absent where the caller named no Region; there is no `null`, because absent already is. */
  readonly regionId?: string;
};

/**
 * An Address as a **Cart** reports it — the live row, with its Region joined.
 *
 * No `id`: nothing addresses an Address, there is no route that reads or writes one on its own,
 * and publishing an identifier is how a route that does not exist gets asked for. A Cart carries
 * one Address and the Cart's own identifier is the authority over it (ADR-0020).
 */
export type Address = {
  readonly country: string;
  readonly lines: readonly string[];
  readonly postalCode: string | null;
  /**
   * Which of the Store's Regions this Address falls in, or `null` for one that named none —
   * including one whose Region has since been deleted, which clears the reference and leaves the
   * destination whole (`core_address.region_id`).
   */
  readonly region: RegionIdentity | null;
};

/**
 * An Address as an **Order** reports it — a snapshot, and it looks nothing like a Cart's.
 *
 * `country`, `lines` and `postalCode` were copied at Capture, so correcting the Address on the
 * Cart, replacing it, removing it, or deleting the Region it named does not reach any of them
 * (ADR-0009). The Region is the one thing here that is not purely a copy, and it is split the
 * way a Line Item's `variantId` and `title` are: an identifier for navigation, which goes `null`
 * once the Region is deleted, and a **name** taken at Capture, which does not.
 *
 * **It names its Region with two fields where {@link Address} uses `RegionIdentity`'s three**,
 * and the difference is the snapshot rather than an inconsistency: a copy joins nothing, so every
 * field here has to be *copied*, and a copied currency on a destination would be a second
 * currency on an Order nothing was ever charged in.
 */
export type OrderAddress = {
  readonly country: string;
  readonly lines: readonly string[];
  readonly postalCode: string | null;
  readonly region: OrderAddressRegion | null;
};

/** The Region an Order's Address named, as at Capture. */
export type OrderAddressRegion = {
  /** For navigation only — `null` once that Region has been deleted. Never for display. */
  readonly id: string | null;
  /** What it was called at Capture. Renaming the Region does not reach this. */
  readonly name: string;
};

/**
 * The Region an Address falls in, under a name of its own.
 *
 * A Cart already joins `core_region` for the Region it is *bought* in, and these are two
 * different facts about one Cart — where it is being bought, and where it is going. Without the
 * alias the second join is the same table twice under one name, which Postgres refuses.
 *
 * Exported so the two readers below share it: `cart/read.ts` joins both and
 * `order/load-cart.ts` joins only this, and two aliases spelled the same in two files is the
 * thing that goes wrong quietly when one of them is renamed.
 */
export const addressRegion = alias(region, "core_cart_address_region");

/**
 * The Address columns every reader of a **live** Address selects, and the join that fills them.
 *
 * Two selections rather than one nested object, because the Region comes from a second join and
 * so cannot sit inside the first. `id` is selected and never reported: {@link addressOf} reads it
 * to tell an Address from a join that found none.
 *
 * Written once because there are two readers and they must agree about what a Cart's Address is:
 * `cart/read.ts` answers a storefront with it and `order/load-cart.ts` reads it for Capture to
 * copy, and a second reading of it would be a second answer to where the parcel goes.
 */
export const addressColumns = {
  address: {
    id: address.id,
    country: address.country,
    lines: address.lines,
    postalCode: address.postalCode,
  },
  addressRegion: {
    id: addressRegion.id,
    name: addressRegion.name,
    currency: addressRegion.currency,
  },
} as const;

/** What {@link addressOf} reads — the two halves of the join, either of which may have found none. */
export type JoinedAddress = {
  readonly address: {
    readonly id: string;
    readonly country: string;
    readonly lines: readonly string[];
    readonly postalCode: string | null;
  } | null;
  readonly addressRegion: {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
  } | null;
};

/**
 * The Address a Cart carries, or `null` where it carries none.
 *
 * `joined` on both halves rather than `?? null`, for the reason that helper exists: Drizzle
 * answers an unjoined nested selection as an object of `null`s, which is truthy.
 */
export function addressOf(row: JoinedAddress): Address | null {
  const found = joined(row.address);
  if (!found) return null;

  return {
    country: found.country,
    lines: found.lines,
    postalCode: found.postalCode,
    region: joined<RegionIdentity>(row.addressRegion),
  };
}

/**
 * The same Address as Capture will write it — the live one with its Region reduced to a copy.
 *
 * The currency goes because a snapshot joins nothing: see {@link OrderAddress}. It is derived
 * from {@link addressOf} rather than read separately, so the Cart a storefront sees and the Cart
 * a placement copies cannot describe two different destinations.
 */
export function addressToSnapshot(row: JoinedAddress): OrderAddress | null {
  const found = addressOf(row);
  if (!found) return null;

  return {
    country: found.country,
    lines: found.lines,
    postalCode: found.postalCode,
    region:
      found.region === null ? null : { id: found.region.id, name: found.region.name },
  };
}

/** A reading that did not fit, with the sentence saying what would. */
export type AddressRefused = { readonly ok: false; readonly detail: string };

export type ParsedAddressResult =
  | { readonly ok: true; readonly value: ParsedAddress }
  | AddressRefused;

/**
 * Reads an Address off a request body — **shape, and nothing beyond it** (ADR-0072).
 *
 * Four questions, and every one of them is about the value rather than about the country it
 * claims to be in: is there a country code of the right length, is there at least one line, is
 * every line something somebody wrote, and — where one was named — is `regionId` a string. What
 * is deliberately *not* asked is whether the postal code fits the country's format, whether the
 * lines are in the order that country writes them, or whether the place exists.
 *
 * **The country is upper-cased and everything else is stored as it was written.** A code is a
 * code, and `my` and `MY` are the same country said twice; a street is prose Core does not own,
 * exactly as a Shopper's email is stored as the storefront wrote it (ADR-0020).
 */
export function parseAddress(input: unknown): ParsedAddressResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return refuse(
      "`address` must be an object with a `country` and at least one line, or `null` to take the Address off this Cart.",
    );
  }
  const asked = input as AddressInput;

  const country = trimmed(asked.country);
  if (country === undefined || country.length !== 2) {
    return refuse(
      "`address.country` must be an ISO 3166-1 alpha-2 code — two letters, such as `MY` or `SG`. kobai holds no table of countries and refuses no code it has never heard of; what it cannot hold is an address whose country is not a code, because shipping and tax are both worked out from one.",
    );
  }

  if (!Array.isArray(asked.lines) || asked.lines.length === 0) {
    return refuse(
      "`address.lines` must be a non-empty array of strings — the address as it should be read, in that order. kobai models no `city` and no `state`, because address formats differ by country to a degree no library settles (ADR-0072): write the lines the way that country writes them.",
    );
  }
  const lines: string[] = [];
  for (const line of asked.lines) {
    const written = trimmed(line);
    if (written === undefined) {
      return refuse(
        "Every entry of `address.lines` must be a non-empty string. An empty line says a Shopper wrote one and left it blank; leave it out instead.",
      );
    }
    lines.push(written);
  }

  const postalCode =
    asked.postalCode === undefined || asked.postalCode === null
      ? null
      : trimmed(asked.postalCode);
  if (postalCode === undefined) {
    return refuse(
      "`address.postalCode` must be a non-empty string, `null`, or absent. Several countries have no postal code at all, so kobai requires none — but an empty string would say a Shopper had written one.",
    );
  }

  if (asked.regionId === undefined) {
    return { ok: true, value: { country: country.toUpperCase(), lines, postalCode } };
  }

  const regionId = trimmed(asked.regionId);
  if (regionId === undefined) {
    return refuse(
      "`address.regionId` must name a Region this Store has — `GET /admin/regions` lists them — or be left out. It says which of the Store's geographies this Address falls in; there is no `null`, because leaving it out already says that.",
    );
  }

  return {
    ok: true,
    value: { country: country.toUpperCase(), lines, postalCode, regionId },
  };
}

/** A non-empty string, trimmed, or `undefined` for anything else — including `""`. */
function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cut = value.trim();
  return cut === "" ? undefined : cut;
}

function refuse(detail: string): AddressRefused {
  return { ok: false, detail };
}
