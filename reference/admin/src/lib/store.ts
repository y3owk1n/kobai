import type { EnabledCurrency } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import type { ListboxOption } from "@/components/listbox-field";
import { currencyLabel } from "@/lib/currencies";
import { orThrow } from "@/lib/refusal";
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

/** What a caller needs: the codes, as options, and whether the read has really happened. */
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
  };
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
