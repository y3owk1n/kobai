import type { EnabledCurrency } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import type { ListboxOption } from "@/components/listbox-field";
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

  const currencies = query.data?.currencies ?? [];

  return {
    currencies,
    // The code is the label: a currency has no second name kobai holds, and inventing
    // `US Dollar` here would be a table of the world in the place this module exists to remove
    // one from.
    options: currencies.map((one) => ({ value: one.code, label: one.code })),
    answered: query.isSuccess,
    isPending: query.isPending,
  };
}
