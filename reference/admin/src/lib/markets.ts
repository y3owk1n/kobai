import type { Channel, Region } from "@kobai/client";
import { useQuery } from "@tanstack/react-query";
import { orThrow, problemOf } from "@/lib/refusal";
import { useKobaiClient } from "@/lib/session";

/**
 * The Regions and Channels a control may offer — read from kobai, in one place (#292).
 *
 * **A picker over a set kobai names is read from kobai, never written down here** (ADR-0063).
 * `lib/store.ts` states that rule for currencies and `lib/collections.ts` for Collections; this
 * is the same one for the two things a Price may be constrained to, and it matters more here
 * than anywhere: a Region and a Channel are rows a Merchant made on a screen next door, so
 * there is nothing whatever the Admin could have written down instead.
 *
 * **Two hooks in one module rather than two modules**, because a Price is constrained by the
 * pair: every control that offers one offers the other in the same fieldset, and splitting them
 * would put the shared decisions below in whichever file was opened first.
 */

/**
 * How many of each are offered, and the gap that comes with it.
 *
 * **Neither list pages**, which is `lib/collections.ts`'s known gap one noun along and taken for
 * its reason: a cursor inside the Prices card would sit in an address that already locates a
 * Product, and there is one of these cards per Variant. The Store screen's Default Region card
 * is the same argument on a different address (#311) — a cursor there would sit in one that
 * already locates the Store. A Store with more than a hundred Regions
 * would have some it cannot constrain a Price to from this screen — and a Store with more than a
 * hundred *geographies* has bigger questions than this control.
 */
export const OFFERED_MARKETS = 100;

/** Its own cache keys, deliberately not those of the screens that page these lists. */
const OFFERED_REGIONS = "offered-regions";
const OFFERED_CHANNELS = "offered-channels";

/** What a caller needs: the rows, and whether the read has really happened. */
export type OfferedMarkets<T> = {
  readonly offered: readonly T[];
  /**
   * Whether kobai has actually answered.
   *
   * The half that is easy to get wrong, and the reason it is here rather than left to
   * `isPending`: until this is `true` the list is empty for want of an answer rather than
   * because the Store has none, so a control that said *this Store has no Channels* before
   * kobai replied would be announcing the wrong thing for the length of a round trip and
   * permanently if the read failed.
   */
  readonly answered: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
};

export function useOfferedRegions(): OfferedMarkets<Region> {
  const client = useKobaiClient();

  const query = useQuery({
    queryKey: [OFFERED_REGIONS],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/regions", {
          params: { query: { limit: OFFERED_MARKETS } },
        }),
      ),
  });

  return {
    offered: query.data?.regions ?? [],
    answered: query.isSuccess,
    isPending: query.isPending,
    error: query.isError ? query.error : null,
  };
}

/**
 * Why the Regions could not be read, in words a Merchant can act on — or `null` (#311).
 *
 * `lib/store.ts`'s `whyCurrenciesNotRead` one noun along, and here for the same reason: the
 * Price editor's Region picker and the Store screen's Default Region card both have to tell a
 * read that failed apart from a Store that has defined none, and an empty list looks identical
 * either way. **Extract on the second**, and the Store screen is the second.
 */
export function whyRegionsNotRead(regions: OfferedMarkets<Region>): string | null {
  if (regions.error === null) return null;
  return problemOf(regions.error, "kobai did not say which Regions it has.");
}

export function useOfferedChannels(): OfferedMarkets<Channel> {
  const client = useKobaiClient();

  const query = useQuery({
    queryKey: [OFFERED_CHANNELS],
    queryFn: async () =>
      orThrow(
        await client.GET("/admin/channels", {
          params: { query: { limit: OFFERED_MARKETS } },
        }),
      ),
  });

  return {
    offered: query.data?.channels ?? [],
    answered: query.isSuccess,
    isPending: query.isPending,
    error: query.isError ? query.error : null,
  };
}

/**
 * Why the Channels could not be read, in words a Merchant can act on — or `null` (#311).
 *
 * {@link whyRegionsNotRead} one noun along, and the third of these written for the same reason:
 * the Price editor's Channel picker and the API keys screen's mint form both draw an empty list
 * for a Store with no Channels and for a read that never landed, and only one of those is
 * something a Merchant can act on.
 *
 * **The API keys screen is the case that shows why the sentence is not enough on its own.** Its
 * picker always carries `In no particular Channel`, which is a real answer and the one most keys
 * want — so a failed read there is not an empty picker at all, and the caller says the read
 * failed *and* that the ordinary key can still be minted. Naming the failure is this function's;
 * what is still possible in spite of it is the caller's.
 */
export function whyChannelsNotRead(channels: OfferedMarkets<Channel>): string | null {
  if (channels.error === null) return null;
  return problemOf(channels.error, "kobai did not say which Channels it has.");
}
