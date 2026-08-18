import type { Database } from "../db/client.ts";
import { store } from "../db/schema.ts";
import { asMetadata, metadataDetail, trimmed } from "../input.ts";
import { readStore, type Store } from "./read.ts";

/**
 * Changing the Store — its name and its metadata, and **never** the currency it prices in.
 *
 * A `PATCH` of exactly the shape ADR-0062 settled for a Variant, because a Merchant editing
 * one record should not have to learn a second set of rules: an absent field means "leave it",
 * a named `metadata` is **replaced** rather than merged — a merge leaves no way to take a key
 * back out — and a body that would change nothing is refused rather than answered 200.
 *
 * There is no `where` clause and no identifier anywhere here, for `readStore`'s reason: one
 * deployment serves exactly one Store (ADR-0005), so there is nothing to scope by. A parameter
 * added to this function is the first move of a multi-tenancy retrofit.
 *
 * **The default currency is accepted and never moved, and ADR-0065 is where that argument
 * lives** — that every Price already written is denominated in the current code and says so
 * nowhere a change here could repair, so moving the column reinterprets each of those amounts
 * rather than converting them; that the refusal is unconditional rather than narrowed to "when
 * Prices exist", because refusing can be relaxed later and allowing cannot be tightened
 * (ADR-0060); that the code the Store already prices in is accepted so a form round-trips; and
 * why the word is its own rather than `setPrice`'s `unsupported-currency`. Read it before
 * adding a field here or a refusal to it.
 *
 * **The check is a read followed by a write, and that is safe here for one reason only**: no
 * code path in kobai writes `default_currency` after the seed, this route being what
 * guarantees it, so the value read cannot move under the transaction. The day anything can
 * change it, this becomes ADR-0018's forbidden shape and needs the write to carry the check —
 * `update … where default_currency = <what was read>` is the one-statement form.
 */

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type UpdateStoreInput = {
  readonly name?: unknown;
  readonly defaultCurrency?: unknown;
  readonly metadata?: unknown;
};

/** Changing the Store refuses in two ways, and only the second is about the Store's state. */
export type StoreUpdate =
  | { readonly ok: true; readonly store: Store }
  | {
      readonly ok: false;
      readonly reason: "invalid" | "default-currency-is-fixed";
      readonly detail: string;
    };

export async function updateStore(
  db: Database,
  input: UpdateStoreInput,
): Promise<StoreUpdate> {
  const changes: { name?: string; metadata?: Record<string, unknown> } = {};

  if (input.name !== undefined) {
    const name = trimmed(input.name);
    if (name === undefined) {
      return {
        ok: false,
        reason: "invalid",
        detail: "`name` must be a non-empty string.",
      };
    }
    changes.name = name;
  }

  if (input.metadata !== undefined) {
    const metadata = asMetadata(input.metadata);
    if (metadata === undefined) {
      return { ok: false, reason: "invalid", detail: metadataDetail("metadata") };
    }
    changes.metadata = metadata;
  }

  let asked: string | undefined;
  if (input.defaultCurrency !== undefined) {
    const currency = trimmed(input.defaultCurrency);
    if (currency === undefined) {
      return {
        ok: false,
        reason: "invalid",
        detail: '`defaultCurrency` must be an ISO 4217 code, e.g. "USD".',
      };
    }
    asked = currency.toUpperCase();
  }

  // Nothing named at all is refused before the database is asked anything, exactly as
  // `updateVariant` refuses it: there is no state that could make this request meaningful.
  // A body naming only `defaultCurrency` is left to the transaction below, because *there* the
  // answer depends on what the Store holds — a different code is a refusal of its own, and the
  // one it already prices in is this same nothing.
  if (asked === undefined && Object.keys(changes).length === 0) return changesNothing();

  return db.transaction(async (tx) => {
    const current = await readStore(tx);
    if (!current) {
      throw new Error("No Store exists. The database is migrated but unseeded.");
    }

    if (asked !== undefined && asked !== current.defaultCurrency) {
      return {
        ok: false,
        reason: "default-currency-is-fixed",
        detail: `This Store prices in ${current.defaultCurrency}, and its default currency cannot be changed. Every Price already set carries ${current.defaultCurrency} — a Price may hold no other currency (ADR-0008) — so moving it would reinterpret each of those amounts as ${asked} rather than convert them. A second currency belongs to a Region, and Regions are not in this Store yet.`,
      } as const;
    }

    // Reached when the body named the currency this Store already prices in and nothing else.
    // Refused rather than answered 200, because it is the same request as `{}`: a request that
    // changes nothing is more likely a mistake than an intention.
    if (Object.keys(changes).length === 0) return changesNothing();

    const [updated] = await tx.update(store).set(changes).returning({
      name: store.name,
      defaultCurrency: store.defaultCurrency,
      metadata: store.metadata,
    });
    if (!updated) throw new Error("Updating the Store returned no row.");

    return { ok: true, store: updated } as const;
  });
}

/**
 * What a body naming nothing this route would change is told — and where the currency is
 * answered, because that is the one field a Merchant may have been reaching for.
 */
function changesNothing(): StoreUpdate {
  return {
    ok: false,
    reason: "invalid",
    detail:
      "Name a `name`, a `metadata`, or both. A request that changes nothing is more likely a mistake than an intention. `defaultCurrency` is not changed here: naming the one this Store already prices in changes nothing, and naming another is refused — every Price already set carries the current one.",
  };
}
