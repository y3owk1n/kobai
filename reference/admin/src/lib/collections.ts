import type { Collection } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
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
 */

/**
 * How many are offered, and the gap that comes with it.
 *
 * **It does not page.** A cursor inside a card would sit in an address that already locates a
 * Product, and a second one above the Products table would fight with the one that list already
 * puts there — the gap `components/media-attachments.tsx` takes for the same reason. So a Store
 * with more than a hundred Collections has some it cannot reach from either control: that is a
 * **known gap** rather than something this hides, and the way to those is the Collections
 * section, which pages properly.
 */
export const OFFERED_COLLECTIONS = 100;

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
      orThrow(
        await client.GET("/admin/collections", {
          params: { query: { limit: OFFERED_COLLECTIONS } },
        }),
      ),
  });

  return {
    collections: query.data?.collections ?? [],
    read: query.isSuccess,
    pending: query.isPending,
    error: query.isError ? query.error : null,
  };
}
