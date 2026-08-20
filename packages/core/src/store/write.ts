import type { Database } from "../db/client.ts";
import { store } from "../db/schema.ts";
import { trimmed } from "../input.ts";
import { changesFrom, changesNothing, openData, text } from "../patch.ts";
import {
  type CURRENCY_IN_USE,
  type DEFAULT_CURRENCY_MUST_BE_ENABLED,
  parseEnabledCurrencies,
  setEnabledCurrencies,
} from "./currency.ts";
import { readStore, type Store } from "./read.ts";
import { type REGION_NOT_FOUND, unknownRegion } from "./region.ts";

/**
 * Changing the Store — its name, its metadata, the currencies it may price in, the Region it
 * falls back to, and **never** the currency it prices in by default.
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
 * lives** — that every unconstrained Price is denominated in the current code and says so
 * nowhere a change here could repair, so moving the column reinterprets those amounts rather
 * than converting them; that the refusal is unconditional rather than narrowed to "when Prices
 * exist", because refusing can be relaxed later and allowing cannot be tightened (ADR-0060);
 * that the code the Store already prices in is accepted so a form round-trips; and why the word
 * is its own rather than `setPrice`'s `unsupported-currency`. **ADR-0074 narrowed that argument
 * and did not weaken the rule**: a Price now names its own currency, so what moving the default
 * reinterprets is the *unconstrained* Prices rather than every Price — which is why the enabled
 * set below may never drop it. Read both before adding a field here or a refusal to it.
 *
 * **The check is a read followed by a write, and that is safe here for one reason only**: no
 * code path in kobai writes `default_currency` after the seed, this route being what
 * guarantees it, so the value read cannot move under the transaction. The day anything can
 * change it, this becomes ADR-0018's forbidden shape and needs the write to carry the check —
 * `update … where default_currency = <what was read>` is the one-statement form. The two
 * fields #291 added are not that shape: the currency set is judged and written inside one
 * transaction against the row it locks by writing, and `defaultRegion` rests on a foreign key.
 */

/** Unvalidated: it arrives as a JSON body, and everything below narrows it in one place. */
export type UpdateStoreInput = {
  readonly name?: unknown;
  readonly defaultCurrency?: unknown;
  readonly currencies?: unknown;
  readonly defaultRegion?: unknown;
  readonly metadata?: unknown;
};

/** Changing the Store refuses in five ways, and only the first is about the request. */
export type StoreUpdate =
  | { readonly ok: true; readonly store: Store }
  | {
      readonly ok: false;
      readonly reason:
        | "invalid"
        | "default-currency-is-fixed"
        | typeof DEFAULT_CURRENCY_MUST_BE_ENABLED
        | typeof CURRENCY_IN_USE
        | typeof REGION_NOT_FOUND;
      readonly detail: string;
    };

export async function updateStore(
  db: Database,
  input: UpdateStoreInput,
): Promise<StoreUpdate> {
  // No `whenNothing`, deliberately: a body naming only `defaultCurrency` has named something,
  // and whether *that* changes nothing is a question about the row. So this route asks twice,
  // below, and both times with the same words. `currencies` is beside this table rather than in
  // it for the reason a Product's options are: it is **rows** rather than a column, so a body
  // naming only that one leaves the changes here empty while having asked for plenty.
  const usable = changesFrom(
    { name: input.name, metadata: input.metadata },
    { name: text("name"), metadata: openData("metadata") },
  );
  if (!usable.ok) return usable;
  const changes = usable.changes;

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

  let currencies: string[] | undefined;
  if (input.currencies !== undefined) {
    const parsed = parseEnabledCurrencies(input.currencies);
    if (!parsed.ok) return parsed;
    currencies = parsed.value;
  }

  let defaultRegionId: string | undefined;
  if (input.defaultRegion !== undefined) {
    const named = trimmed(input.defaultRegion);
    if (named === undefined) {
      return {
        ok: false,
        reason: "invalid",
        detail:
          "`defaultRegion` must be the `id` of a Region this Store has — `GET /admin/regions` lists them. There is no way to say *no default Region*: a storefront that names none is answered for this one.",
      };
    }
    defaultRegionId = named;
  }

  // Nothing named at all is refused before the database is asked anything, exactly as
  // `updateVariant` refuses it: there is no state that could make this request meaningful.
  // A body naming only `defaultCurrency` is left to the transaction below, because *there* the
  // answer depends on what the Store holds — a different code is a refusal of its own, and the
  // one it already prices in is this same nothing.
  if (
    asked === undefined &&
    currencies === undefined &&
    defaultRegionId === undefined &&
    Object.keys(changes).length === 0
  ) {
    return CHANGES_NOTHING;
  }

  return db.transaction(async (tx) => {
    const current = await readStore(tx);
    if (!current) {
      throw new Error("No Store exists. The database is migrated but unseeded.");
    }

    if (asked !== undefined && asked !== current.defaultCurrency) {
      return {
        ok: false,
        reason: "default-currency-is-fixed",
        detail: `This Store prices in ${current.defaultCurrency}, and its default currency cannot be changed. Every Price carrying no Region and no Channel is denominated in ${current.defaultCurrency} — so moving it would reinterpret each of those amounts as ${asked} rather than convert them (ADR-0065, ADR-0074). Another currency is *enabled* rather than made the default: send it in \`currencies\`, and select it on a Region.`,
      } as const;
    }

    // Both of #291's fields are judged before the first write, for `collectionsThisStoreDoesNotHave`'s
    // reason: a refusal returned from inside a transaction commits it, so a Region judged after
    // the currencies had been rewritten would answer 422 over a Store whose set really had
    // changed.
    if (defaultRegionId !== undefined) {
      const missing = await unknownRegion(tx, defaultRegionId);
      if (missing) return missing;
    }

    if (currencies !== undefined) {
      const refused = await setEnabledCurrencies(tx, current.defaultCurrency, currencies);
      if (refused) return refused;
    }

    // Reached when the body named the currency this Store already prices in and nothing else.
    // Refused rather than answered 200, because it is the same request as `{}`: a request that
    // changes nothing is more likely a mistake than an intention. The set and the Region are
    // *not* asked this question: sending the set a Store already has is sending the whole of a
    // field, exactly as `metadata` is, and neither is the one field whose only meaning is that
    // it may not move.
    if (
      currencies === undefined &&
      defaultRegionId === undefined &&
      Object.keys(changes).length === 0
    ) {
      return CHANGES_NOTHING;
    }

    if (defaultRegionId !== undefined || Object.keys(changes).length > 0) {
      await tx.update(store).set({
        ...changes,
        // `!== undefined` and never truthiness, which is the same distinction every field
        // here rests on: absent means "leave it" (ADR-0062), and a falsy value that had got
        // this far would be a value to write rather than a field nobody named.
        ...(defaultRegionId !== undefined ? { defaultRegionId } : {}),
      });
    }

    // Read back rather than assembled from what was written: the enabled set is rows and the
    // default Region is a join, so a hand-built answer would be a second reading of the same
    // Store that could disagree with `GET /admin/store`.
    const updated = await readStore(tx);
    if (!updated) throw new Error("Updating the Store returned no row.");

    return { ok: true, store: updated } as const;
  });
}

/**
 * What a body naming nothing this route would change is told — and where the currency is
 * answered, because that is the one field a Merchant may have been reaching for.
 *
 * A constant rather than a call at each of the two sites that reach it, so the sentence is
 * written once here as well as once in `patch.ts`.
 */
const CHANGES_NOTHING = changesNothing(
  "a `name`, a `metadata`, a `currencies`, a `defaultRegion`, or any of them",
  "`defaultCurrency` is not changed here: naming the one this Store already prices in changes nothing, and naming another is refused — every Price carrying no Region and no Channel is denominated in the current one. A second currency is enabled with `currencies` and selected on a Region.",
);
