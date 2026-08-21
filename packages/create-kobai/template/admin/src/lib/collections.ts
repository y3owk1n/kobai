import type { Collection } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import { A_PAGE, everyPage } from "@/lib/pages";
import { orThrow } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Collections a control may offer — read from kobai, in one place (#256).
 *
 * **A module on the second use rather than the third**, which is `components/listbox-field.tsx`'s
 * lesson and `components/list-filter.tsx`'s: the Products list's filter and the Product screen's
 * Collections card ask kobai the same question in the same words, and a hand-copied second
 * answer is one that gets fixed once per copy with nothing going red for the one that was
 * missed. It is a hook rather than a component because what the two do with the answer is
 * genuinely different — one draws a nav of links and the other a set of checkboxes.
 *
 * **A picker over a set kobai names is read from kobai, never written down here** (ADR-0063).
 * That is the same rule the Fulfilment Strategy field follows: the Admin may hold what kobai's
 * *types* close — the three Product statuses — and must ask about what a deployment decides. A
 * Collection is a row a Merchant made.
 *
 * **It follows kobai's cursor to the end, through `lib/pages.ts`** (#327). It used to ask for a
 * hundred and stop, which was written down as a known gap on the grounds that *a cursor inside a
 * card would sit in an address that already locates a Product* — true of a pager, and no
 * objection whatever to the read: following the cursor here puts nothing in an address and draws
 * no Next button, and a caller still gets one list and one pending state. What the gap actually
 * cost is what makes it worth naming: past a hundred Collections a Product could not be put into
 * one that exists, and the Products list answered `?collection=` with **No such Collection** —
 * a screen telling a Merchant that a Collection they are looking at does not exist.
 */

/**
 * Its own cache key, deliberately not the Collections screen's.
 *
 * That screen asks a different question — a page at a time, with a cursor in the address — so
 * sharing a key would have the two invalidate each other's answer and each re-read the other's.
 */
const OFFERED = "offered-collections";

/** What a caller needs: the Collections, and whether the read has really happened. */
export type OfferedCollections = {
  readonly collections: readonly Collection[];
  /**
   * Whether kobai has actually answered.
   *
   * The half that is easy to get wrong, and both callers need it: until this is `true` the list
   * is empty for want of an answer rather than because the Store has none — so a control that
   * judged an address against it would call every perfectly good Collection unknown for the
   * length of a round trip, and permanently if the read failed.
   *
   * **It is still one answer although the read may be several requests**, which is what makes
   * following the cursor invisible to every caller: a page that failed half way through throws,
   * so the query is a failure rather than a truncated list nobody was told about.
   */
  readonly read: boolean;
  readonly pending: boolean;
  readonly error: unknown;
};

export function useOfferedCollections(): OfferedCollections {
  const client = useKobaiClient();

  const query = useQuery({
    queryKey: [OFFERED],
    queryFn: async () =>
      everyPage(async (after) => {
        const answered = orThrow(
          await client.GET("/admin/collections", {
            params: { query: { limit: A_PAGE, after } },
          }),
        );
        return { rows: answered.collections, nextCursor: answered.nextCursor };
      }),
  });

  return {
    collections: query.data ?? [],
    read: query.isSuccess,
    pending: query.isPending,
    error: query.isError ? query.error : null,
  };
}
