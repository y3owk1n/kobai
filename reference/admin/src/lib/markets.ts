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
 * How many are asked for at a time — kobai's own ceiling, so a Store with few of either is one
 * request (`MAX_PAGE_LIMIT`, promised under ADR-0064).
 *
 * A number above it is **refused** rather than reduced, so this is the largest page there is
 * and asking for more would be a 400 rather than a longer answer.
 */
const A_PAGE = 100;

/**
 * How many pages are followed, and it is a bound rather than a ceiling on the Store (#310).
 *
 * **These reads used to stop at the first page**, so a deployment past a hundred Regions had
 * some it could not constrain a Price to from any screen — silently, since a picker missing its
 * last rows looks exactly like a picker. They follow the cursor now, which is the only way
 * there is to reach the rest (ADR-0064 gives up the page number on purpose), and a filled
 * picker is what a Merchant gets.
 *
 * The loop is bounded for the reason every cursor walk in this repository is bounded: a cursor
 * that never advanced would spin here rather than fail, and a tab that never settles is a worse
 * failure than a short list. Two thousand of either is far past the point at which a picker is
 * the wrong control — **a Store with that many markets wants a screen with a search box, not a
 * longer listbox** — so reaching this bound is a finding about the control rather than a limit
 * to raise.
 *
 * **At the bound it truncates rather than failing, and that is the one uncomfortable choice
 * here.** It is the defect this ticket fixed, surviving one order of magnitude up: a picker
 * missing its oldest rows looks exactly like a picker. Throwing instead would say *something* —
 * the field would report a failed read and go dead — but it would take the Store screen's
 * Default Region card with it, so a Store past the bound could not set a default Region **at
 * all**, which is a capability lost to protect against a list being incomplete. A usable
 * picker missing its two-thousand-and-first row is the lesser failure, and the sentence above
 * is where the choice is recorded rather than left to be rediscovered.
 */
const OFFERED_PAGES = 20;

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
   *
   * **It is still one answer although the read may be several requests**, which is what makes
   * following the cursor invisible to every caller: a page that failed half way through throws,
   * so the query is a failure rather than a truncated list nobody was told about.
   */
  readonly answered: boolean;
  readonly isPending: boolean;
  readonly error: unknown;
};

/**
 * One page of a list, as this module reads one — the rows, and where the next page starts.
 *
 * A shape of its own so that {@link everyPage} can be written once for the two lists: what
 * differs between them is the path and what the envelope calls its rows, and neither is
 * something a loop over cursors should have to know.
 */
type PageOf<Row> = {
  readonly rows: readonly Row[];
  readonly nextCursor?: string;
};

/**
 * Every row of a list, followed page by page to the end (ADR-0064).
 *
 * **`nextCursor`'s absence is the only end-of-list signal there is**, and a short page is not
 * one — so this stops on the missing cursor rather than on a page smaller than it asked for.
 */
async function everyPage<Row>(
  read: (after: string | undefined) => Promise<PageOf<Row>>,
): Promise<Row[]> {
  const found: Row[] = [];
  let after: string | undefined;

  for (let page = 0; page < OFFERED_PAGES; page += 1) {
    const answered = await read(after);
    found.push(...answered.rows);
    if (answered.nextCursor === undefined) return found;
    after = answered.nextCursor;
  }

  return found;
}

export function useOfferedRegions(): OfferedMarkets<Region> {
  const client = useKobaiClient();

  const query = useQuery({
    queryKey: [OFFERED_REGIONS],
    queryFn: async () =>
      everyPage(async (after) => {
        const answered = orThrow(
          await client.GET("/admin/regions", {
            params: { query: { limit: A_PAGE, after } },
          }),
        );
        return { rows: answered.regions, nextCursor: answered.nextCursor };
      }),
  });

  return {
    offered: query.data ?? [],
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
      everyPage(async (after) => {
        const answered = orThrow(
          await client.GET("/admin/channels", {
            params: { query: { limit: A_PAGE, after } },
          }),
        );
        return { rows: answered.channels, nextCursor: answered.nextCursor };
      }),
  });

  return {
    offered: query.data ?? [],
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
