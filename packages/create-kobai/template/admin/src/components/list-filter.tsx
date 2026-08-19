import { useSearchParams } from "react-router";
import { LinkButton } from "@/components/link-button";

/** One value on offer: the word kobai knows it by, and what the filter calls it on screen. */
export type FilterOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

/**
 * Narrowing a list, as addresses rather than as a control with a value (#228, #252).
 *
 * **Written once because the second copy of it was already verbatim.** The Carts list narrows by
 * `?state=` and the Products list by `?status=`, and the two screens had the same nav, the same
 * "which one is in force" comparison and the same three comments between them — which is the
 * shape `components/listbox-field.tsx` exists to stop happening a third time (#245): each defect
 * in a composition copied by hand is then fixed by hand, once per copy, with nothing going red
 * for the one that was missed. `?collection=` on this same Products list is the third
 * (#209), so extracting on the second is not early.
 *
 * Three things it decides, and none of them is a preference:
 *
 * - **Links, not a `Select`.** Each value *is* a URL, so a Merchant can send "the live Carts" or
 *   "my drafts" to a colleague, a refresh lands back on it, and the back button walks between
 *   them — the same bargain `components/pager.tsx` makes with the cursor, and the reason both
 *   live in the query string. A control beside the table would be the same list behind a value
 *   nothing outside that tab can see.
 * - **Choosing one drops the cursor**, because a cursor locates a page of the list that issued
 *   it: carrying one across a filter asks for the middle of a list nobody was looking at. That
 *   is why the `to` here is built from the parameter alone rather than from the current search.
 *   Paging *within* a filter keeps it, which is the `Pager`'s half of the same rule — it carries
 *   the rest of the query string over untouched.
 * - **`aria-current` says which is in force**, because the filled recipe is a colour and a colour
 *   says nothing to anybody listening.
 *
 * What each caller keeps is what is genuinely its own: which list this is, what the values are
 * called, and what to show when the address names one kobai does not have.
 */
export function ListFilter<Value extends string>({
  label,
  section,
  parameter,
  asked,
  options,
}: {
  /** What the group of links is called — "Filter the Carts". Read by a screen reader only. */
  readonly label: string;
  /** Where this section lives, exactly as `app.tsx` and `lib/sections.ts` spell it. */
  readonly section: string;
  /** The query parameter, spelled as the route spells it. */
  readonly parameter: string;
  /**
   * What the **address** asks for, and deliberately not the value it narrowed to.
   *
   * Compared as it stands, so that an address naming a value kobai does not have marks none of
   * the links. Against the narrowed one it would mark "All", announcing a filter as in force on
   * the one screen that is saying there is none.
   */
  readonly asked: string | null;
  /** Everything on offer, in the order it is offered. "All" is prepended and is not one. */
  readonly options: readonly FilterOption<Value>[];
}) {
  return (
    <nav aria-label={label} className="mb-4 flex flex-wrap gap-2">
      {[undefined, ...options].map((option) => {
        const inForce = (option?.value ?? null) === asked;
        return (
          <LinkButton
            key={option?.value ?? "all"}
            to={{
              pathname: section,
              search: option === undefined ? "" : `?${parameter}=${option.value}`,
            }}
            size="sm"
            variant={inForce ? "default" : "outline"}
            aria-current={inForce ? "page" : undefined}
          >
            {option === undefined ? "All" : option.label}
          </LinkButton>
        );
      })}
    </nav>
  );
}

/**
 * What the address asks this list to narrow to, and whether kobai has such a value.
 *
 * The other half of {@link ListFilter}, and the half that is easy to get subtly wrong. An address
 * a Merchant typed or was sent can name anything at all, and **both** obvious answers are worse
 * than saying so: filtering by nothing shows the whole table under a heading claiming otherwise,
 * and sending the word on spends a round trip to be refused with `invalid`. So a screen asks
 * here, keys its query on `asked` rather than on `value` — a word kobai does not have is then its
 * own cache key rather than the unfiltered list's — and renders its own empty state for
 * {@link ListFilterState.unknownValue}.
 */
export function useListFilter<Value extends string>(
  parameter: string,
  offered: readonly Value[],
): ListFilterState<Value> {
  const [params] = useSearchParams();
  const asked = params.get(parameter);
  const value = offered.find((one) => one === asked);
  return {
    asked,
    value,
    unknownValue: asked !== null && value === undefined ? asked : null,
  };
}

/** What {@link useListFilter} answers: the three readings of one query parameter. */
export type ListFilterState<Value extends string> = {
  /** What the address said, or `null` where it said nothing. The cache key. */
  readonly asked: string | null;
  /** The value to send kobai, or `undefined` for an unfiltered list. */
  readonly value: Value | undefined;
  /**
   * The word the address named that kobai does not have, or `null`.
   *
   * The word rather than a boolean, so a screen saying *kobai knows no status called “X”* has X
   * without a second narrowing — and so that the one thing it has to check to decide whether to
   * ask kobai anything at all is the same expression it renders from.
   */
  readonly unknownValue: string | null;
};
