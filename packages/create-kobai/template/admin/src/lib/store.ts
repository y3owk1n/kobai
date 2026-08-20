import type { EnabledCurrency } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import type { ListboxOption } from "@/components/listbox-field";
import { currencyLabel } from "@/lib/currencies";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The currencies a control may offer — read from kobai, in one place (#291, ADR-0074).
 *
 * **A picker over a set kobai names is read from kobai, never written down here** (ADR-0063),
 * and this is the sharpest case of that rule in the Admin: the alternative is a list of the
 * world's ISO 4217 codes in a `const`, which offers a Merchant several hundred currencies of
 * which their Store prices in one or two, and every one of the others is a refusal waiting to
 * happen. What a Region may select is what the Store has enabled, and the Store is what knows.
 *
 * **A module on the second use**, which is `lib/collections.ts`'s lesson one noun along: the New
 * Region form and the Region screen's currency field ask the same question in the same words.
 *
 * It reads `GET /admin/store` rather than a list route of its own, because that is where the set
 * is: the enabled currencies are a field of the Store, for the reason `store/currency.ts`
 * argues.
 */

/**
 * Its own cache key, deliberately not the Store screen's.
 *
 * That screen holds a form over the whole record and invalidates on every save; a picker that
 * shared the key would re-render mid-edit for a change to the Store's name.
 */
const ENABLED = "enabled-currencies";

/**
 * What a caller needs: the codes, as options, whether the read has really happened, and why it
 * did not.
 *
 * The same four `lib/markets.ts` answers with, deliberately — a picker over a set kobai names
 * has the same three states wherever it is, and a module that reported only two of them left
 * its callers no way to render the third (#311).
 */
export type EnabledCurrencies = {
  readonly currencies: readonly EnabledCurrency[];
  /** The same set as `{ value, label }`, because both callers hand it to a `ListboxField`. */
  readonly options: readonly ListboxOption[];
  /**
   * Whether kobai has actually answered.
   *
   * The half that is easy to get wrong: until this is `true` the list is empty for want of an
   * answer rather than because the Store has one currency — so a field that said *this Store
   * prices in one currency* before kobai replied would be announcing the state it exists to
   * help change, for the length of a round trip and permanently if the read failed.
   */
  readonly answered: boolean;
  readonly isPending: boolean;
  /**
   * Why the read failed, or `null` — what {@link answered} being `false` for ever means.
   *
   * It is here rather than left to `answered`, and that is the whole of #311: every one of the
   * three currency pickers rendered an empty list on a failed `GET /admin/store`, which is
   * exactly what a Store that has enabled nothing looks like. A Merchant was then told to enable
   * a currency on a screen whose own read had just failed. It is `unknown` rather than an
   * `Error` because what kobai turned the read back with is a refusal body — `problemOf` in
   * `lib/refusal.ts` is what a caller passes it to.
   */
  readonly error: unknown;
};

export function useEnabledCurrencies(): EnabledCurrencies {
  const client = useKobaiClient();

  const query = useQuery({
    queryKey: [ENABLED],
    queryFn: async () => orThrow(await client.GET("/admin/store")),
  });

  const currencies = query.data?.currencies ?? EMPTY;

  return {
    currencies,
    // **The code carries its name, and this is the one place that is decided** (#300). It used
    // to be the code alone, on the argument that writing `US Dollar` here would be a table of
    // the world in the module that exists to remove one — which `lib/currencies.ts` answered:
    // the name comes from `Intl.DisplayNames`, so it is the browser's and not ours. Every
    // currency picker in this Admin reads these options, so a label decided here is why none of
    // them shows a bare code where another shows a named one.
    options: optionsOf(currencies),
    answered: query.isSuccess,
    isPending: query.isPending,
    error: query.isError ? query.error : null,
  };
}

/**
 * Why the enabled currencies could not be read, in words a Merchant can act on — or `null` (#311).
 *
 * **One sentence rather than three**, which is `lib/currencies.ts`'s lesson one question along:
 * three screens offer this set — the Region screen, the New Region form and the Price editor —
 * and each of them has to tell a failed read apart from a Store that has enabled nothing. A
 * fourth spelling of *kobai did not say* is the thing this rules out, and there would have been
 * three of them the day the third picker was written. `lib/markets.ts` carries the same function
 * for Regions and for Channels, and every picker over a set kobai names now reaches for one.
 *
 * It answers `null` for a read that has not failed, so a caller reaches for `??` and keeps its
 * own prose for the states that are not failures — what is worth saying about an empty list, or
 * about the Region a Price is being denominated for, is the caller's and not this module's.
 */
export function whyCurrenciesNotRead(currencies: EnabledCurrencies): string | null {
  if (currencies.error === null) return null;
  return problemOf(
    currencies.error,
    "kobai did not say which currencies this Store has enabled.",
  );
}

/** One array for "kobai has not answered", so a caller's memo is not defeated by a fresh `[]`. */
const EMPTY: readonly EnabledCurrency[] = [];

/**
 * The same set as `{ value, label }`, cached against the array it was built from.
 *
 * TanStack Query hands back the same `data` until it refetches, so keying on that array is what
 * lets a caller's `useMemo` actually hold — and one caller says so in as many words:
 * `components/combobox-field.tsx` reads a new list of options as a new answer to what is on
 * offer. A `map` in the return above rebuilt it on every render and quietly defeated that.
 */
const asOptions = new WeakMap<readonly EnabledCurrency[], readonly ListboxOption[]>();

function optionsOf(currencies: readonly EnabledCurrency[]): readonly ListboxOption[] {
  const held = asOptions.get(currencies);
  if (held !== undefined) return held;

  const options = currencies.map((one) => ({
    value: one.code,
    label: currencyLabel(one.code),
  }));
  asOptions.set(currencies, options);
  return options;
}
