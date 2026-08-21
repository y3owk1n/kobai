/**
 * Reading a whole list off a route that answers a page of it (ADR-0064), in one place.
 *
 * kobai's list routes are cursor-paged and report no total: `nextCursor`'s absence is the only
 * end-of-list signal there is, and a short page is not one. So a control that offers a **set** —
 * a picker, a set of checkboxes, a nav of filters — cannot ask once and present the answer as
 * the whole of it. One request answers a *prefix*, and a prefix is indistinguishable from the
 * complete list on screen, which is why this defect survived every ticket that touched the
 * controls it was in.
 *
 * **One definition rather than three held in agreement.** #310 wrote this walk in
 * `lib/markets.ts`; #327 wanted the same walk in `lib/collections.ts` and in
 * `components/media-attachments.tsx`, which is the second and third caller and so is where this
 * repository extracts (`components/listbox-field.tsx`'s lesson: the third copy is what gets to
 * reintroduce every defect the first two fixed by hand). It matters more here than for an
 * ordinary helper because of what {@link OFFERED_PAGES} encodes — a trade-off somebody will
 * revisit, and three loops is three places to revisit it in, two of which would be missed.
 *
 * **The four call sites are not folded into it, and that is a rule rather than a shortfall.**
 * An `everyPageOf(client, "/admin/collections", …)` is the obvious next extraction and it
 * reddens the build: `tests/admin-uses-only-the-public-api.test.ts` asks of every call this
 * Admin makes on the client whether the first thing after the opening bracket is a quotation
 * mark, and a path handed to a helper is *a path it composed* — the exemption is one file, and
 * it is the Playground's.
 * `openapi-fetch` types each call against that literal too, so the generic form would need the
 * cast that scan confines to that same file. What is shared is therefore the walk and the bound;
 * what each caller keeps is its own literal path, the name its envelope gives its rows, and the
 * page size it asks for.
 *
 * **This is the read and never the control.** Following the cursor here puts no cursor in an
 * address and draws no Next button: a caller gets one list and one pending state, however many
 * requests that took. `components/pager.tsx` is the other thing — a *list screen* paging under a
 * Merchant's own hand, with the cursor in the URL — and the two are not alternatives. Confusing
 * them is what kept `lib/collections.ts` on one page for two tickets: "a second cursor in an
 * address that already locates a Product" is a true objection to a pager inside a card and no
 * objection at all to this.
 */

/**
 * How many are asked for at a time — kobai's own ceiling, so a Store with few of anything is
 * one request (`MAX_PAGE_LIMIT`, promised under ADR-0064).
 *
 * A number above it is **refused** rather than reduced, so this is the largest page there is
 * and asking for more would be a 400 rather than a longer answer.
 *
 * It is exported and sent by each caller rather than applied inside {@link everyPage}, because
 * the caller is what builds the request — see the module note above on why it has to be. So how
 * many rows a read can reach is {@link OFFERED_PAGES} times *this*, and a caller that asked for
 * a smaller page would quietly lower it.
 */
export const A_PAGE = 100;

/**
 * How many pages are followed, and it is a bound rather than a ceiling on the Store (#310, #327).
 *
 * **These reads used to stop at the first page.** A deployment past a hundred Regions had some
 * it could not constrain a Price to and could not make its default; past a hundred Collections,
 * a Product could not be put into one that exists and the Products list could not be narrowed to
 * it; past a hundred images, one that exists could not be attached to a Product or a Variant.
 * Every one of those was silent, because a picker missing its oldest rows looks exactly like a
 * picker. They follow the cursor now, which is the only way there is to reach the rest —
 * ADR-0064 gives up the page number on purpose — and a filled control is what a Merchant gets.
 *
 * The loop is bounded for the reason every cursor walk in this repository is bounded: a cursor
 * that never advanced would spin here rather than fail, and a tab that never settles is a worse
 * failure than a short list. Two thousand of anything is far past the point at which a picker is
 * the wrong control — **a Store with that many Regions, Collections or images wants a screen
 * with a search box, not a longer listbox** — so reaching this bound is a finding about the
 * control rather than a limit to raise.
 *
 * **At the bound it truncates rather than failing, and that is the one uncomfortable choice
 * here.** It is the defect above surviving one order of magnitude up: a control missing its
 * oldest rows looks exactly like a control. Throwing instead would say *something* — the field
 * would report a failed read and go dead — but it would take the whole surface with it, so a
 * Store past the bound could not set a default Region, put a Product into any Collection, or
 * attach any image **at all**, which is a capability lost to protect against a list being
 * incomplete. A usable control missing its two-thousand-and-first row is the lesser failure, and
 * this sentence is where the choice is recorded rather than left to be rediscovered.
 */
const OFFERED_PAGES = 20;

/**
 * One page of a list, as this module reads one — the rows, and where the next page starts.
 *
 * A shape of its own so that {@link everyPage} can be written once for every list: what differs
 * between them is the path and what the envelope calls its rows, and neither is something a loop
 * over cursors should have to know.
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
 *
 * **A page that failed half way through throws**, which is what keeps every caller's `error`
 * meaning what it meant when the read was one request: a truncated list nobody was told about is
 * the failure this whole module exists to remove, and answering one on the way to fixing it
 * would be the same defect wearing a fix's name.
 */
export async function everyPage<Row>(
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
